/**
 * L1 unit tests — the incentive persist writer. Freezes:
 *   - DELETE-then-INSERT replaces the (make, model, zip) slice as a unit
 *     (re-scan never duplicates — the table has no natural unique key);
 *   - a mid-insert failure rolls the WHOLE block back: the previous rows
 *     survive untouched (the transaction-rollback contract);
 *   - an empty row set is a legal refresh (stale offers cleared);
 *   - other slices (different zip / model) are never touched;
 *   - slice matching is case-insensitive on make/model;
 *   - the cache-state read returns the NEWEST marker (and feeds the pure
 *     7-day gate end-to-end).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; the
 * committed migration SQL runs against the throwaway DB. NEVER touches
 * ~/.autobroker-ts or ~/.autobroker.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/db";
import type { Incentive } from "@autobroker/core";

import { cacheGateDecision } from "./pure.js";
import { persistIncentives, readIncentiveCacheState } from "./persist.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

const KEY = { make: "Hyundai", model: "Tucson Hybrid", zip: "92614" };
const URL_A = "https://www.hyundaiusa.com/us/en/offers?zip=92614&model=Tucson%20Hybrid";
const T1 = "2026-06-10T00:00:00.000Z";
const T2 = "2026-06-12T00:00:00.000Z";

function row(overrides: Partial<Incentive> = {}): Incentive {
  return { type: "customer_cash", amount: 1500, expires: "2026-07-06", eligibility: "all", ...overrides };
}

function sliceRows(): Array<Record<string, unknown>> {
  return db.$client
    .prepare(
      "SELECT * FROM manufacturer_incentives WHERE make = ? AND model = ? AND zip = ? ORDER BY id",
    )
    .all(KEY.make, KEY.model, KEY.zip) as Array<Record<string, unknown>>;
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-incpersist-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
});

afterAll(() => {
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

beforeEach(() => {
  db.$client.prepare("DELETE FROM manufacturer_incentives").run();
});

describe("persistIncentives (DELETE-then-INSERT, one transaction)", () => {
  it("writes the slice and stamps run provenance on every row", () => {
    const written = persistIncentives({
      ...KEY,
      rows: [row(), row({ type: "loyalty", amount: 500, expires: null, eligibility: "current_brand_owner" })],
      scrapeSourceUrl: URL_A,
      scrapedAt: T1,
      db,
    });
    expect(written).toBe(2);
    const rows = sliceRows();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r["scraped_at"]).toBe(T1);
      expect(r["scrape_source_url"]).toBe(URL_A);
    }
    expect(rows[1]!["expires"]).toBeNull(); // null expiry persists as NULL
  });

  it("a re-scan replaces the slice — never duplicates (programmatic idempotency)", () => {
    persistIncentives({ ...KEY, rows: [row(), row({ type: "military" })], scrapeSourceUrl: URL_A, scrapedAt: T1, db });
    persistIncentives({ ...KEY, rows: [row({ amount: 2000 })], scrapeSourceUrl: URL_A, scrapedAt: T2, db });
    const rows = sliceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["amount"]).toBe(2000);
    expect(rows[0]!["scraped_at"]).toBe(T2);
  });

  it("an empty row set is a legal refresh that clears stale offers", () => {
    persistIncentives({ ...KEY, rows: [row()], scrapeSourceUrl: URL_A, scrapedAt: T1, db });
    persistIncentives({ ...KEY, rows: [], scrapeSourceUrl: URL_A, scrapedAt: T2, db });
    expect(sliceRows()).toHaveLength(0);
  });

  it("mid-insert failure rolls the WHOLE block back — previous rows survive", () => {
    persistIncentives({ ...KEY, rows: [row({ amount: 999 })], scrapeSourceUrl: URL_A, scrapedAt: T1, db });
    // Second row violates NOT NULL(type) → the INSERT throws mid-transaction.
    const poisoned = [row({ amount: 2000 }), { ...row(), type: null } as unknown as Incentive];
    expect(() =>
      persistIncentives({ ...KEY, rows: poisoned, scrapeSourceUrl: URL_A, scrapedAt: T2, db }),
    ).toThrow();
    const rows = sliceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["amount"]).toBe(999); // the pre-refresh truth, untouched
    expect(rows[0]!["scraped_at"]).toBe(T1);
  });

  it("never touches a sibling slice (different zip / different model)", () => {
    persistIncentives({ ...KEY, rows: [row()], scrapeSourceUrl: URL_A, scrapedAt: T1, db });
    persistIncentives({ ...KEY, zip: "90001", rows: [row({ amount: 750 })], scrapeSourceUrl: URL_A, scrapedAt: T1, db });
    persistIncentives({ ...KEY, rows: [row({ amount: 2000 })], scrapeSourceUrl: URL_A, scrapedAt: T2, db });
    const other = db.$client
      .prepare("SELECT amount FROM manufacturer_incentives WHERE zip = '90001'")
      .all() as Array<{ amount: number }>;
    expect(other).toEqual([{ amount: 750 }]);
  });

  it("slice matching is case-insensitive on make/model (one logical slice)", () => {
    persistIncentives({ ...KEY, rows: [row()], scrapeSourceUrl: URL_A, scrapedAt: T1, db });
    persistIncentives({
      make: "hyundai",
      model: "TUCSON HYBRID",
      zip: KEY.zip,
      rows: [row({ amount: 2000 })],
      scrapeSourceUrl: URL_A,
      scrapedAt: T2,
      db,
    });
    const all = db.$client
      .prepare("SELECT amount FROM manufacturer_incentives WHERE zip = ?")
      .all(KEY.zip) as Array<{ amount: number }>;
    expect(all).toEqual([{ amount: 2000 }]);
  });
});

describe("readIncentiveCacheState → cacheGateDecision (end-to-end)", () => {
  it("a never-scraped slice reads null markers → scrape", () => {
    const state = readIncentiveCacheState(db, KEY);
    expect(state).toEqual({ latestScrapedAt: null, latestSourceUrl: null });
    expect(cacheGateDecision(state, URL_A, T2)).toBe("scrape");
  });

  it("reads the NEWEST marker and skips a fresh same-URL slice", () => {
    persistIncentives({ ...KEY, rows: [row()], scrapeSourceUrl: URL_A, scrapedAt: T1, db });
    // A direct older row from a prior partial world must not win.
    db.$client
      .prepare(
        "INSERT INTO manufacturer_incentives (make, model, zip, type, amount, expires, eligibility, scraped_at, scrape_source_url) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(KEY.make, KEY.model, KEY.zip, "loyalty", 500, null, "all", "2026-06-01T00:00:00.000Z", "https://old.example.com/offers");
    const state = readIncentiveCacheState(db, KEY);
    expect(state).toEqual({ latestScrapedAt: T1, latestSourceUrl: URL_A });
    expect(cacheGateDecision(state, URL_A, "2026-06-12T00:00:00.000Z")).toBe("skip");
  });
});
