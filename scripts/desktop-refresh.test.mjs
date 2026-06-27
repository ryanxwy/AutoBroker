/**
 * Unit tests for desktop-refresh.mjs — the orchestrator's testable surface:
 * phaseInstall (happy / completeness-fail / live-instance), the single-flight
 * lock, the guards + primary-binding gate, and the marker round-trip.
 *
 * Everything runs against a THROWAWAY data dir + a THROWAWAY apps dir
 * (AUTOBROKER_DESKTOP_APPS_DIR override) — NEVER the real /Applications, NEVER
 * ~/.autobroker-ts. No real electron-builder build runs here: phaseInstall is
 * driven against a SYNTHETIC staged .app (stub launcher + app.asar + server.cjs).
 *
 * Globbed by the root `pnpm test` (vitest) like any *.test.mjs.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  acquireLock,
  appendLog,
  isLockStale,
  liveInstancePids,
  passesPrimaryBinding,
  phaseInstall,
  readMarker,
  releaseLock,
  REPO_ROOT,
  resolveGit,
  resolvePaths,
  runWorker,
  shouldSkipForGuards,
  verifyInstalledApp,
  writeMarkerAtomic,
} from "./desktop-refresh.mjs";

const allTmp = [];
function mkTmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  allTmp.push(d);
  return d;
}

/** A throwaway data dir + apps dir → a full resolvePaths() set. */
function isolatedPaths() {
  const dataDir = mkTmp("dr-data-");
  const appsDir = mkTmp("dr-apps-");
  return resolvePaths({ AUTOBROKER_DATA_DIR: dataDir, AUTOBROKER_DESKTOP_APPS_DIR: appsDir });
}

/** Synthesize a staged .app dir with the three load-bearing entries. */
function makeStagedApp({ withServer = true } = {}) {
  const dir = mkTmp("dr-staged-");
  const root = join(dir, "AutoBroker.app");
  const macos = join(root, "Contents", "MacOS");
  const res = join(root, "Contents", "Resources");
  mkdirSync(macos, { recursive: true });
  mkdirSync(join(res, "bundle"), { recursive: true });
  writeFileSync(join(macos, "AutoBroker"), "#!/bin/sh\necho autobroker-stub\n");
  chmodSync(join(macos, "AutoBroker"), 0o755);
  writeFileSync(join(res, "app.asar"), "asar-stub-bytes");
  if (withServer) writeFileSync(join(res, "bundle", "server.cjs"), "// server.cjs stub\n");
  return root;
}

