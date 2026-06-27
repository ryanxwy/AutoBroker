/**
 * launchFreshness.ts — the pure (Electron-free) fail-soft core of the packaged
 * app's launch-time freshness check. main.ts wires the Electron side (windows,
 * notifications, quit/relaunch); this module owns only the high-risk, easily
 * unit-tested data path: locate the external marker, parse it fail-soft, decide
 * whether its repoPath is a usable git work-tree, and shape the env-clean spawn
 * for the refresh orchestrator.
 *
 * Split out so that path runs under `pnpm test` WITHOUT launching Electron.
 * Every function here fails SOFT: a missing / truncated / garbage / shape-wrong
 * marker reads as "no marker" (null), and a repoPath that is not a real git
 * work-tree reads as invalid — the launcher then boots the installed build
 * unchanged, never crashing and never spawning git on a stranger's machine
 * (a shipped dmg / copied .app carries no marker at all, so it never gets here).
 *
 * The marker is DATA ONLY (schemaVersion, repoPath, primaryRepoPath, builtStamp,
 * frameworkStamp, builtAtIso) — no interpreter or script paths. Interpreters
 * resolve by FIXED RULE in refreshSpawnSpec: node = the app's own execPath run
 * as plain node (ELECTRON_RUN_AS_NODE=1), the script is always
 * <repoPath>/scripts/desktop-refresh.mjs. NOTHING executable is ever read from
 * the user-writable marker.
 *
 * Imports node built-ins only (layer rule, apps/desktop = L5).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Hardcoded git allowlist — the same fixed system locations the stamp side
 *  trusts. Never $PATH, never a user-writable file, so a poisoned environment
 *  can never redirect which git binary runs. */
const GIT_ALLOWLIST = ["/opt/homebrew/bin/git", "/usr/bin/git"] as const;

/** Env vars stripped from the refresh spawn so neither the background build nor
 *  the env-clean relaunch the script performs inherits a forced send-mode or an
 *  isolated test data dir. AUTOBROKER_MODE is the load-bearing one (the sole
 *  send-control var); the harness trio is stripped for the same reason. */
const STRIP_ENV = [
  "AUTOBROKER_MODE",
  "AUTOBROKER_HARNESS",
  "AUTOBROKER_HARNESS_FIXTURE",
  "AUTOBROKER_TEST_AUTO_APPROVE",
] as const;

/** The out-of-bundle DATA-ONLY marker the refresh script writes (atomically,
 *  LAST) after a successful install. builtStamp / frameworkStamp may be null —
 *  the orchestrator records null when the worktree stamp could not be computed
 *  (fail toward "unknown → assume stale"). */
export interface DesktopRefreshMarker {
  schemaVersion: number;
  repoPath: string;
  primaryRepoPath: string;
  builtStamp: string | null;
  frameworkStamp: string | null;
  builtAtIso: string;
}

/** The staged-build signal the refresh script writes after building but before
 *  an install can run (the install is deferred while a live instance is up).
 *  Shape: {stagedAppPath, builtStamp, frameworkStamp, builtAtIso} — note it is
 *  NOT a marker (no schemaVersion). */
export interface StagedSignal {
  stagedAppPath: string;
  builtStamp: string | null;
  frameworkStamp: string | null;
  builtAtIso: string;
}

/** sha256 hex of a string. */
function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** `<dataDir>/desktop-refresh/<sha256(appPath)>.json` — keyed by the install
 *  path so each install has its own marker. Mirrors the refresh script's scheme
 *  exactly; the two MUST agree on this key. */
export function markerPathFor(dataDir: string, appPath: string): string {
  return join(dataDir, "desktop-refresh", sha256(appPath) + ".json");
}

/** `<dataDir>/desktop-refresh/staged-<sha256(appPath)>.json`. */
export function stagedPathFor(dataDir: string, appPath: string): string {
  return join(dataDir, "desktop-refresh", "staged-" + sha256(appPath) + ".json");
}

/** Parse the marker; ANY error (missing, truncated, unparseable, wrong shape)
 *  → null. Fail-soft: a corrupt marker reads as "no marker", never throws.
 *  Requires the minimum load-bearing fields (a numeric schemaVersion and a
 *  non-empty repoPath); the stamp fields are read leniently (null when absent). */
