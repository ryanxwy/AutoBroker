/**
 * Unit tests for freshness.ts — stamps for the desktop build-freshness check.
 *
 * A throwaway git repo is constructed in beforeAll; tests that need to mutate
 * the working tree get their own copy via copyFixture() so the base stays clean.
 *
 * The suite is run by the root vitest invocation (`pnpm test`), which globs
 * apps/desktop/src/*.test.ts. No network calls, no provider, no product DB.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  computeBuiltStamp,
  computeFrameworkStamp,
  computeSourceStamp,
  EMPTY_TREE,
  ForceRebuild,
  resolveGit,
} from "./freshness.js";
import type { SourceStamp } from "./freshness.js";

// The real worktree repo root, derived from this test file's own location:
// apps/desktop/src/freshness.test.ts → up three dirs. The framework + built
// stamp tests run against it because that is where the resolved Electron /
// native-dep versions actually exist.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let baseDir: string; // committed base repo — NEVER mutated by tests
let git: string;
const allTmpDirs: string[] = [];

function initFixture(): void {
  git = resolveGit();

  baseDir = mkdtempSync(join(tmpdir(), "freshness-base-"));
  allTmpDirs.push(baseDir);

  // Minimal .gitignore that matches the algorithm's default treatment:
  // build artifacts are gitignored → git add -A silently drops them.
  writeFileSync(join(baseDir, ".gitignore"), "dist/\nnode_modules/\n*.tsbuildinfo\n");

  // One representative runtime-source file
  mkdirSync(join(baseDir, "packages", "core"), { recursive: true });
  writeFileSync(join(baseDir, "packages", "core", "x.ts"), "export const x = 1;\n");

  for (const cmd of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
    ["add", "-A"],
    ["commit", "-m", "init"],
  ] as string[][]) {
    execFileSync(git, cmd, { cwd: baseDir, stdio: "pipe" });
  }
}

/** Return a fresh copy of the base fixture (for tests that mutate files). */
function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "freshness-copy-"));
  allTmpDirs.push(dir);
  cpSync(baseDir, dir, { recursive: true });
  return dir;
}