beforeAll(() => {
  // appendLog is exercised lightly so the rolling-log helper is covered.
  appendLog(join(mkTmp("dr-log-"), "x.log"), "test boot");
});
afterAll(() => {
  for (const d of allTmp) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ---------------------------------------------------------------------------
// 1. phaseInstall — happy path
// ---------------------------------------------------------------------------

// phaseInstall drives the real macOS `ditto` / `xattr` (the feature is
// macOS-only — see CLAUDE.md "Scope: macOS-only"). On a non-darwin CI runner
// `/usr/bin/ditto` is absent (spawnSync ENOENT), so guard these real-install
// blocks to darwin; the platform-independent blocks below still run everywhere.
describe.skipIf(process.platform !== "darwin")("phaseInstall — happy path", () => {
  it("installs the bundle, writes the marker LAST, strips quarantine, clears the staged signal", () => {
    const paths = isolatedPaths();
    const staged = makeStagedApp();

    // A leftover staged signal must be cleared by a successful install.
    mkdirSync(paths.refreshDir, { recursive: true });
    writeFileSync(paths.stagedPath, JSON.stringify({ stagedAppPath: staged }));

    // The dev tree must be untouched by an install run.
    const git = resolveGit();
    const statusBefore = execFileSync(git, ["-C", REPO_ROOT, "status", "--porcelain"], { encoding: "utf8" });

    const res = phaseInstall(staged, {
      paths,
      builtStamp: "builtstamp-abc123",
      frameworkStamp: "fw-deadbeef",
      repoPath: "/some/repo",
      primaryRepoPath: "/some/repo",
      builtAtIso: "2026-01-02T03:04:05.000Z",
      liveInstancePids: () => [],
      doOpen: false,
    });

    expect(res).toEqual({ installed: true });

    // appPath exists with all three required entries (does not throw).
    expect(() => verifyInstalledApp(paths.appPath)).not.toThrow();
    expect(existsSync(join(paths.appPath, "Contents", "MacOS", "AutoBroker"))).toBe(true);
    expect(existsSync(join(paths.appPath, "Contents", "Resources", "app.asar"))).toBe(true);
    expect(existsSync(join(paths.appPath, "Contents", "Resources", "bundle", "server.cjs"))).toBe(true);

    // Marker written AFTER, with the right builtStamp + DATA-ONLY shape.
    const marker = readMarker(paths.markerPath);
    expect(marker).not.toBeNull();
    expect(marker.schemaVersion).toBe(1);
    expect(marker.builtStamp).toBe("builtstamp-abc123");
    expect(marker.frameworkStamp).toBe("fw-deadbeef");
    expect(marker.builtAtIso).toBe("2026-01-02T03:04:05.000Z");
    // No interpreter / script paths leaked into the marker.
    expect(Object.keys(marker).sort()).toEqual(
      ["builtAtIso", "builtStamp", "frameworkStamp", "primaryRepoPath", "repoPath", "schemaVersion"],
    );

    // Quarantine xattr is absent on the installed bundle.
    const xa = spawnSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", paths.appPath], { encoding: "utf8" });
    expect(xa.status).not.toBe(0);
    expect(xa.stderr).toMatch(/No such xattr/);

    // The staged signal was consumed.
    expect(existsSync(paths.stagedPath)).toBe(false);

    // The dev tree is unchanged.
    const statusAfter = execFileSync(git, ["-C", REPO_ROOT, "status", "--porcelain"], { encoding: "utf8" });
    expect(statusAfter).toBe(statusBefore);
  });

  it("replaces an existing install (replace-not-merge)", () => {
    const paths = isolatedPaths();
    // Pre-seed an old install with a stray file that must NOT survive the swap.
    mkdirSync(join(paths.appPath, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(paths.appPath, "Contents", "MacOS", "STALE_LEFTOVER"), "old");

    const staged = makeStagedApp();
    const res = phaseInstall(staged, { paths, builtStamp: "s2", liveInstancePids: () => [] });
    expect(res).toEqual({ installed: true });
    // The stale file is gone — the install replaced rather than merged.
    expect(existsSync(join(paths.appPath, "Contents", "MacOS", "STALE_LEFTOVER"))).toBe(false);
    expect(existsSync(join(paths.appPath, "Contents", "Resources", "bundle", "server.cjs"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. phaseInstall — completeness failure
// ---------------------------------------------------------------------------

describe.skipIf(process.platform !== "darwin")("phaseInstall — completeness failure", () => {
  it("throws and writes NO marker when the staged bundle is missing server.cjs", () => {
    const paths = isolatedPaths();
    const staged = makeStagedApp({ withServer: false });

    expect(() => phaseInstall(staged, { paths, builtStamp: "x", liveInstancePids: () => [] })).toThrow(
      /incomplete bundle/,
    );

    // No marker on a completeness failure.
    expect(existsSync(paths.markerPath)).toBe(false);
    // The previous (absent) install was never replaced with an incomplete bundle.
    expect(existsSync(paths.appPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. phaseInstall — live instance defers the swap
// ---------------------------------------------------------------------------

describe("phaseInstall — live instance", () => {
  it("does NOT swap and returns {installed:false} when an instance is running", () => {
    const paths = isolatedPaths();
    const staged = makeStagedApp();

    const res = phaseInstall(staged, {
      paths,
      builtStamp: "x",
      liveInstancePids: () => [4242], // stubbed live instance
    });

    expect(res).toEqual({ installed: false, reason: "live-instance" });
    expect(existsSync(paths.appPath)).toBe(false);
    expect(existsSync(paths.markerPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Single-flight lock
// ---------------------------------------------------------------------------

describe("single-flight lock", () => {
  it("a second acquireLock on a held lock fails; releaseLock frees it", () => {
    const paths = isolatedPaths();
    expect(acquireLock(paths.lockDir)).toBe(true);
    expect(acquireLock(paths.lockDir)).toBe(false);
    releaseLock(paths.lockDir);
    expect(existsSync(paths.lockDir)).toBe(false);
    // Re-acquirable after release.
    expect(acquireLock(paths.lockDir)).toBe(true);
    releaseLock(paths.lockDir);
  });

  it("reclaims a lock held by a dead pid", () => {
    const paths = isolatedPaths();
    // A child that has already exited → its pid is dead.
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    mkdirSync(paths.lockDir, { recursive: true });
    writeFileSync(join(paths.lockDir, "info.json"), JSON.stringify({ pid: deadPid, startTime: "irrelevant" }));

    expect(isLockStale(paths.lockDir)).toBe(true);
    expect(acquireLock(paths.lockDir)).toBe(true); // reclaimed
    releaseLock(paths.lockDir);
  });

  it("reclaims a lock dir older than 15 minutes", () => {
    const paths = isolatedPaths();
    mkdirSync(paths.lockDir, { recursive: true });
    // pid alive (us) + empty startTime → only the age rule can mark it stale.
    writeFileSync(join(paths.lockDir, "info.json"), JSON.stringify({ pid: process.pid, startTime: "" }));

    // Fresh → not stale.
    expect(isLockStale(paths.lockDir)).toBe(false);

    // Backdate the dir mtime 20 minutes → stale.
    const old = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(paths.lockDir, old, old);
    expect(isLockStale(paths.lockDir)).toBe(true);
    expect(acquireLock(paths.lockDir)).toBe(true); // reclaimed
    releaseLock(paths.lockDir);
  });
});

// ---------------------------------------------------------------------------
// 5. Guards + primary-binding
// ---------------------------------------------------------------------------

describe("guards", () => {
  it("CI=true skips", () => {
    expect(shouldSkipForGuards({ env: { CI: "true" } })).toBe("ci");
  });

  it("AUTOBROKER_DESKTOP_REFRESH=0 skips (kill switch)", () => {
    const reason = shouldSkipForGuards({ env: { AUTOBROKER_DESKTOP_REFRESH: "0" } });
    expect(reason).toMatch(/kill-switch/);
  });
});

describe("passesPrimaryBinding", () => {
  it("absent primary.json: manual modes proceed, the hook path does not", () => {
    const missing = join(mkTmp("dr-pj-"), "primary.json");
    expect(passesPrimaryBinding({ repoRoot: REPO_ROOT, primaryJsonPath: missing, allowNoPrimary: true })).toBe(true);
    expect(passesPrimaryBinding({ repoRoot: REPO_ROOT, primaryJsonPath: missing, allowNoPrimary: false })).toBe(false);
  });

  it("is false when primary.json points at a different checkout", () => {
    const pj = join(mkTmp("dr-pj-"), "primary.json");
    writeFileSync(pj, JSON.stringify({ primaryRepoPath: "/some/other/checkout/path" }));
    expect(passesPrimaryBinding({ repoRoot: REPO_ROOT, primaryJsonPath: pj })).toBe(false);
  });

  it("is true for the bound, non-linked primary checkout", () => {
    // A fresh standalone git repo: git-dir === git-common-dir (not a worktree).
    const repo = mkTmp("dr-primary-");
    const git = resolveGit();
    for (const cmd of [
      ["init", "-b", "main"],
      ["config", "user.email", "t@example.com"],
      ["config", "user.name", "T"],
      ["commit", "--allow-empty", "-m", "init"],
    ]) {
      execFileSync(git, ["-C", repo, ...cmd], { stdio: "pipe" });
    }
    const pj = join(mkTmp("dr-pj-"), "primary.json");
    writeFileSync(pj, JSON.stringify({ primaryRepoPath: realpathSync(repo) }));
    expect(passesPrimaryBinding({ repoRoot: repo, primaryJsonPath: pj, git })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Marker round-trip
// ---------------------------------------------------------------------------

describe("marker round-trip", () => {
  it("writeMarkerAtomic → readMarker returns the same object", () => {
    const dir = mkTmp("dr-marker-");
    const markerPath = join(dir, "marker.json");
    const marker = {
      schemaVersion: 1,
      repoPath: "/repo/path",
      primaryRepoPath: "/repo/path",
      builtStamp: "b".repeat(64),
      frameworkStamp: "f".repeat(64),
      builtAtIso: "2026-06-27T00:00:00.000Z",
    };
    writeMarkerAtomic(markerPath, marker);
    expect(readMarker(markerPath)).toEqual(marker);
  });

  it("fail-soft: garbage / truncated / missing markers read as null (never throw)", () => {
    const dir = mkTmp("dr-marker-");
    const garbage = join(dir, "garbage.json");
    writeFileSync(garbage, "{ this is not valid json");
    expect(readMarker(garbage)).toBeNull();

    const noSchema = join(dir, "noschema.json");
    writeFileSync(noSchema, JSON.stringify({ repoPath: "/x" })); // valid JSON, wrong shape
    expect(readMarker(noSchema)).toBeNull();

    expect(readMarker(join(dir, "does-not-exist.json"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// liveInstancePids — basic shape (no real app running for this app path)
// ---------------------------------------------------------------------------

describe("liveInstancePids", () => {
  it("returns an empty array when no process matches the app launcher path", () => {
    const paths = isolatedPaths();
    expect(liveInstancePids(paths.appPath)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runWorker — FIX 1: install/relaunch modes ALWAYS relaunch (even on fresh)
//
// runWorker exposes phase seams (computeLiveStamp / phaseBuild / phaseInstall /
// open / liveInstancePids) purely for deterministic unit drives — no real build
// and no real macOS `open` is spawned here.
// ---------------------------------------------------------------------------

describe("runWorker — FIX 1: relaunch fires even on a fresh no-op", () => {
  it("invokes the env-clean relaunch seam when the install is already fresh", async () => {
    const paths = isolatedPaths();
    // Make the install look already-fresh: appPath exists + marker stamp == live.
    mkdirSync(paths.appPath, { recursive: true });
    writeMarkerAtomic(paths.markerPath, {
      schemaVersion: 1,
      repoPath: "/r",
      primaryRepoPath: "/r",
      builtStamp: "STAMP-FRESH",
      frameworkStamp: "FW",
      builtAtIso: "2026-06-27T00:00:00.000Z",
    });

    const opened = [];
    let buildCalled = false;

    const code = await runWorker({
      paths,
      env: {}, // hermetic: no CI / kill-switch
      repoRoot: mkTmp("dr-repo-"), // throwaway; computeLiveStamp is stubbed
      allowNoPrimary: true,
      acquireOrWait: true, // the --install / relaunch mode
      doOpen: true,
      computeLiveStamp: async () => ({
        state: "ok",
        source: "src",
        frameworkStamp: "FW",
        builtStamp: "STAMP-FRESH",
      }),
      phaseBuild: () => {
        buildCalled = true;
        return { stagedAppPath: "/should/not/build" };
      },
      // Stand-in opener + a liveInstancePids that reports the app present so the
      // relaunch "did it appear" loop resolves immediately (no real open/wait).
      open: (p) => opened.push(p),
      liveInstancePids: () => [4321],
    });

    expect(code).toBe(0);
    expect(buildCalled).toBe(false); // fresh → no rebuild
    expect(opened).toEqual([paths.appPath]); // relaunch fired with the absolute path
  });

  it("does NOT relaunch on a fresh no-op when doOpen is not set (e.g. a hook run)", async () => {
    const paths = isolatedPaths();
    mkdirSync(paths.appPath, { recursive: true });
    writeMarkerAtomic(paths.markerPath, {
      schemaVersion: 1,
      repoPath: "/r",
      primaryRepoPath: "/r",
      builtStamp: "STAMP-FRESH",
      frameworkStamp: "FW",
      builtAtIso: "2026-06-27T00:00:00.000Z",
    });

    const opened = [];
    const code = await runWorker({
      paths,
      env: {},
      repoRoot: mkTmp("dr-repo-"),
      allowNoPrimary: true,
      coalesce: true,
      doOpen: false, // hook/worker path — no relaunch
      computeLiveStamp: async () => ({ state: "ok", source: "src", frameworkStamp: "FW", builtStamp: "STAMP-FRESH" }),
      phaseBuild: () => ({ stagedAppPath: "/should/not/build" }),
      open: (p) => opened.push(p),
      liveInstancePids: () => [4321],
    });

    expect(code).toBe(0);
    expect(opened).toEqual([]); // nothing relaunched
  });
});

// ---------------------------------------------------------------------------
// runWorker — FIX 2: a matching staged build is consumed, not rebuilt
// ---------------------------------------------------------------------------

describe("runWorker — FIX 2: consume the staged build", () => {
  it("skips phaseBuild and installs the staged app when its builtStamp matches the live stamp", async () => {
    const paths = isolatedPaths();
    mkdirSync(paths.refreshDir, { recursive: true });
    const stagedApp = makeStagedApp(); // a staged .app already on disk
    writeFileSync(
      paths.stagedPath,
      JSON.stringify({
        stagedAppPath: stagedApp,
        builtStamp: "STAMP-STAGED",
        frameworkStamp: "FW",
        builtAtIso: "2026-06-27T00:00:00.000Z",
      }),
    );
    // No marker → not fresh → stale path → staged-reuse branch.

    let buildCalled = false;
    const installedWith = [];

    const code = await runWorker({
      paths,
      env: {},
      repoRoot: mkTmp("dr-repo-"),
      allowNoPrimary: true,
      computeLiveStamp: async () => ({ state: "ok", source: "src", frameworkStamp: "FW", builtStamp: "STAMP-STAGED" }),
      phaseBuild: () => {
        buildCalled = true;
        return { stagedAppPath: "/should/not/build" };
      },
      phaseInstall: (appPath, o) => {
        installedWith.push({ appPath, builtStamp: o.builtStamp });
        return { installed: true };
      },
    });

    expect(code).toBe(0);
    expect(buildCalled).toBe(false); // no rebuild
    expect(installedWith).toHaveLength(1);
    expect(installedWith[0].appPath).toBe(stagedApp); // installed the staged build
    expect(installedWith[0].builtStamp).toBe("STAMP-STAGED");
  });

  it("rebuilds when the staged build's stamp does NOT match the live stamp", async () => {
    const paths = isolatedPaths();
    mkdirSync(paths.refreshDir, { recursive: true });
    const stagedApp = makeStagedApp();
    writeFileSync(
      paths.stagedPath,
      JSON.stringify({ stagedAppPath: stagedApp, builtStamp: "STAMP-OLD", frameworkStamp: "FW", builtAtIso: "x" }),
    );

    let buildCalled = false;
    const builtApp = makeStagedApp(); // what phaseBuild "produces"
    const installedWith = [];

    const code = await runWorker({
      paths,
      env: {},
      repoRoot: mkTmp("dr-repo-"),
      allowNoPrimary: true,
      computeLiveStamp: async () => ({ state: "ok", source: "src", frameworkStamp: "FW", builtStamp: "STAMP-NEW" }),
      phaseBuild: () => {
        buildCalled = true;
        return { stagedAppPath: builtApp };
      },
      phaseInstall: (appPath) => {
        installedWith.push(appPath);
        return { installed: true };
      },
    });

    expect(code).toBe(0);
    expect(buildCalled).toBe(true); // stamp mismatch → rebuild
    expect(installedWith).toEqual([builtApp]);
  });
});

// ---------------------------------------------------------------------------
// runWorker — never-strand: --install --open ALWAYS ends with the app running.
//
// If phaseInstall throws AFTER the old instance already quit, the doOpen mode
// must still (a) clear the staged signal (break the quit-loop on next launch)
// and (b) relaunch the app currently at appPath.
// ---------------------------------------------------------------------------

describe("runWorker — never-strand on a failed --install --open", () => {
  it("clears the staged signal and relaunches appPath when phaseInstall throws", async () => {
    const paths = isolatedPaths();
    mkdirSync(paths.refreshDir, { recursive: true });
    // A staged signal is on disk (would be re-consumed on the next launch if we
    // failed to clear it → quit-loop).
    writeFileSync(
      paths.stagedPath,
      JSON.stringify({ stagedAppPath: makeStagedApp(), builtStamp: "STAMP-NEW", frameworkStamp: "FW", builtAtIso: "x" }),
    );
    // No marker → not fresh → the worker enters the build/install path.

    const opened = [];
    const code = await runWorker({
      paths,
      env: {},
      repoRoot: mkTmp("dr-repo-"),
      allowNoPrimary: true,
      acquireOrWait: true, // the --install / relaunch mode
      doOpen: true,
      computeLiveStamp: async () => ({ state: "ok", source: "src", frameworkStamp: "FW", builtStamp: "STAMP-NEW" }),
      phaseBuild: () => ({ stagedAppPath: makeStagedApp() }),
      // Simulate a disk/permission/ditto failure during the atomic install.
      phaseInstall: () => {
        throw new Error("install boom (ditto/disk failure)");
      },
      // Stand-in opener + a liveInstancePids that reports the app present so the
      // relaunch "did it appear" loop resolves immediately (no real open/wait).
      open: (p) => opened.push(p),
      liveInstancePids: () => [7777],
    });

    expect(code).toBe(1); // the failure is still surfaced
    expect(opened).toEqual([paths.appPath]); // relaunch fired with the absolute path
    expect(existsSync(paths.stagedPath)).toBe(false); // staged signal cleared → no quit-loop
  });

  it("does NOT relaunch or clear the staged signal on a failed worker/hook run (no doOpen)", async () => {
    const paths = isolatedPaths();
    mkdirSync(paths.refreshDir, { recursive: true });
    writeFileSync(
      paths.stagedPath,
      JSON.stringify({ stagedAppPath: makeStagedApp(), builtStamp: "STAMP-NEW", frameworkStamp: "FW", builtAtIso: "x" }),
    );

    const opened = [];
    const code = await runWorker({
      paths,
      env: {},
      repoRoot: mkTmp("dr-repo-"),
      allowNoPrimary: true,
      coalesce: true,
      doOpen: false, // hook/worker path — no relaunch, no staged clear
      computeLiveStamp: async () => ({ state: "ok", source: "src", frameworkStamp: "FW", builtStamp: "STAMP-NEW" }),
      phaseBuild: () => ({ stagedAppPath: makeStagedApp() }),
      phaseInstall: () => {
        throw new Error("install boom");
      },
      open: (p) => opened.push(p),
      liveInstancePids: () => [7777],
    });

    expect(code).toBe(1);
    expect(opened).toEqual([]); // nothing relaunched
    expect(existsSync(paths.stagedPath)).toBe(true); // staged signal preserved (no doOpen recovery)
  });
});
