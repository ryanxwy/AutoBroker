#!/usr/bin/env node
/**
 * desktop-refresh.mjs — the single orchestrator every desktop-freshness path
 * funnels through. Idempotent, stamp-guarded, single-flight locked.
 *
 * Two phases:
 *   PHASE-BUILD   — build a COMPLETE .app inside an isolated git build worktree
 *                   (never the dev tree), so a background rebuild can never
 *                   pollute the dev checkout's `git status` / `.tsbuildinfo`.
 *   PHASE-INSTALL — atomically swap the freshly-built .app into the apps dir
 *                   (replace-not-merge: ditto → stage → rename) and write an
 *                   out-of-bundle DATA-ONLY marker LAST — but only when no live
 *                   instance is running.
 *
 * Why the marker lives OUTSIDE the .app: a shipped dmg or a hand-copied dev
 * .app physically cannot carry a freshness marker, so the launch check stays
 * inert for anything but a locally-built install. The marker is keyed by a
 * sha256 of the install path and holds DATA ONLY — no interpreter or script
 * paths — so a user-writable file can never redirect which binary runs.
 *
 * Safety direction: a FALSE-NEGATIVE (run stale code) is catastrophic; a
 * FALSE-POSITIVE (needless rebuild) costs seconds. Every ambiguity therefore
 * resolves toward "rebuild". The install side is the opposite: it never tears a
 * running app and never leaves a fresh marker on torn bytes (marker is written
 * last, after a completeness verify of the installed bundle).
 *
 * Interpreters resolve by FIXED RULES, never from the marker: git from a
 * hardcoded system allowlist, node = this process's own runtime, relaunch is
 * always `open <absolute appPath>`. macOS-only, single-machine, dev-solo.
 *
 * Structured as importable functions + a CLI entry that runs only when invoked
 * as main, so the install/lock/guard/marker logic is unit-testable against a
 * throwaway data dir + apps dir (AUTOBROKER_DESKTOP_APPS_DIR override).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The checkout this script lives in (scripts/ → up one). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Hardcoded git allowlist — never read from $PATH or any user-writable file. */
const GIT_ALLOWLIST = ["/opt/homebrew/bin/git", "/usr/bin/git"];

/** Absolute paths to the macOS system utilities the install path uses. */
const DITTO = "/usr/bin/ditto";
const XATTR = "/usr/bin/xattr";
const PGREP = "/usr/bin/pgrep";
const PS = "/bin/ps";
const OPEN = "/usr/bin/open";

/** A lock older than this (by dir mtime) is considered abandoned and reclaimed. */
const LOCK_MAX_AGE_MS = 15 * 60 * 1000;

/** Acquire-or-wait watchdog: after this long a held lock is force-reclaimed so a
 *  relaunch after app.quit() can never strand the user with nothing running. */
const LOCK_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

/** Roll the log when it grows past this. */
const LOG_MAX_BYTES = 1024 * 1024;

/** Workspace roots that affect the desktop runtime — mirrors the freshness
 *  module's set. Used to overlay UNCOMMITTED edits into the build worktree so a
 *  not-yet-committed change is captured in the rebuilt bundle. */
const BUILD_OVERLAY_ROOTS = [
  "apps/server",
  "apps/ui",
  "apps/desktop",
  "packages/core",
  "packages/model",
  "packages/workflows",
  "packages/tools",
  "packages/db",
  "packages/skills",
  "pnpm-lock.yaml",
  "package.json",
  "tsconfig.base.json",
  "tsconfig.json",
];

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

/** sha256 hex of a string. */
export function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** Expand a leading "~" — Node does not expand it. */
function expandTilde(p) {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/** A per-process-unique token (Date.now may be coarse / unavailable in some
 *  runtimes; hrtime+pid is always monotonic-enough and unique per call). */
function nonce() {
  return process.hrtime.bigint().toString(36) + "-" + process.pid.toString(36);
}

/** Synchronous sleep (used only on the wait paths, never in the unit suite). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** realpath that falls back to the input on error (a not-yet-existing path). */
function realpathSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** First executable git from the hardcoded allowlist, or throw. */
export function resolveGit() {
  for (const c of GIT_ALLOWLIST) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      /* not executable / absent — next */
    }
  }
  throw new Error(`no executable git on allowlist: ${GIT_ALLOWLIST.join(", ")}`);
}

/** Like resolveGit but returns null instead of throwing (for fail-soft guards). */
function safeResolveGit() {
  try {
    return resolveGit();
  } catch {
    return null;
  }
}