beforeAll(initFixture);
afterAll(() => {
  for (const d of allTmpDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// Stamp opts scoped to the fixture: only the roots that actually exist.
// Excludes mirror the default pattern for test files.
function testOpts(g: string): { git: string; roots: string[]; excludes: string[] } {
  return {
    git: g,
    roots: ["packages/core"],
    excludes: [
      ":(exclude,glob)**/*.test.*",
      ":(exclude,glob)**/*.spec.*",
      ":(exclude,glob)**/*.md",
    ],
  };
}

// ---------------------------------------------------------------------------
// resolveGit
// ---------------------------------------------------------------------------

describe("resolveGit", () => {
  it("returns an executable path from the allowlist", () => {
    const g = resolveGit();
    // Must be one of the two hardcoded allowlist entries
    expect(["/opt/homebrew/bin/git", "/usr/bin/git"]).toContain(g);
    expect(g.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// computeSourceStamp
// ---------------------------------------------------------------------------

describe("computeSourceStamp", () => {
  // Test 1 — determinism
  it("1. two calls on an unchanged repo return the same source", () => {
    const dir = copyFixture();
    const opts = testOpts(git);
    const s1 = computeSourceStamp(dir, opts);
    const s2 = computeSourceStamp(dir, opts);
    expect(s1.state).toBe("ok");
    expect(s1).toEqual(s2);
    if (s1.state === "ok") {
      expect(s1.source).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  // Test 2 — test-file edit does NOT move the stamp
  it("2. editing a *.test.ts file does not change the stamp", () => {
    const dir = copyFixture();
    const opts = testOpts(git);
    const before = computeSourceStamp(dir, opts);
    expect(before.state).toBe("ok");

    // Add a test file (matches the exclude pattern — must be invisible to stamp)
    writeFileSync(join(dir, "packages", "core", "foo.test.ts"), "// test\n");

    const after = computeSourceStamp(dir, opts);
    expect(after).toEqual(before);
  });

  // Test 3 — runtime-src edit DOES move the stamp
  it("3. editing a runtime source file changes the stamp", () => {
    const dir = copyFixture();
    const opts = testOpts(git);
    const before = computeSourceStamp(dir, opts);
    expect(before.state).toBe("ok");

    writeFileSync(join(dir, "packages", "core", "x.ts"), "export const x = 42;\n");

    const after = computeSourceStamp(dir, opts);
    expect(after.state).toBe("ok");

    // Extract sources using narrowing to satisfy TS strict checks
    if (before.state !== "ok" || after.state !== "ok") throw new Error("unexpected state");
    expect(after.source).not.toBe(before.source);
  });

  // Test 4 — new untracked runtime file DOES move the stamp (git diff NOT used)
  it("4. a new uncommitted runtime file changes the stamp", () => {
    const dir = copyFixture();
    const opts = testOpts(git);
    const before = computeSourceStamp(dir, opts);
    expect(before.state).toBe("ok");

    // Untracked, uncommitted file — git diff would miss this; write-tree catches it
    writeFileSync(join(dir, "packages", "core", "new.ts"), "export const y = 3;\n");

    const after = computeSourceStamp(dir, opts);
    expect(after.state).toBe("ok");
    if (before.state !== "ok" || after.state !== "ok") throw new Error("unexpected state");
    expect(after.source).not.toBe(before.source);
  });

  // Test 5 — gitignored output does NOT move the stamp
  it("5. a gitignored file in dist/ does not change the stamp", () => {
    const dir = copyFixture();
    const opts = testOpts(git);
    const before = computeSourceStamp(dir, opts);
    expect(before.state).toBe("ok");

    // dist/ is in .gitignore → git add -A silently skips it
    mkdirSync(join(dir, "packages", "core", "dist"), { recursive: true });
    writeFileSync(join(dir, "packages", "core", "dist", "x.js"), "const x = 1;\n");

    const after = computeSourceStamp(dir, opts);
    expect(after).toEqual(before);
  });

  // Test 6 — missing roots throw ForceRebuild, never return EMPTY_TREE
  it("6. missing roots throw ForceRebuild and never return the empty-tree sentinel", () => {
    expect(() =>
      computeSourceStamp(baseDir, {
        git,
        roots: ["does/not/exist/anywhere"],
        excludes: [],
      }),
    ).toThrow(ForceRebuild);

    // Belt-and-suspenders: if for some reason no throw, source must not be EMPTY_TREE
    let result: SourceStamp | undefined;
    try {
      result = computeSourceStamp(baseDir, { git, roots: ["does/not/exist"], excludes: [] });
    } catch {
      // expected — ForceRebuild
    }
    if (result?.state === "ok") {
      expect(result.source).not.toBe(EMPTY_TREE);
    }
  });

  // Test 7 — multiple build-output dirs leave the stamp unchanged
  it("7. gitignored build-output dirs (dist/, *.tsbuildinfo, node_modules/) do not move the stamp", () => {
    const dir = copyFixture();
    const opts = testOpts(git);
    const before = computeSourceStamp(dir, opts);
    expect(before.state).toBe("ok");

    // Simulate a build writing to several gitignored locations
    mkdirSync(join(dir, "packages", "core", "dist"), { recursive: true });
    writeFileSync(join(dir, "packages", "core", "dist", "a.js"), "// build output\n");
    writeFileSync(join(dir, "packages", "core", "tsconfig.tsbuildinfo"), "{}");
    mkdirSync(join(dir, "packages", "core", "node_modules", "some-dep"), { recursive: true });
    writeFileSync(join(dir, "packages", "core", "node_modules", "some-dep", "index.js"), "");

    const after = computeSourceStamp(dir, opts);
    expect(after).toEqual(before);
  });

  // In-progress guard
  it("in-progress: MERGE_HEAD present → {state:'in-progress'}", () => {
    const dir = copyFixture();
    const opts = testOpts(git);

    // Create the in-progress marker that computeSourceStamp checks
    writeFileSync(
      join(dir, ".git", "MERGE_HEAD"),
      "0000000000000000000000000000000000000000\n",
    );

    const result = computeSourceStamp(dir, opts);
    expect(result).toEqual({ state: "in-progress" });
  });
});

// ---------------------------------------------------------------------------
// computeFrameworkStamp / computeBuiltStamp
//
// These resolve the installed Electron + native-dep versions, so they run
// against the real worktree repo root (REPO_ROOT) where those packages exist —
// a synthetic git fixture has no node_modules to resolve.
// ---------------------------------------------------------------------------

describe("computeFrameworkStamp", () => {
  it("is deterministic — same inputs → same 64-hex stamp", () => {
    const a = computeFrameworkStamp(REPO_ROOT);
    const b = computeFrameworkStamp(REPO_ROOT);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });
});

describe("computeBuiltStamp", () => {
  it("folds builtStamp = sha256(frameworkStamp + '\\n' + source) and matches the parts", () => {
    const result = computeBuiltStamp(REPO_ROOT);
    expect(result.state).toBe("ok");
    if (result.state !== "ok") throw new Error("expected ok state");

    // The folded stamp is exactly sha256 of the two parts joined by a newline.
    const expected = createHash("sha256")
      .update(result.frameworkStamp + "\n" + result.source)
      .digest("hex");
    expect(result.builtStamp).toBe(expected);
    expect(result.builtStamp).toMatch(/^[0-9a-f]{64}$/);

    // source agrees with computeSourceStamp on the same root, and
    // frameworkStamp agrees with computeFrameworkStamp.
    const src = computeSourceStamp(REPO_ROOT);
    expect(src.state).toBe("ok");
    if (src.state === "ok") expect(result.source).toBe(src.source);
    expect(result.frameworkStamp).toBe(computeFrameworkStamp(REPO_ROOT));
  });

  it("returns {state:'in-progress'} mid-op (MERGE_HEAD present)", () => {
    const dir = copyFixture();

    // The fixture has packages/core, which is in computeBuiltStamp's default
    // roots, so the source step would otherwise succeed. The in-progress
    // marker must short-circuit before any framework resolution.
    writeFileSync(
      join(dir, ".git", "MERGE_HEAD"),
      "0000000000000000000000000000000000000000\n",
    );

    const result = computeBuiltStamp(dir, { git });
    expect(result).toEqual({ state: "in-progress" });
  });
});
