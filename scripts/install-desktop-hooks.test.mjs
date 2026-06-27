/**
 * Tests for install-desktop-hooks.mjs and the POSIX git-hook shims.
 *
 * All tests run against THROWAWAY temp dirs — never the real repo's .git/hooks,
 * never ~/.autobroker-ts. The real repo root is only referenced to locate the
 * committed shim files to copy into the temp repos.
 */

import { accessSync, chmodSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { install } from "./install-desktop-hooks.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REAL_SHIM_DIR = join(SCRIPT_DIR, "git-hooks");

const HOOKS = ["post-commit", "post-merge", "post-checkout", "post-rewrite"];
const NULL_SHA = "0000000000000000000000000000000000000000";
const REAL_SHA = "abc1234567890abcdef1234567890abcdef12345";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const allTmp = [];

function mkTmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  allTmp.push(d);
  return d;
}

afterAll(() => {
  for (const d of allTmp) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function findGit() {
  for (const g of ["/opt/homebrew/bin/git", "/usr/bin/git"]) {
    try {
      accessSync(g, constants.X_OK);
      return g;
    } catch {
      /* try next */
    }
  }
  throw new Error("no git found on allowlist");
}

function gitExec(git, args, cwd) {
  execFileSync(git, args, { cwd, stdio: "pipe" });
}

/**
 * Create a minimal throwaway git repo with the shim files copied in.
 * Returns { repo, git }.
 */
function makeRepo() {
  const git = findGit();
  const repo = mkTmp("ab-hooks-test-");
  gitExec(git, ["init", "-b", "main"], repo);
  gitExec(git, ["config", "user.email", "test@example.com"], repo);
  gitExec(git, ["config", "user.name", "Test"], repo);

  // Copy the committed shim files so install() can chmod + symlink them.
  mkdirSync(join(repo, "scripts", "git-hooks"), { recursive: true });
  for (const name of HOOKS) {
    cpSync(join(REAL_SHIM_DIR, name), join(repo, "scripts", "git-hooks", name));
    chmodSync(join(repo, "scripts", "git-hooks", name), 0o755);
  }
  return { repo, git };
}

/**
 * Run the installer against a specific repo + data dir. Returns the absolute
 * path of the hooks directory for assertions.
 */
async function runInstall(repo, dataDir, git) {
  await install({ repoRoot: repo, dataDir, git });
  // hooks dir: git rev-parse --git-path hooks from inside the repo
  const hooksRel = execFileSync(git, ["rev-parse", "--git-path", "hooks"], {
    cwd: repo, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
  }).trim();
  return hooksRel.startsWith("/") ? hooksRel : join(repo, hooksRel);
}

// ---------------------------------------------------------------------------
// Installer tests (1–4)
// ---------------------------------------------------------------------------

describe("install-desktop-hooks.mjs", () => {
  it("1. idempotency: running installer twice leaves exactly 4 symlinks", async () => {
    const { repo, git } = makeRepo();
    const dataDir = mkTmp("ab-data-");

    const hooksDir = await runInstall(repo, dataDir, git);
    await runInstall(repo, dataDir, git); // second run

    const links = HOOKS.filter((name) => {
      try {
        return lstatSync(join(hooksDir, name)).isSymbolicLink();
      } catch {
        return false;
      }
    });
    expect(links).toHaveLength(4);
    // No duplicates or extra .bak files from re-running
    expect(existsSync(join(hooksDir, "post-commit.local.bak"))).toBe(false);
  });

  it("2. symlinks: each hooks/<name> is a symlink resolving to scripts/git-hooks/<name>", async () => {
    const { repo, git } = makeRepo();
    const dataDir = mkTmp("ab-data-");

    const hooksDir = await runInstall(repo, dataDir, git);

    for (const name of HOOKS) {
      const hookPath = join(hooksDir, name);
      const st = lstatSync(hookPath);
      expect(st.isSymbolicLink(), `${name} must be a symlink`).toBe(true);

      // The symlink must resolve to the shim file in scripts/git-hooks/
      const expectedTarget = join(repo, "scripts", "git-hooks", name);
      const resolved = resolve(hooksDir, readlinkSync(hookPath));
      expect(resolved).toBe(expectedTarget);
    }
  });

  it("3. non-clobber: a pre-existing real post-commit is backed up to post-commit.local.bak", async () => {
    const { repo, git } = makeRepo();
    const dataDir = mkTmp("ab-data-");
    const hooksRel = execFileSync(git, ["rev-parse", "--git-path", "hooks"], {
      cwd: repo, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    }).trim();
    const hooksDir = hooksRel.startsWith("/") ? hooksRel : join(repo, hooksRel);
    mkdirSync(hooksDir, { recursive: true });

    // Plant a real file (not a symlink) at hooks/post-commit.
    const existingContent = "#!/bin/sh\necho existing\n";
    writeFileSync(join(hooksDir, "post-commit"), existingContent, { mode: 0o755 });

    await install({ repoRoot: repo, dataDir, git });

    // The original file must be backed up.
    expect(existsSync(join(hooksDir, "post-commit.local.bak"))).toBe(true);
    expect(readFileSync(join(hooksDir, "post-commit.local.bak"), "utf8")).toBe(existingContent);

    // The hook itself must now be a symlink.
    expect(lstatSync(join(hooksDir, "post-commit")).isSymbolicLink()).toBe(true);
  });

  it("4. primary.json is written with the repo toplevel", async () => {
    const { repo, git } = makeRepo();
    const dataDir = mkTmp("ab-data-");

    await install({ repoRoot: repo, dataDir, git });

    const primaryPath = join(dataDir, "desktop-refresh", "primary.json");
    expect(existsSync(primaryPath)).toBe(true);
    const data = JSON.parse(readFileSync(primaryPath, "utf8"));
    expect(typeof data.primaryRepoPath).toBe("string");
    // Compare canonical paths: git returns the realpath, mkdtempSync may return
    // a symlink (e.g. /var → /private/var on macOS).
    expect(data.primaryRepoPath).toBe(realpathSync(repo));
  });
});

// ---------------------------------------------------------------------------
// Shim guard tests (5)
// ---------------------------------------------------------------------------

describe("post-checkout shim guard behavior", () => {
  const shimPath = join(REAL_SHIM_DIR, "post-checkout");

  // Temp repo with node_modules + a stub desktop-refresh.mjs that touches a
  // sentinel when invoked. The sentinel path is passed via SENTINEL_PATH env.
  let shimRepo;
  let git;
  let sentinel;

  beforeAll(() => {
    git = findGit();
    shimRepo = mkTmp("ab-shim-guard-");
    gitExec(git, ["init", "-b", "main"], shimRepo);

    // node_modules dir so the [ -d "$ROOT/node_modules" ] guard passes.
    mkdirSync(join(shimRepo, "node_modules"), { recursive: true });

    // Stub desktop-refresh.mjs: touch the SENTINEL_PATH file when invoked.
    mkdirSync(join(shimRepo, "scripts"), { recursive: true });
    writeFileSync(
      join(shimRepo, "scripts", "desktop-refresh.mjs"),
      [
        "import { writeFileSync } from 'node:fs';",
        "const p = process.env.SENTINEL_PATH;",
        "if (p) writeFileSync(p, '');",
      ].join("\n") + "\n",
    );

    sentinel = join(shimRepo, "sentinel");
  });

  function runShim(args) {
    // Remove any leftover sentinel before each invocation.
    try { rmSync(sentinel, { force: true }); } catch { /* ok */ }
    return spawnSync("sh", [shimPath, ...args], {
      cwd: shimRepo,
      env: { ...process.env, SENTINEL_PATH: sentinel },
      timeout: 10_000,
    });
  }

  it("$3=0 → shim exits early, sentinel NOT created", () => {
    runShim(["abc123", "def456", "0"]);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("$3=1 + null prev-SHA → shim exits early, sentinel NOT created", () => {
    runShim([NULL_SHA, "def456", "1"]);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("$3=1 + real prev-SHA → shim fires, sentinel created", () => {
    runShim([REAL_SHA, "def456", "1"]);
    expect(existsSync(sentinel)).toBe(true);
  });
});
