/**
 * L1 unit tests — test_run_records ledger writer (NULL-not-$0 keystone).
 *
 * Freezes the cost-metering contract (NULL-not-$0; usage tokens → cost):
 *   (a) costUsd: null round-trips as SQL NULL — never coerced to 0;
 *   (b) a normal row with a real costUsd round-trips intact;
 *   (c) the fail-LOUD guard rejects cost_usd = 0 + pricing_source = 'unavailable'
 *       (the silent-$0 bug) BEFORE any DB write.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is set as AUTOBROKER_DATA_DIR (saved /
 * restored around the suite); the committed migration SQL is executed against
 * the throwaway DB. NEVER writes ~/.autobroker-ts or ~/.autobroker.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, openDb, type Db } from "@autobroker/db";
import {
  SilentZeroCostError,
  writeTestRunRecord,
  type TestRunRecordInsert,
} from "./testRunRecords.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

// The committed migrations needed for test_run_records: 0000 creates the table,
// 0005 adds the malformed-evidence columns, 0007 drops them (the deleted #1244
// apparatus) so the test DB matches the current schema.
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = [
  "0000_military_red_skull.sql",
  "0005_military_nightshade.sql",
  "0007_public_thanos.sql",
].map((f) => join(here, "..", "..", "db", "drizzle", f));

let tmpDir: string;
let db: Db;

beforeAll(() => {
  // GAP: openDb() does NOT create the data dir if missing (client.ts has an
  // explicit TODO(phase-0) for create-dir-if-missing). The test therefore
  // mkdtemp's the dir itself before opening.
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-ledger-"));
  mkdirSync(tmpDir, { recursive: true });
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE]; // ensure DATA_DIR (not a stray AUTOBROKER_DB) wins.

  db = openDb(); // resolves <tmpDir>/autobroker.db from AUTOBROKER_DATA_DIR.

  // Apply the committed schema. The raw better-sqlite3 handle ($client) runs the
  // multi-statement migration; `--> statement-breakpoint` lines are `--` SQL
  // comments and are ignored. We need the test_run_records DDL; the migration is
  // self-contained (FKs reference tables it also creates). 0005 then adds the
  // malformed_signals / malformed_sample columns.
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
});

afterAll(() => {
  db.$client.close();
  closeDb(); // release the shared handle the default-db test cached for tmpDir.
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

beforeEach(() => {
  db.$client.exec("DELETE FROM test_run_records;");
});

/** Minimal valid row; per-test overrides tune the cost/pricing columns. */
function baseRow(overrides: Partial<TestRunRecordInsert> = {}): TestRunRecordInsert {
  return {
    runId: "run-ledger-1",
    skill: "intake",
    createdAt: "2026-06-04",
    layer: "L1",
    provider: "deepseek",
    modelAlias: "deepseek-v4-flash",
    costUsd: null,
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    pricingSource: "table_v1",
    priceInputPerMtok: null,
    priceOutputPerMtok: null,
    promptVersion: null,
    schemaVersion: null,
    failReason: null,
    ...overrides,
  };
}

/** Read cost_usd straight from SQLite so we observe the stored type (NULL vs 0). */
function rawCostUsd(id: number): unknown {
  return (
    db.$client
      .prepare("SELECT cost_usd FROM test_run_records WHERE id = ?")
      .get(id) as { cost_usd: unknown }
  ).cost_usd;
}

describe("writeTestRunRecord — NULL-not-$0 round-trip", () => {
  it("stores costUsd: null + pricing_source 'unavailable' as SQL NULL, never 0", () => {
    const id = writeTestRunRecord(
      baseRow({ costUsd: null, pricingSource: "unavailable", failReason: "usage_missing" }),
      db,
    );
    const stored = rawCostUsd(id);
    expect(stored).toBeNull();
    expect(stored).not.toBe(0); // the silent-$0 bug would surface here as 0.
  });

  it("round-trips a normal row with a real costUsd", () => {
    const id = writeTestRunRecord(
      baseRow({ costUsd: 0.0123, pricingSource: "table_v1", inputTokens: 1000, outputTokens: 250 }),
      db,
    );
    expect(rawCostUsd(id)).toBe(0.0123);

    const row = db.$client
      .prepare("SELECT input_tokens, output_tokens, pricing_source FROM test_run_records WHERE id = ?")
      .get(id) as { input_tokens: number; output_tokens: number; pricing_source: string };
    expect(row.input_tokens).toBe(1000);
    expect(row.output_tokens).toBe(250);
    expect(row.pricing_source).toBe("table_v1");
  });

  it("returns the DB-assigned autoincrement id", () => {
    const first = writeTestRunRecord(baseRow(), db);
    const second = writeTestRunRecord(baseRow(), db);
    expect(typeof first).toBe("number");
    expect(second).toBe(first + 1);
  });

  it("default db param writes through the SHARED getDb() connection (same file)", () => {
    // No db argument: the writer falls back to getDb(), which resolves the
    // same AUTOBROKER_DATA_DIR file this suite opened — the row must be
    // visible through the suite's own handle (one shared connection per
    // resolved path, not a fresh leaked connection per call).
    const id = writeTestRunRecord(baseRow({ costUsd: 0.5, pricingSource: "table_v1" }));
    expect(rawCostUsd(id)).toBe(0.5);
  });
});

describe("writeTestRunRecord — fail-LOUD silent-$0 guard", () => {
  it("throws SilentZeroCostError on costUsd 0 + pricing_source 'unavailable'", () => {
    expect(() =>
      writeTestRunRecord(baseRow({ costUsd: 0, pricingSource: "unavailable" }), db),
    ).toThrow(SilentZeroCostError);
  });

  it("writes NOTHING when the guard fires (zero side effect)", () => {
    expect(() =>
      writeTestRunRecord(baseRow({ costUsd: 0, pricingSource: "unavailable" }), db),
    ).toThrow(SilentZeroCostError);
    const count = (
      db.$client.prepare("SELECT COUNT(*) AS n FROM test_run_records").get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });

  it("ALLOWS costUsd 0 with a real pricing_source (genuinely-free call)", () => {
    const id = writeTestRunRecord(baseRow({ costUsd: 0, pricingSource: "table_v1" }), db);
    expect(rawCostUsd(id)).toBe(0);
  });
});
