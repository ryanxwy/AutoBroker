/**
 * L1 — the programmatic migrator recreates the FULL product schema on a fresh
 * empty better-sqlite3 DB.
 *
 * Freezes: every table declared in schema.ts exists after migrate() and is
 * queryable; migrate() is idempotent (a second run is a no-op, no error); the
 * expected table set is DERIVED from schema.ts (not a hardcoded count) so the
 * assertion tracks the schema automatically.
 *
 * ISOLATION: a throwaway in-tmpdir DB file; NEVER touches ~/.autobroker*.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "./schema.js";
import { migrate, DEFAULT_MIGRATIONS_FOLDER, productTableNames } from "./migrator.js";

/** The expected table names — the package manifest (schema.ts + the TS-owned
 *  `test_run_records` ledger), never a frozen count. */
function expectedTableNames(): string[] {
  return productTableNames();
}

let tmpDir: string;
let sqlite: InstanceType<typeof Database>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-migrator-"));
  sqlite = new Database(join(tmpDir, "fresh.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
});

afterEach(() => {
  sqlite.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** The names of tables that physically exist in the DB (excluding sqlite's own
 *  internal tables and the migrator's bookkeeping table). */
function actualTableNames(): Set<string> {
  const rows = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' " +
        "AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations'",
    )
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

describe("migrate()", () => {
  it("recreates the FULL product schema on a fresh empty DB", () => {
    const db = drizzle(sqlite, { schema });
    expect(actualTableNames().size).toBe(0); // fresh: no product tables yet

    migrate(db, { migrationsFolder: DEFAULT_MIGRATIONS_FOLDER });

    const present = actualTableNames();
    const expected = expectedTableNames();
    expect(expected.length).toBeGreaterThan(0);
    for (const name of expected) {
      expect(present.has(name), `table '${name}' should exist after migrate()`).toBe(true);
    }
    // No extra product tables beyond the schema manifest.
    expect([...present].sort()).toEqual(expected);
  });

  it("leaves every created table queryable and empty", () => {
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: DEFAULT_MIGRATIONS_FOLDER });

    for (const name of expectedTableNames()) {
      const row = sqlite.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number };
      expect(row.n, `table '${name}' should be queryable and empty`).toBe(0);
    }
  });

  it("is idempotent — a second migrate() is a no-op, never an error", () => {
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: DEFAULT_MIGRATIONS_FOLDER });
    const first = actualTableNames();

    expect(() => migrate(db, { migrationsFolder: DEFAULT_MIGRATIONS_FOLDER })).not.toThrow();
    expect([...actualTableNames()].sort()).toEqual([...first].sort());
  });

  it("uses the package drizzle/ folder by default", () => {
    const db = drizzle(sqlite, { schema });
    expect(() => migrate(db)).not.toThrow();
    expect(actualTableNames().has("accounts")).toBe(true);
  });
});
