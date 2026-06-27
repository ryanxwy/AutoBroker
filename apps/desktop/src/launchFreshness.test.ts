/**
 * Unit tests for launchFreshness.ts — the fail-soft data core of the packaged
 * launch-time freshness check. No Electron, no network, no provider: these
 * exercise the high-risk marker read/validate path + the env-clean spawn spec
 * under the root `pnpm test` (which globs apps/desktop/src/*.test.ts).
 *
 * Throwaway dirs (and one throwaway git repo for the valid work-tree case) are
 * built in beforeAll and torn down in afterAll.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  isValidRepoPath,
  markerPathFor,
  readMarker,
  readStagedSignal,
  refreshSpawnSpec,
  stagedPathFor,
} from "./launchFreshness.js";

const allTmpDirs: string[] = [];
let gitRepo: string; // a real git work-tree (valid repoPath)
let plainDir: string; // a directory that is NOT a git work-tree
let git: string;

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  allTmpDirs.push(d);
  return d;
}

beforeAll(() => {
  // Resolve git the same way the module does (allowlist), for the work-tree fixture.
  git = ["/opt/homebrew/bin/git", "/usr/bin/git"].find((c) => {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })!;

  gitRepo = tmp("lf-gitrepo-");
  writeFileSync(join(gitRepo, "x.txt"), "hi\n");
  for (const cmd of [
    ["init", "-b", "main"],
    ["config", "user.email", "t@example.com"],
    ["config", "user.name", "T"],
    ["add", "-A"],
    ["commit", "-m", "init"],
  ]) {
    execFileSync(git, cmd, { cwd: gitRepo, stdio: "ignore" });
  }

  plainDir = tmp("lf-plain-");
});

afterAll(() => {
  for (const d of allTmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ---------------------------------------------------------------------------
// Path keys — main.ts and desktop-refresh.mjs MUST agree on these.
// ---------------------------------------------------------------------------

describe("markerPathFor / stagedPathFor", () => {
  it("keys the marker by sha256 of the install path under desktop-refresh/", () => {
    const dataDir = "/data";
    const appPath = "/Applications/AutoBroker.app";
    const hash = createHash("sha256").update(appPath).digest("hex");
    expect(markerPathFor(dataDir, appPath)).toBe(join(dataDir, "desktop-refresh", hash + ".json"));
    expect(stagedPathFor(dataDir, appPath)).toBe(join(dataDir, "desktop-refresh", "staged-" + hash + ".json"));
  });
});

// ---------------------------------------------------------------------------
// readMarker — fail-soft parse
// ---------------------------------------------------------------------------

describe("readMarker", () => {
  it("missing marker → null", () => {
    expect(readMarker(join(tmp("lf-missing-"), "nope.json"))).toBeNull();
  });

  it("garbage / truncated marker → null (no throw)", () => {
    const dir = tmp("lf-garbage-");
    const p = join(dir, "m.json");
    writeFileSync(p, '{"schemaVersion": 1, "repoPath": "/x"'); // truncated JSON
    expect(readMarker(p)).toBeNull();

    writeFileSync(p, "not json at all \x00\xff");
    expect(readMarker(p)).toBeNull();

    writeFileSync(p, "[1,2,3]"); // valid JSON, wrong shape (array)
    expect(readMarker(p)).toBeNull();

    writeFileSync(p, '{"repoPath": "/x"}'); // missing schemaVersion
    expect(readMarker(p)).toBeNull();

    writeFileSync(p, '{"schemaVersion": 1}'); // missing repoPath
    expect(readMarker(p)).toBeNull();
  });

  it("valid marker round-trips (lenient on null stamps)", () => {
    const dir = tmp("lf-valid-");
    const p = join(dir, "m.json");
    const marker = {
      schemaVersion: 1,
      repoPath: "/repo/path",
      primaryRepoPath: "/repo/path",
      builtStamp: "abc123",
      frameworkStamp: "def456",
      builtAtIso: "2026-06-27T00:00:00.000Z",
    };
    writeFileSync(p, JSON.stringify(marker, null, 2));
    expect(readMarker(p)).toEqual(marker);

    // builtStamp/frameworkStamp may legitimately be null (stamp not computable).
    writeFileSync(
      p,
      JSON.stringify({ schemaVersion: 1, repoPath: "/r", primaryRepoPath: "/r", builtStamp: null, frameworkStamp: null, builtAtIso: "" }),
    );
    expect(readMarker(p)?.builtStamp).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readStagedSignal — fail-soft parse
// ---------------------------------------------------------------------------

describe("readStagedSignal", () => {
  it("missing / garbage → null; valid round-trips", () => {
    const dir = tmp("lf-staged-");
    const p = join(dir, "s.json");
    expect(readStagedSignal(join(dir, "absent.json"))).toBeNull();

    writeFileSync(p, "{bad");
    expect(readStagedSignal(p)).toBeNull();

    writeFileSync(p, "{}"); // no stagedAppPath
    expect(readStagedSignal(p)).toBeNull();

    writeFileSync(
      p,
      JSON.stringify({ stagedAppPath: "/tmp/AutoBroker.app", builtStamp: "s1", frameworkStamp: "f1", builtAtIso: "now" }),
    );
    expect(readStagedSignal(p)).toEqual({
      stagedAppPath: "/tmp/AutoBroker.app",
      builtStamp: "s1",
      frameworkStamp: "f1",
      builtAtIso: "now",
    });
  });
});

// ---------------------------------------------------------------------------
// isValidRepoPath — exists + dir + git work-tree, fail-soft
// ---------------------------------------------------------------------------

describe("isValidRepoPath", () => {
  it("non-existent repoPath → false WITHOUT touching git", () => {
    // git: null would force the no-git branch, but a non-existent path must be
    // rejected before git is even considered, so even a real git stays unused.
    expect(isValidRepoPath("/no/such/path/anywhere", { git: null })).toBe(false);
  });

  it("a file (not a directory) → false", () => {
    const dir = tmp("lf-file-");
    const f = join(dir, "afile");
    writeFileSync(f, "x");
    expect(isValidRepoPath(f)).toBe(false);
  });

  it("an existing dir that is NOT a git work-tree → false", () => {
    expect(isValidRepoPath(plainDir)).toBe(false);
  });

  it("a real git work-tree → true", () => {
    expect(isValidRepoPath(gitRepo)).toBe(true);
  });

  it("git unavailable (null) on a real dir → false (fail-soft, no throw)", () => {
    expect(isValidRepoPath(gitRepo, { git: null })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// refreshSpawnSpec — fixed-rule interpreters + env-clean
// ---------------------------------------------------------------------------

describe("refreshSpawnSpec", () => {
  const base = {
    execPath: "/Applications/AutoBroker.app/Contents/MacOS/AutoBroker",
    repoPath: "/repo",
    dataDir: "/data",
  };

  it("install mode → --install --quitting-pid <pid> --open against the repo's script", () => {
    const spec = refreshSpawnSpec({ ...base, mode: "install", selfPid: 4242 });
    expect(spec.file).toBe(base.execPath); // node = the app's own execPath (fixed rule)
    expect(spec.args).toEqual([
      join("/repo", "scripts", "desktop-refresh.mjs"),
      "--install",
      "--quitting-pid",
      "4242",
      "--open",
    ]);
  });

  it("launch-bg mode → --launch-bg", () => {
    const spec = refreshSpawnSpec({ ...base, mode: "launch-bg" });
    expect(spec.args).toEqual([join("/repo", "scripts", "desktop-refresh.mjs"), "--launch-bg"]);
  });

  it("child env is env-clean: NO AUTOBROKER_MODE, ELECTRON_RUN_AS_NODE=1, dataDir pinned", () => {
    const spec = refreshSpawnSpec({
      ...base,
      mode: "install",
      selfPid: 1,
      baseEnv: {
        AUTOBROKER_MODE: "buyer",
        AUTOBROKER_HARNESS: "1",
        AUTOBROKER_TEST_AUTO_APPROVE: "1",
        AUTOBROKER_DATA_DIR: "/some/other/dir",
        PATH: "/usr/bin",
        HOME: "/home/x",
      },
    });
    // The load-bearing env-clean assertion: no forced send-mode reaches the child.
    expect(spec.env.AUTOBROKER_MODE).toBeUndefined();
    expect(spec.env.AUTOBROKER_HARNESS).toBeUndefined();
    expect(spec.env.AUTOBROKER_TEST_AUTO_APPROVE).toBeUndefined();
    // Interpreter rule + path pinning.
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(spec.env.AUTOBROKER_DATA_DIR).toBe("/data"); // pinned to the launcher's resolved dir
    // Unrelated env is preserved (PATH etc. carries through to the build).
    expect(spec.env.PATH).toBe("/usr/bin");
    expect(spec.env.HOME).toBe("/home/x");
  });
});
