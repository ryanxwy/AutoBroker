/**
 * L1 unit tests — openDb() create-dir-if-missing + the getDb()/closeDb()
 * shared-connection contract.
 *
 * Freezes the first-intake DB contract (see client.ts): the first intake
 * disk write must not fail on a fresh machine, so openDb() creates the resolved
 * data directory (recursive) before better-sqlite3 opens the file. Both the
 * AUTOBROKER_DATA_DIR default (dir holds autobroker.db) and the explicit
 * AUTOBROKER_DB file override (mkdir ITS parent) are covered.
 *
 * getDb() contract: ONE cached connection per resolved DB path (same path →
 * same handle; a different AUTOBROKER_DATA_DIR → a different handle, so test
 * overrides never cross-contaminate); closeDb() closes the cached handles and
 * clears the cache so the next getDb() reopens fresh.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is mkdtemp'd per test; we then point at
 * a NON-EXISTENT nested path under it so the create-dir branch is exercised. The
 * AUTOBROKER_DATA_DIR / AUTOBROKER_DB env vars are saved and restored around each
 * test. NEVER writes ~/.autobroker-ts or ~/.autobroker.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb, openDb } from "./client.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

let tmpBase: string;

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), "autobroker-client-"));
  // Start each test from a clean slate; tests opt into exactly one override.
  delete process.env[DATA_DIR];
  delete process.env[DB_OVERRIDE];
});

afterEach(() => {
  closeDb(); // release any shared handles before the tmp dir is removed.
  rmSync(tmpBase, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

describe("openDb — create-dir-if-missing", () => {
  it("creates a missing AUTOBROKER_DATA_DIR and opens autobroker.db inside it", () => {
    // A nested directory that does NOT exist yet (only tmpBase exists).
    const dataDir = join(tmpBase, "nested", "data-dir");
    process.env[DATA_DIR] = dataDir;
    expect(existsSync(dataDir)).toBe(false);

    const db = openDb(); // resolves <dataDir>/autobroker.db from AUTOBROKER_DATA_DIR.
    try {
      expect(existsSync(dataDir)).toBe(true);
      expect(existsSync(join(dataDir, "autobroker.db"))).toBe(true);
    } finally {
      db.$client.close();
    }
  });

  it("creates the parent dir of a nested AUTOBROKER_DB explicit-file override", () => {
    const dbDir = join(tmpBase, "explicit", "deeper");
    const dbPath = join(dbDir, "custom.db");
    process.env[DB_OVERRIDE] = dbPath;
    expect(existsSync(dbDir)).toBe(false);

    const db = openDb(); // AUTOBROKER_DB wins over the DATA_DIR default.
    try {
      expect(existsSync(dbDir)).toBe(true);
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      db.$client.close();
    }
  });

  it("is idempotent when the resolved directory already exists", () => {
    // tmpBase already exists; point AUTOBROKER_DB straight at a file in it.
    const dbPath = join(tmpBase, "already-there.db");
    process.env[DB_OVERRIDE] = dbPath;

    const db = openDb();
    try {
      expect(existsSync(dbPath)).toBe(true);
    } finally {
      db.$client.close();
    }
  });
});

describe("getDb / closeDb — one shared connection per resolved path", () => {
  it("returns the SAME handle for repeated calls on the same resolved path", () => {
    process.env[DATA_DIR] = join(tmpBase, "shared");

    const first = getDb();
    const second = getDb();
    expect(second).toBe(first); // cached — no second connection opened.
  });

  it("returns a DIFFERENT handle when the data dir changes (no cross-contamination)", () => {
    process.env[DATA_DIR] = join(tmpBase, "dir-a");
    const a = getDb();
    process.env[DATA_DIR] = join(tmpBase, "dir-b");
    const b = getDb();
    expect(b).not.toBe(a);
    // Each handle stays bound to its own file: a write through one is
    // invisible through the other.
    a.$client.exec("CREATE TABLE t (x INTEGER)");
    expect(() => b.$client.prepare("SELECT * FROM t").all()).toThrow(/no such table/);
  });

  it("closeDb() closes the cached handles and the next getDb() reopens fresh", () => {
    process.env[DATA_DIR] = join(tmpBase, "reopen");
    const before = getDb();
    closeDb();
    expect(before.$client.open).toBe(false); // really closed, not just dropped.
    const after = getDb();
    expect(after).not.toBe(before);
    expect(after.$client.open).toBe(true);
  });

  it("does not affect caller-owned openDb() handles", () => {
    const privatePath = join(tmpBase, "private.db");
    const mine = openDb(privatePath);
    try {
      process.env[DATA_DIR] = join(tmpBase, "shared-2");
      getDb();
      closeDb();
      expect(mine.$client.open).toBe(true); // private handle untouched.
    } finally {
      mine.$client.close();
    }
  });
});