export function readMarker(markerPath: string): DesktopRefreshMarker | null {
  try {
    const data = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    if (data === null || typeof data !== "object") return null;
    if (typeof data.schemaVersion !== "number") return null;
    if (typeof data.repoPath !== "string" || data.repoPath.length === 0) return null;
    return {
      schemaVersion: data.schemaVersion,
      repoPath: data.repoPath,
      primaryRepoPath: typeof data.primaryRepoPath === "string" ? data.primaryRepoPath : data.repoPath,
      builtStamp: typeof data.builtStamp === "string" ? data.builtStamp : null,
      frameworkStamp: typeof data.frameworkStamp === "string" ? data.frameworkStamp : null,
      builtAtIso: typeof data.builtAtIso === "string" ? data.builtAtIso : "",
    };
  } catch {
    return null;
  }
}

/** Parse the staged-build signal; any error → null (fail-soft). */
export function readStagedSignal(stagedPath: string): StagedSignal | null {
  try {
    const data = JSON.parse(readFileSync(stagedPath, "utf8")) as Record<string, unknown>;
    if (data === null || typeof data !== "object") return null;
    if (typeof data.stagedAppPath !== "string") return null;
    return {
      stagedAppPath: data.stagedAppPath,
      builtStamp: typeof data.builtStamp === "string" ? data.builtStamp : null,
      frameworkStamp: typeof data.frameworkStamp === "string" ? data.frameworkStamp : null,
      builtAtIso: typeof data.builtAtIso === "string" ? data.builtAtIso : "",
    };
  } catch {
    return null;
  }
}

/** First executable git from the allowlist, or null (fail-soft — never throws,
 *  unlike the stamp side's resolveGit). */
function resolveGitSafe(): string | null {
  for (const c of GIT_ALLOWLIST) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      /* not executable / absent — try the next candidate */
    }
  }
  return null;
}

/**
 * True only when repoPath is a real directory AND a git work-tree.
 *
 * The existence + directory checks come FIRST so a missing/renamed repoPath is
 * rejected WITHOUT ever spawning git (the non-existent-repoPath case never
 * touches git). git is then run with stdio fully ignored so a missing Xcode
 * command-line-tools can never raise an interactive install prompt; any
 * non-zero exit, missing git, or thrown error → invalid (boot the installed
 * build anyway).
 *
 * `opts.git` is injectable for tests (pass null to force the no-git branch).
 */
export function isValidRepoPath(repoPath: string, opts: { git?: string | null } = {}): boolean {
  try {
    if (!existsSync(repoPath)) return false;
    if (!statSync(repoPath).isDirectory()) return false;
    const git = opts.git !== undefined ? opts.git : resolveGitSafe();
    if (git === null) return false;
    execFileSync(git, ["-C", repoPath, "rev-parse", "--show-toplevel"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the spawn spec for the refresh orchestrator. Interpreters by FIXED RULE
 * (never from the marker): node = the app's own execPath run as plain node
 * (ELECTRON_RUN_AS_NODE=1); the script is always
 * <repoPath>/scripts/desktop-refresh.mjs.
 *
 * The child env is env-clean — AUTOBROKER_MODE and the harness vars are stripped
 * so a background build / the env-clean relaunch the script performs never
 * inherits a forced mode. AUTOBROKER_DATA_DIR is PINNED to the launcher's
 * resolved dataDir so the script's marker / staged / lock paths line up with the
 * launcher's (the script's own relaunch strips it again, so the finally-relaunched
 * app is still env-clean by absolute path).
 *
 *   mode "install"   → --install --quitting-pid <selfPid> --open
 *                      (consume a staged build / install, then relaunch)
 *   mode "launch-bg" → --launch-bg (background prepare; never relaunches)
 */
export function refreshSpawnSpec(opts: {
  execPath: string;
  repoPath: string;
  dataDir: string;
  mode: "install" | "launch-bg";
  selfPid?: number;
  baseEnv?: NodeJS.ProcessEnv;
}): { file: string; args: string[]; env: Record<string, string> } {
  const script = join(opts.repoPath, "scripts", "desktop-refresh.mjs");
  const args =
    opts.mode === "install"
      ? [script, "--install", "--quitting-pid", String(opts.selfPid ?? process.pid), "--open"]
      : [script, "--launch-bg"];

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.baseEnv ?? process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const k of STRIP_ENV) delete env[k];
  env.ELECTRON_RUN_AS_NODE = "1";
  env.AUTOBROKER_DATA_DIR = opts.dataDir;
  return { file: opts.execPath, args, env };
}