/** Run git and return trimmed stdout; throws on any non-zero exit. */
function gitCapture(git, args, cwd) {
  return execFileSync(git, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

/** Run a build/interpreter command, streaming its output; throws on failure. */
function runCmd(file, args, { cwd, env, log } = {}) {
  log?.(`$ ${file} ${args.join(" ")}`);
  execFileSync(file, args, { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
}

/** Append a timestamped line to the rolling log (best-effort, never throws). */
export function appendLog(logPath, msg) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    try {
      if (statSync(logPath).size > LOG_MAX_BYTES) writeFileSync(logPath, "");
    } catch {
      /* no existing log yet */
    }
    appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* logging is best-effort */
  }
}

// ---------------------------------------------------------------------------
// Path resolution (everything under the data dir so tests can isolate it)
// ---------------------------------------------------------------------------

/**
 * Resolve every path the orchestrator uses from the environment. The apps dir
 * defaults to /Applications but honors AUTOBROKER_DESKTOP_APPS_DIR so tests can
 * install into a throwaway dir.
 */
export function resolvePaths(env = process.env) {
  const dataDir = expandTilde(env.AUTOBROKER_DATA_DIR || join(homedir(), ".autobroker-ts"));
  const appsDir = env.AUTOBROKER_DESKTOP_APPS_DIR || "/Applications";
  const appPath = join(appsDir, "AutoBroker.app");
  const refreshDir = join(dataDir, "desktop-refresh");
  const buildWt = join(dataDir, "desktop-build", "wt");
  const appHash = sha256(appPath);
  return {
    dataDir,
    appsDir,
    appPath,
    refreshDir,
    buildWt,
    markerPath: join(refreshDir, appHash + ".json"),
    stagedPath: join(refreshDir, "staged-" + appHash + ".json"),
    lockDir: join(refreshDir, "refresh.lock"),
    logPath: join(refreshDir, "desktop-refresh.log"),
    primaryJsonPath: join(refreshDir, "primary.json"),
    pendingPath: join(refreshDir, "pending"),
    lastLockHashPath: join(refreshDir, "build-lock-hash"),
  };
}

// ---------------------------------------------------------------------------
// Marker (DATA ONLY: schemaVersion, repoPath, primaryRepoPath, builtStamp,
// frameworkStamp, builtAtIso — no interpreter or script paths)
// ---------------------------------------------------------------------------

/** Atomic write: tmp file in the same dir + rename (same volume → atomic). */
export function writeMarkerAtomic(markerPath, marker) {
  mkdirSync(dirname(markerPath), { recursive: true });
  const tmp = `${markerPath}.tmp.${process.pid}.${nonce()}`;
  writeFileSync(tmp, JSON.stringify(marker, null, 2) + "\n");
  renameSync(tmp, markerPath);
}

/** Parse a marker; any error (missing, truncated, garbage, wrong shape) → null.
 *  Fail-soft: a corrupt marker must read as "no marker", never throw. */
export function readMarker(markerPath) {
  try {
    const data = JSON.parse(readFileSync(markerPath, "utf8"));
    if (!data || typeof data !== "object") return null;
    if (typeof data.schemaVersion !== "number") return null;
    return data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Single-flight lock — atomic mkdir, PID-reuse-safe
// ---------------------------------------------------------------------------

/** True if a process with `pid` currently exists (EPERM = exists, not ours). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** The OS start time of `pid` as a stable string, via `ps -o lstart=`. Empty on
 *  failure — callers skip the PID-reuse check when either side is empty rather
 *  than falsely reclaiming. lstart is constant for a process's lifetime, so two
 *  reads of the same live pid always match; a reused pid yields a newer time. */
function processStartTime(pid) {
  try {
    return execFileSync(PS, ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/**
 * A held lock is stale (reclaimable) when ANY of:
 *   - the holder pid is dead (process.kill(pid,0) → ESRCH),
 *   - the live pid's start time differs from the recorded one (PID reuse),
 *   - the lock dir mtime is older than 15 min (abandoned).
 * A lock dir with a missing/corrupt info.json can identify no holder, so it
 * falls back to the mtime rule alone (never reclaimed while fresh — avoids
 * racing a process that just mkdir'd but has not yet written info.json).
 */
export function isLockStale(lockDir, opts = {}) {
  const now = opts.now ?? Date.now();
  const startTimeFor = opts.startTimeFor ?? processStartTime;
  const ageOk = () => {
    try {
      return now - statSync(lockDir).mtimeMs > LOCK_MAX_AGE_MS;
    } catch {
      return true; // dir vanished/unreadable → treat as stale
    }
  };

  let info;
  try {
    info = JSON.parse(readFileSync(join(lockDir, "info.json"), "utf8"));
  } catch {
    return ageOk();
  }
  const pid = Number(info.pid);
  if (!Number.isInteger(pid) || pid <= 0) return ageOk();
  if (!pidAlive(pid)) return true;
  const recorded = String(info.startTime ?? "");
  const current = startTimeFor(pid);
  if (recorded && current && recorded !== current) return true;
  return ageOk();
}

/**
 * Acquire the lock by atomically creating its directory. On EEXIST, reclaim a
 * stale lock once (rmdir + retry); a genuinely-held lock returns false. On
 * success writes {pid, startTime} so other processes can liveness-check us.
 */
export function acquireLock(lockDir, opts = {}) {
  const pid = opts.pid ?? process.pid;
  const startTime = opts.startTime ?? (opts.startTimeFor ?? processStartTime)(pid);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockDir, { recursive: false });
    } catch (err) {
      if (err.code === "ENOENT") {
        // Parent (refreshDir) does not exist yet — create it and retry.
        mkdirSync(dirname(lockDir), { recursive: true });
        attempt--;
        continue;
      }
      if (err.code !== "EEXIST") throw err;
      if (attempt === 0 && isLockStale(lockDir, opts)) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          /* lost the reclaim race — the next mkdir will EEXIST again */
        }
        continue;
      }
      return false;
    }
    try {
      writeFileSync(join(lockDir, "info.json"), JSON.stringify({ pid, startTime }));
    } catch {
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      return false;
    }
    return true;
  }
  return false;
}

/** Release the lock — only if WE hold it (info.json pid matches), so a process
 *  never tears down a lock it reclaimed away from itself. */
export function releaseLock(lockDir, opts = {}) {
  const pid = opts.pid ?? process.pid;
  try {
    const info = JSON.parse(readFileSync(join(lockDir, "info.json"), "utf8"));
    if (Number(info.pid) !== pid) return; // not ours
  } catch {
    /* no/corrupt info — fall through and remove (best-effort cleanup) */
  }
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/** Acquire-or-wait: poll until the lock is free (or stale), force-reclaiming
 *  after the watchdog timeout. Used by relaunch-critical modes that must never
 *  bail on a held lock. */
function acquireOrWaitLock(lockDir, log) {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  for (;;) {
    if (acquireLock(lockDir)) return true;
    if (Date.now() >= deadline) {
      log?.("lock wait watchdog expired — force-reclaiming");
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      return acquireLock(lockDir);
    }
    sleepSync(500);
  }
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** True if a git rebase/merge/cherry-pick is mid-flight in `repoRoot`. */
function gitOperationInProgress(repoRoot, git) {
  if (!git) return false;
  let gitDir;
  try {
    gitDir = gitCapture(git, ["-C", repoRoot, "rev-parse", "--git-dir"], repoRoot);
  } catch {
    return false; // a git failure is handled by the stamp side (→ rebuild)
  }
  if (!gitDir.startsWith("/")) gitDir = join(repoRoot, gitDir);
  for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
    if (existsSync(join(gitDir, marker))) return true;
  }
  return false;
}

/**
 * Primary-checkout binding — the gate that kills the worktree-hook storm. Only
 * the ONE primary checkout warms /Applications; linked worktrees stay inert.
 *
 *   - primary.json absent  → only the MANUAL modes proceed (allowNoPrimary);
 *     the hook path returns false (binding not yet established).
 *   - primary.json present → require repoRoot's toplevel === primaryRepoPath
 *     AND repoRoot is NOT a linked worktree (git-dir === git-common-dir).
 *
 * Any inability to verify resolves to false (do not warm /Applications from an
 * unverifiable checkout).
 */
export function passesPrimaryBinding(opts = {}) {
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const primaryJsonPath = opts.primaryJsonPath ?? resolvePaths().primaryJsonPath;
  const git = opts.git ?? safeResolveGit();

  let primary;
  try {
    primary = JSON.parse(readFileSync(primaryJsonPath, "utf8"));
  } catch {
    return opts.allowNoPrimary === true;
  }
  const primaryRepoPath = String(primary?.primaryRepoPath ?? "");
  if (!primaryRepoPath) return opts.allowNoPrimary === true;
  if (!git) return false;

  try {
    const toplevel = realpathSafe(gitCapture(git, ["-C", repoRoot, "rev-parse", "--show-toplevel"], repoRoot));
    if (toplevel !== realpathSafe(primaryRepoPath)) return false;

    const gitDirRel = gitCapture(git, ["-C", repoRoot, "rev-parse", "--git-dir"], repoRoot);
    const commonRel = gitCapture(git, ["-C", repoRoot, "rev-parse", "--git-common-dir"], repoRoot);
    const gitDir = realpathSafe(gitDirRel.startsWith("/") ? gitDirRel : join(repoRoot, gitDirRel));
    const commonDir = realpathSafe(commonRel.startsWith("/") ? commonRel : join(repoRoot, commonRel));
    if (gitDir !== commonDir) return false; // linked worktree
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a reason string when the refresh must be skipped (early exit 0), or
 * null to proceed. Env checks come first so the cheap kill switches never need
 * git or a repo.
 */
export function shouldSkipForGuards(opts = {}) {
  const env = opts.env ?? process.env;
  if (env.CI === "true") return "ci";
  if (env.AUTOBROKER_DESKTOP_REFRESH === "0") return "kill-switch (AUTOBROKER_DESKTOP_REFRESH=0)";

  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const git = opts.git ?? safeResolveGit();
  if (gitOperationInProgress(repoRoot, git)) return "git-operation-in-progress";
  if (
    !passesPrimaryBinding({
      repoRoot,
      primaryJsonPath: opts.primaryJsonPath,
      allowNoPrimary: opts.allowNoPrimary,
      git,
    })
  ) {
    return "primary-binding (not the bound primary checkout)";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Live-instance detection
// ---------------------------------------------------------------------------

/**
 * PIDs of running processes whose argv contains the installed app's launcher
 * binary (`<appPath>/Contents/MacOS/AutoBroker`), minus our own pid and an
 * explicitly-passed quitting pid. Empty when none are running. pgrep exits 1
 * with no output on no match — treated as "none".
 */
export function liveInstancePids(appPath, opts = {}) {
  const target = join(appPath, "Contents", "MacOS", "AutoBroker");
  let out = "";
  try {
    out = execFileSync(PGREP, ["-f", target], { encoding: "utf8" });
  } catch (err) {
    if (err.status === 1) return []; // pgrep: no match
    return []; // pgrep unavailable → nothing detectable
  }
  const self = process.pid;
  const quitting = opts.quittingPid;
  return out
    .split("\n")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== self && n !== quitting);
}

/** Poll until `pid` has fully exited (ESRCH) or the timeout elapses. */
function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid) && Date.now() < deadline) sleepSync(250);
}

// ---------------------------------------------------------------------------
// Bundle completeness verify
// ---------------------------------------------------------------------------

/**
 * Assert the three load-bearing entries of a built .app exist (and the launcher
 * is executable). Throws on the first missing piece — callers use this BEFORE
 * the swap (never install a known-incomplete bundle) and AFTER (catch a torn
 * install) and must NOT write the marker on a throw.
 */
export function verifyInstalledApp(appRoot) {
  const bin = join(appRoot, "Contents", "MacOS", "AutoBroker");
  const asar = join(appRoot, "Contents", "Resources", "app.asar");
  const server = join(appRoot, "Contents", "Resources", "bundle", "server.cjs");
  for (const p of [bin, asar, server]) {
    if (!existsSync(p)) throw new Error(`incomplete bundle: missing ${p}`);
  }
  const mode = statSync(bin).mode;
  if (!(mode & 0o111)) throw new Error(`incomplete bundle: ${bin} is not executable`);
  return true;
}

// ---------------------------------------------------------------------------
// PHASE-INSTALL (unit-testable)
// ---------------------------------------------------------------------------

/** Env for the env-clean relaunch: strip the test/build vars so the launched
 *  app never inherits a forced mode or an isolated data dir. */
function launchEnv() {
  const env = { ...process.env };
  for (const k of [
    "AUTOBROKER_MODE",
    "AUTOBROKER_HARNESS",
    "AUTOBROKER_HARNESS_FIXTURE",
    "AUTOBROKER_TEST_AUTO_APPROVE",
    "AUTOBROKER_DATA_DIR",
    "NODE_ENV",
  ]) {
    delete env[k];
  }
  return env;
}

/**
 * Env-clean relaunch of the installed app by ABSOLUTE path: `open <appPath>`
 * only (never `open -a`, never spawning the binary with an inherited env).
 * Verifies a fresh instance actually appears and retries the open once if it
 * does not. The opener is injectable so the relaunch seam is assertable in unit
 * tests without spawning the real macOS `open`. Returns true if an instance was
 * observed, false otherwise (best-effort — a relaunch failure is logged, never
 * thrown).
 */
function relaunchApp(appPath, opts = {}) {
  const log = opts.log ?? (() => {});
  const liveFn = opts.liveInstancePids ?? liveInstancePids;
  const opener = opts.open ?? ((p) => execFileSync(OPEN, [p], { env: launchEnv() }));
  const appeared = () => liveFn(appPath, { quittingPid: opts.quittingPid }).length > 0;
  try {
    opener(appPath);
    let ok = false;
    for (let i = 0; i < 20 && !ok; i++) {
      if (appeared()) ok = true;
      else sleepSync(250);
    }
    if (!ok) {
      log("relaunch: new instance did not appear — retrying open once");
      opener(appPath);
      ok = appeared();
    }
    return ok;
  } catch (err) {
    log(`relaunch: open failed: ${String(err)}`);
    return false;
  }
}

/**
 * Install a staged .app into the apps dir and write the marker LAST.
 *
 * opts:
 *   paths              — resolvePaths() output (appsDir/appPath/markerPath/…)
 *   builtStamp,        — recorded in the marker (the stamp of what was built)
 *   frameworkStamp,
 *   repoPath,          — recorded in the marker (DATA ONLY)
 *   primaryRepoPath,
 *   builtAtIso         — defaults to now
 *   quittingPid        — an instance we are deliberately replacing; waited out
 *   doOpen             — relaunch `open <appPath>` after install
 *   open               — injectable opener (tests assert the relaunch seam)
 *   liveInstancePids   — override for tests
 *   log
 *
 * Returns {installed:true} or {installed:false, reason}. On a live instance it
 * does NOT swap and leaves the staged signal in place.
 */
export function phaseInstall(stagedAppPath, opts = {}) {
  const paths = opts.paths ?? resolvePaths();
  const log = opts.log ?? (() => {});
  const liveFn = opts.liveInstancePids ?? liveInstancePids;

  const live = liveFn(paths.appPath, { quittingPid: opts.quittingPid });
  if (live.length > 0) {
    log(`phaseInstall: live instance(s) ${live.join(",")} — deferring swap`);
    return { installed: false, reason: "live-instance" };
  }
  if (opts.quittingPid) waitForPidExit(opts.quittingPid, 30_000);

  mkdirSync(paths.appsDir, { recursive: true });
  mkdirSync(paths.refreshDir, { recursive: true });

  const tag = `${process.pid}.${nonce()}`;
  const stage = join(paths.appsDir, `.AutoBroker.app.new.${tag}`);
  const old = join(paths.appsDir, `.AutoBroker.app.old.${tag}`);

  try {
    // ditto (NOT cp -R) preserves inner ad-hoc signatures + symlinks.
    rmSync(stage, { recursive: true, force: true });
    execFileSync(DITTO, [stagedAppPath, stage]);

    // Never swap in a bundle we already know is incomplete.
    verifyInstalledApp(stage);

    // Atomic swap on the SAME volume as appsDir.
    if (existsSync(paths.appPath)) renameSync(paths.appPath, old);
    try {
      renameSync(stage, paths.appPath);
    } catch (err) {
      // Restore the previous install if the in-rename failed.
      if (existsSync(old) && !existsSync(paths.appPath)) renameSync(old, paths.appPath);
      throw err;
    }
    rmSync(old, { recursive: true, force: true });

    // Best-effort: drop the quarantine flag so the relaunch is not blocked.
    try {
      execFileSync(XATTR, ["-dr", "com.apple.quarantine", paths.appPath]);
    } catch {
      /* ignore — quarantine may simply be absent */
    }

    // Completeness verify of the INSTALLED bytes BEFORE the marker. A torn
    // install throws here and leaves the OLD marker untouched → next run sees a
    // stamp mismatch and rebuilds (self-consistent: never a fresh marker on
    // incomplete bytes).
    verifyInstalledApp(paths.appPath);

    const marker = {
      schemaVersion: 1,
      repoPath: opts.repoPath ?? REPO_ROOT,
      primaryRepoPath: opts.primaryRepoPath ?? opts.repoPath ?? REPO_ROOT,
      builtStamp: opts.builtStamp ?? null,
      frameworkStamp: opts.frameworkStamp ?? null,
      builtAtIso: opts.builtAtIso ?? new Date().toISOString(),
    };
    writeMarkerAtomic(paths.markerPath, marker);

    // The staged signal has been consumed.
    try {
      rmSync(paths.stagedPath, { force: true });
    } catch {
      /* best-effort */
    }
    log(`phaseInstall: installed ${paths.appPath} (builtStamp ${String(marker.builtStamp).slice(0, 12)})`);
  } finally {
    // Never leak a half-copied staging dir.
    rmSync(stage, { recursive: true, force: true });
  }

  if (opts.doOpen) {
    relaunchApp(paths.appPath, {
      liveInstancePids: liveFn,
      quittingPid: opts.quittingPid,
      open: opts.open,
      log,
    });
  }

  return { installed: true };
}

// ---------------------------------------------------------------------------
// Stamp (thin wrapper over the compiled freshness module)
// ---------------------------------------------------------------------------

/** Sanitized build env (constraint: never let a build inherit test-mode vars). */
function sanitizedBuildEnv() {
  const env = { ...process.env };
  for (const k of [
    "AUTOBROKER_MODE",
    "AUTOBROKER_HARNESS",
    "AUTOBROKER_HARNESS_FIXTURE",
    "AUTOBROKER_TEST_AUTO_APPROVE",
    "AUTOBROKER_DATA_DIR",
    "CI",
  ]) {
    delete env[k];
  }
  env.NODE_ENV = "production";
  return env;
}

/**
 * Compute the live built stamp for `repoRoot`. Builds dist/freshness.js first
 * (unless skipBuild), then imports the COMPILED module cache-busted so a rebuilt
 * dist is always re-read. A throw (ForceRebuild / GitUnavailable) is the
 * caller's signal to treat the tree as STALE and rebuild.
 */
export async function computeLiveStamp(repoRoot = REPO_ROOT, opts = {}) {
  if (!opts.skipBuild) {
    runCmd("pnpm", ["--filter", "@autobroker/desktop", "run", "build"], {
      cwd: repoRoot,
      env: sanitizedBuildEnv(),
      log: opts.log,
    });
  }
  const distFreshness = join(repoRoot, "apps", "desktop", "dist", "freshness.js");
  if (!existsSync(distFreshness)) {
    throw new Error(`dist/freshness.js missing after build: ${distFreshness}`);
  }
  const mod = await import(pathToFileURL(distFreshness).href + "?v=" + nonce());
  return mod.computeBuiltStamp(repoRoot, { git: resolveGit() });
}

// ---------------------------------------------------------------------------
// PHASE-BUILD (side-effecting; exercised by the real acceptance run, not units)
// ---------------------------------------------------------------------------

/**
 * Build a complete .app in the isolated build worktree and write the staged
 * signal `{ stagedAppPath, builtStamp, frameworkStamp, builtAtIso }`.
 *
 * Building in a detached worktree (never the dev tree) is what keeps the dev
 * checkout's `git status` / `.tsbuildinfo` pristine across a background refresh.
 *
 * HOT vs COLD simplification (v1): always run `electron-builder --dir` — it is
 * the step that actually produces the installable .app. The framework-stamp
 * (HOT vs COLD) distinction is reserved for the LAUNCH path (whether main.ts can
 * swap in place vs must relaunch); a future optimization can surgically refresh
 * only Contents/Resources/bundle on a HOT change.
 */
export function phaseBuild(opts = {}) {
  const paths = opts.paths ?? resolvePaths();
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const git = opts.git ?? resolveGit();
  const log = opts.log ?? (() => {});
  const env = sanitizedBuildEnv();
  const wt = paths.buildWt;

  const head = gitCapture(git, ["-C", repoRoot, "rev-parse", "HEAD"], repoRoot);

  // 1. Ensure the build worktree exists and points at the primary's HEAD.
  if (!existsSync(join(wt, ".git"))) {
    mkdirSync(dirname(wt), { recursive: true });
    rmSync(wt, { recursive: true, force: true });
    runCmd(git, ["-C", repoRoot, "worktree", "add", "--detach", wt, head], { cwd: repoRoot, env, log });
  } else {
    runCmd(git, ["-C", wt, "reset", "--hard", head], { cwd: wt, env, log });
    runCmd(git, ["-C", wt, "clean", "-fd"], { cwd: wt, env, log });
  }

  // 2. Overlay UNCOMMITTED working-tree edits (modified + untracked) so a
  //    not-yet-committed change is captured. A missed deletion only over-builds
  //    (acceptable per the false-positive bias).
  const overlay = gitCapture(
    git,
    ["-C", repoRoot, "ls-files", "-m", "-o", "--exclude-standard", "--", ...BUILD_OVERLAY_ROOTS],
    repoRoot,
  )
    .split("\n")
    .filter(Boolean);
  for (const rel of overlay) {
    const src = join(repoRoot, rel);
    const dst = join(wt, rel);
    if (existsSync(src)) {
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst, { recursive: true });
    } else {
      rmSync(dst, { force: true }); // best-effort deletion mirror
    }
  }

  // 3. Install deps in the worktree only when the lockfile changed (or deps are
  //    absent — a fresh worktree has no node_modules).
  const lockHash = sha256(readFileSync(join(wt, "pnpm-lock.yaml"), "utf8"));
  let lastLockHash = "";
  try {
    lastLockHash = readFileSync(paths.lastLockHashPath, "utf8").trim();
  } catch {
    /* none yet */
  }
  if (!existsSync(join(wt, "node_modules")) || lockHash !== lastLockHash) {
    runCmd("pnpm", ["install", "--frozen-lockfile"], { cwd: wt, env, log });
    mkdirSync(dirname(paths.lastLockHashPath), { recursive: true });
    writeFileSync(paths.lastLockHashPath, lockHash + "\n");
  }

  // 4. Sanitized build → packed .app.
  runCmd("pnpm", ["-w", "exec", "tsc", "-b"], { cwd: wt, env, log });
  runCmd("pnpm", ["--filter", "@autobroker/ui", "run", "build"], { cwd: wt, env, log });
  runCmd("node", ["apps/desktop/scripts/bundle.mjs"], { cwd: wt, env, log });
  runCmd("pnpm", ["--filter", "@autobroker/desktop", "exec", "electron-builder", "--dir"], {
    cwd: wt,
    env,
    log,
  });

  // 5. Locate the single packed .app and stamp what was built (computed on the
  //    worktree after its tsc -b, so dist/freshness.js there is current).
  const releaseDir = join(wt, "apps", "desktop", "release");
  const candidates = existsSync(releaseDir)
    ? readdirRecursiveApps(releaseDir)
    : [];
  if (candidates.length !== 1) {
    throw new Error(`expected exactly one packed AutoBroker.app, found ${candidates.length}: ${candidates.join(", ")}`);
  }
  const stagedAppPath = candidates[0];

  return { stagedAppPath, lockHash };
}

/** Find each release "mac-arch" dir's AutoBroker.app (e.g. release/mac-arm64). */
function readdirRecursiveApps(releaseDir) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(releaseDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory() && /^mac/i.test(e.name)) {
      const app = join(releaseDir, e.name, "AutoBroker.app");
      if (existsSync(app)) out.push(app);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Worker — guards → lock → stamp → build → install
// ---------------------------------------------------------------------------

export async function runWorker(opts) {
  const paths = opts.paths ?? resolvePaths();
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const env = opts.env ?? process.env;
  // Phase seams default to the real implementations; tests inject deterministic
  // stand-ins so the worker's control flow can be exercised without a real build
  // or a real macOS `open`.
  const computeStamp = opts.computeLiveStamp ?? computeLiveStamp;
  const buildPhase = opts.phaseBuild ?? phaseBuild;
  const installPhase = opts.phaseInstall ?? phaseInstall;
  const log = (m) => {
    appendLog(paths.logPath, m);
    if (opts.verbose) console.log(m);
  };

  const skip = shouldSkipForGuards({
    env,
    repoRoot,
    primaryJsonPath: paths.primaryJsonPath,
    allowNoPrimary: opts.allowNoPrimary,
  });
  if (skip) {
    log(`skip: ${skip}`);
    return 0;
  }

  // Lock. Relaunch-critical modes acquire-or-wait; the rest coalesce on a held
  // lock (a burst of commits collapses into one trailing build).
  let acquired;
  if (opts.acquireOrWait) {
    acquired = acquireOrWaitLock(paths.lockDir, log);
  } else {
    acquired = acquireLock(paths.lockDir);
    if (!acquired && opts.coalesce) {
      mkdirSync(paths.refreshDir, { recursive: true });
      writeFileSync(paths.pendingPath, nonce() + "\n");
      log("lock held — wrote pending sentinel (coalesced)");
      return 0;
    }
  }
  if (!acquired) {
    log("lock held — exiting");
    return 0;
  }

  try {
    for (let pass = 0; pass < 8; pass++) {
      // Consume the pending sentinel for this pass; a sentinel that re-appears
      // DURING the build triggers exactly one more pass.
      try {
        rmSync(paths.pendingPath, { force: true });
      } catch {
        /* none */
      }

      let live = null;
      let stale = false;
      try {
        live = await computeStamp(repoRoot, { log });
      } catch (err) {
        log(`stamp threw (${err?.name ?? "error"}: ${err?.message ?? err}) → treat as stale`);
        stale = true;
      }
      if (live && live.state === "in-progress") {
        log("stamp in-progress (mid git op) — backing off");
        break;
      }
      const liveBuilt = live && live.state === "ok" ? live.builtStamp : null;
      const marker = readMarker(paths.markerPath);
      const fresh =
        !stale &&
        liveBuilt &&
        marker &&
        marker.builtStamp === liveBuilt &&
        existsSync(paths.appPath) &&
        !existsSync(paths.pendingPath);
      if (fresh) {
        log("up to date — no-op");
        // The install/relaunch modes must STILL bring the app back even on a
        // fresh no-op — the user quit the running instance and is waiting for it
        // to reopen. Relaunch is env-clean by absolute path; if a quitting pid
        // was given, wait for it to fully exit first.
        if (opts.doOpen) {
          if (opts.quittingPid) waitForPidExit(opts.quittingPid, 30_000);
          relaunchApp(paths.appPath, {
            liveInstancePids: opts.liveInstancePids,
            quittingPid: opts.quittingPid,
            open: opts.open,
            log,
          });
        }
        break;
      }

      // Stale → install. Reuse an already-staged build when its stamp matches the
      // current live stamp and its .app is still on disk (the "build+stage while a
      // live instance blocks the install → install the staged build on the next
      // trigger / on cold start" flow). Otherwise build fresh.
      let stagedAppPath;
      let builtStamp;
      let frameworkStamp;
      let builtAtIso;

      const staged = readStaged(paths.stagedPath);
      if (
        staged &&
        liveBuilt &&
        staged.builtStamp === liveBuilt &&
        typeof staged.stagedAppPath === "string" &&
        existsSync(staged.stagedAppPath)
      ) {
        log("reusing staged build (builtStamp matches live) — skipping rebuild");
        ({ stagedAppPath, builtStamp, frameworkStamp, builtAtIso } = staged);
      } else {
        log("stale → building");
        const built = buildPhase({ paths, repoRoot, log });
        stagedAppPath = built.stagedAppPath;

        // Authoritative marker stamp = the stamp of exactly what was built
        // (computed on the worktree, whose dist/freshness.js phaseBuild just made
        // current — no second build needed).
        builtStamp = null;
        frameworkStamp = null;
        try {
          const wtStamp = await computeStamp(paths.buildWt, { skipBuild: true, log });
          if (wtStamp.state === "ok") {
            builtStamp = wtStamp.builtStamp;
            frameworkStamp = wtStamp.frameworkStamp;
          }
        } catch (err) {
          log(`worktree stamp failed (${err?.message ?? err}) — marker stamps null`);
        }
        builtAtIso = new Date().toISOString();
        writeFileSync(
          paths.stagedPath,
          JSON.stringify({ stagedAppPath, builtStamp, frameworkStamp, builtAtIso }, null, 2),
        );
      }

      const primaryRepoPath = readPrimaryRepoPath(paths.primaryJsonPath, repoRoot);
      const res = installPhase(stagedAppPath, {
        paths,
        repoPath: repoRoot,
        primaryRepoPath,
        builtStamp,
        frameworkStamp,
        builtAtIso,
        quittingPid: opts.quittingPid,
        doOpen: opts.doOpen,
        open: opts.open,
        liveInstancePids: opts.liveInstancePids,
        log,
      });
      log(`install result: ${JSON.stringify(res)}`);

      // One more pass only if a commit landed a pending sentinel during the build.
      if (!existsSync(paths.pendingPath)) break;
      log("pending sentinel set during build — looping once more");
    }
    return 0;
  } catch (err) {
    // Any build/install error: the currently-installed app + marker are left
    // UNTOUCHED, never a half-written marker. Manual modes surface the failure.
    log(`ERROR: ${err?.stack ?? err}`);
    return 1;
  } finally {
    releaseLock(paths.lockDir);
  }
}

/** Parse the staged-build signal `{stagedAppPath, builtStamp, frameworkStamp,
 *  builtAtIso}`; any error → null (fail-soft, rebuild). */
function readStaged(stagedPath) {
  try {
    const data = JSON.parse(readFileSync(stagedPath, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/** primaryRepoPath from primary.json, falling back to repoRoot. */
function readPrimaryRepoPath(primaryJsonPath, repoRoot) {
  try {
    const primary = JSON.parse(readFileSync(primaryJsonPath, "utf8"));
    const p = String(primary?.primaryRepoPath ?? "");
    if (p) return p;
  } catch {
    /* none */
  }
  return repoRoot;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const paths = resolvePaths();

  // --hook: self-detach into a --worker child and return IMMEDIATELY so the git
  // hook never blocks the commit. The detached worker logs to logPath.
  if (args.hook !== undefined) {
    const { spawn } = await import("node:child_process");
    spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return 0;
  }

  if (args.worker !== undefined || args.refresh !== undefined) {
    return runWorker({ paths, coalesce: true });
  }

  if (args["launch-bg"] !== undefined) {
    return runWorker({ paths, acquireOrWait: true, doOpen: false });
  }

  if (args.install !== undefined) {
    const quittingPid = args["quitting-pid"] ? Number(args["quitting-pid"]) : undefined;
    return runWorker({
      paths,
      acquireOrWait: true,
      allowNoPrimary: true,
      quittingPid,
      doOpen: args.open !== undefined,
    });
  }

  if (args["first-install"] !== undefined) {
    return runWorker({ paths, acquireOrWait: true, allowNoPrimary: true, verbose: true });
  }

  // Default: behave like a coalescing worker.
  return runWorker({ paths, coalesce: true });
}

// Run the CLI only when invoked as the main module (so importing the file for
// unit tests never starts the orchestrator).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
