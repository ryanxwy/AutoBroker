/**
 * Tests for desktop-dist-tripwire.mjs.
 *
 * Each test builds a SYNTHETIC release dir (with a mac/AutoBroker.app tree) in
 * a throwaway temp dir, then spawns the tripwire as a child process pointing at
 * that dir. The tripwire accepts its scan root as argv[2], so no real
 * electron-builder output is needed. All files are created in tmp dirs — no
 * tracked source is modified.
 *
 * Test 1 — clean synthetic .app → exit 0
 * Test 2 — marker file (repoPath+builtStamp) injected under the .app → exit 1, path printed
 * Test 3 — AUTOBROKER_TEST_AUTO_APPROVE in synthetic server.cjs → exit 1
 * Test 4 — dev-origin literal in a file under the .app → exit 1
 * Test 5 — absent .app → exit 1 with a "run electron-builder first" message
 *
 * This file is excluded from the check:strings "dev-origin" rule because it
 * writes that literal to a tmp-dir fixture file to exercise the tripwire's
 * RULE 2 check.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TRIPWIRE = join(SCRIPT_DIR, "desktop-dist-tripwire.mjs");

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

/**
 * Build a synthetic release dir:
 *   <releaseDir>/mac/AutoBroker.app/Contents/Resources/bundle/server.cjs
 *
 * Returns { releaseDir, appRoot, serverCjs }.
 */
function makeRelease({ serverCjsContent = "// clean server stub\n" } = {}) {
  const releaseDir = mkTmp("twire-rel-");
  const appRoot = join(releaseDir, "mac", "AutoBroker.app");
  const bundleDir = join(appRoot, "Contents", "Resources", "bundle");
  mkdirSync(bundleDir, { recursive: true });
  const serverCjs = join(bundleDir, "server.cjs");
  writeFileSync(serverCjs, serverCjsContent);
  return { releaseDir, appRoot, serverCjs };
}

/** Run the tripwire against a release dir and return { status, stdout, stderr }. */
function runTripwire(releaseDir) {
  const result = spawnSync(process.execPath, [TRIPWIRE, releaseDir], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// Test 1 — clean .app exits 0
// ---------------------------------------------------------------------------

describe("desktop-dist-tripwire", () => {
  it("1. clean synthetic .app → exit 0", () => {
    const { releaseDir } = makeRelease();
    const { status, stdout } = runTripwire(releaseDir);
    expect(status).toBe(0);
    expect(stdout).toMatch(/OK/);
  });

  // -------------------------------------------------------------------------
  // Test 2 — marker file under .app → exit 1, path printed
  // -------------------------------------------------------------------------

  it("2. file with marker schema signature (repoPath+builtStamp) → exit 1, path printed", () => {
    const { releaseDir, appRoot } = makeRelease();

    // Inject a file containing both marker field names into the .app tree.
    // The content mimics the external marker JSON schema.
    const markerFile = join(appRoot, "Contents", "Resources", "leaked-marker.json");
    writeFileSync(markerFile, JSON.stringify({ repoPath: "/some/repo", builtStamp: "abc123" }));

    const { status, stderr } = runTripwire(releaseDir);
    expect(status).toBe(1);
    // The tripwire should print the offending path.
    expect(stderr).toContain(markerFile);
  });

  // -------------------------------------------------------------------------
  // Test 3 — AUTOBROKER_TEST_AUTO_APPROVE in server.cjs → exit 1
  // -------------------------------------------------------------------------

  it("3. AUTOBROKER_TEST_AUTO_APPROVE in server.cjs → exit 1", () => {
    // Write the token into server.cjs to simulate a build that baked in the
    // test-mode auto-approve env var.
    const { releaseDir, serverCjs } = makeRelease({
      serverCjsContent:
        "// server bundle\nconst x = process.env.AUTOBROKER_TEST_AUTO_APPROVE;\n",
    });

    const { status, stderr } = runTripwire(releaseDir);
    expect(status).toBe(1);
    expect(stderr).toContain(serverCjs);
  });

  // -------------------------------------------------------------------------
  // Test 4 — dev-origin in a file under .app → exit 1  (RULE 2 coverage)
  // -------------------------------------------------------------------------

  it("4. abandoned draft name (dev-origin) present under .app → exit 1", () => {
    const { releaseDir, appRoot } = makeRelease();

    // Plant a file containing the banned draft name (this file is excluded from
    // check:strings because it is a test fixture for the tripwire itself).
    const badFile = join(appRoot, "Contents", "Resources", "stale-ref.txt");
    writeFileSync(badFile, "marker path: dev-origin/some-hash.json\n");

    const { status, stderr } = runTripwire(releaseDir);
    expect(status).toBe(1);
    expect(stderr).toContain(badFile);
  });

  // -------------------------------------------------------------------------
  // Test 5 — absent .app → exit 1 with "run electron-builder" message
  // -------------------------------------------------------------------------

  it("5. absent .app → exit 1 with run-electron-builder message", () => {
    const emptyReleaseDir = mkTmp("twire-empty-");
    const { status, stderr } = runTripwire(emptyReleaseDir);
    expect(status).toBe(1);
    expect(stderr).toMatch(/electron-builder/i);
  });
});
