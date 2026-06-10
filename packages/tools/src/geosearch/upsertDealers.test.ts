/**
 * L1 unit tests — the dealer_geosearch write path. Freezes:
 *   - dealers upsert by dealer_id PK (insert vs refresh-in-place);
 *   - website trailing-slash strip; country left to the DB DEFAULT 'US';
 *   - profile_dealers candidate registration is INSERT OR IGNORE — an
 *     existing row of ANY status survives re-discovery unchanged (a 'bound'
 *     row is the load-bearing case);
 *   - the inline US hard gate: non-US rows skipped + counted, never written;
 *   - the whole batch is one transaction.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved /
 * restored); the committed migration SQL runs against the throwaway DB.
 * NEVER touches ~/.autobroker-ts or ~/.autobroker.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, openDb, type Db } from "@autobroker/db";
import { dealerId, type RankedDealerCandidate } from "./pure.js";
import { upsertDealers } from "./upsertDealers.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

const PROFILE_ID = "profile-geo-1";

function rankedCandidate(
  overrides: Partial<RankedDealerCandidate> = {},
): RankedDealerCandidate {
  return {
    name: "Alpha Hyundai",
    address: "123 Auto Center Dr",
    phone: "(949) 555-0100",
    website: "https://alphahyundai.com",
    google_place_id: "0xdead:0xbeef",
    latitude: 33.68,
    longitude: -117.83,
    rating: 4.5,
    review_count: 1234,
    type_line: "Hyundai dealer",
    sponsored: false,
    service_center: false,
    distance_miles: 3.2,
    ...overrides,
  };
}

function dealerRow(id: string): Record<string, unknown> | undefined {
  return db.$client.prepare("SELECT * FROM dealers WHERE dealer_id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
}

function profileDealerRow(id: string): { status: string } | undefined {
  return db.$client
    .prepare(
      "SELECT status FROM profile_dealers WHERE search_profile_id = ? AND dealer_id = ?",
    )
    .get(PROFILE_ID, id) as { status: string } | undefined;
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-geosearch-"));
  mkdirSync(tmpDir, { recursive: true });
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  // Apply the committed migrations in order (0000 creates dealers +
  // profile_dealers; 0001 adds the restored composite UNIQUE indexes).
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
  db.$client.exec("DELETE FROM profile_dealers; DELETE FROM dealers;");
});

describe("upsertDealers — dealers upsert by dealer_id", () => {
  it("inserts a new dealer and registers a candidate row", () => {
    const c = rankedCandidate();
    const result = upsertDealers([c], PROFILE_ID, db);
    expect(result).toEqual({
      inserted: 1,
      updated: 0,
      candidatesRegistered: 1,
      nonUsSkipped: 0,
      unnamedSkipped: 0,
    });

    const id = dealerId(c);
    const row = dealerRow(id);
    expect(row).toBeDefined();
    expect(row!.name).toBe("Alpha Hyundai");
    expect(row!.distance_miles).toBe(3.2);
    expect(profileDealerRow(id)?.status).toBe("candidate");
  });

  it("updates an existing dealer in place (same dealer_id)", () => {
    upsertDealers([rankedCandidate({ phone: "(949) 555-0100" })], PROFILE_ID, db);
    const result = upsertDealers(
      [rankedCandidate({ name: "Alpha Hyundai of Irvine", phone: "(949) 555-0200" })],
      PROFILE_ID,
      db,
    );
    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(1);

    const row = dealerRow(dealerId(rankedCandidate()));
    expect(row!.name).toBe("Alpha Hyundai of Irvine");
    expect(row!.phone).toBe("(949) 555-0200");
    // Only one dealers row exists.
    const n = (db.$client.prepare("SELECT COUNT(*) AS n FROM dealers").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it("strips trailing slashes off the stored website", () => {
    const c = rankedCandidate({ website: "https://example.com/" });
    upsertDealers([c], PROFILE_ID, db);
    expect(dealerRow(dealerId(c))!.website).toBe("https://example.com");
  });

  it("preserves a null website", () => {
    const c = rankedCandidate({ website: null });
    upsertDealers([c], PROFILE_ID, db);
    expect(dealerRow(dealerId(c))!.website).toBeNull();
  });

  it("never writes country — the DB DEFAULT 'US' fills it on insert", () => {
    const c = rankedCandidate();
    upsertDealers([c], PROFILE_ID, db);
    expect(dealerRow(dealerId(c))!.country).toBe("US");
  });
});

describe("upsertDealers — candidate registration no-op semantics", () => {
  it("a 'bound' row survives re-discovery unchanged", () => {
    const c = rankedCandidate();
    const id = dealerId(c);
    upsertDealers([c], PROFILE_ID, db);
    // Simulate a later bind.
    db.$client
      .prepare(
        "UPDATE profile_dealers SET status = 'bound' WHERE search_profile_id = ? AND dealer_id = ?",
      )
      .run(PROFILE_ID, id);

    const result = upsertDealers([c], PROFILE_ID, db);
    expect(result.candidatesRegistered).toBe(0);
    expect(profileDealerRow(id)?.status).toBe("bound");
  });

  it("is a no-op for ANY existing status (excluded_conflict stays put)", () => {
    const c = rankedCandidate();
    const id = dealerId(c);
    upsertDealers([c], PROFILE_ID, db);
    db.$client
      .prepare(
        "UPDATE profile_dealers SET status = 'excluded_conflict', exclusion_reason = 'r' " +
          "WHERE search_profile_id = ? AND dealer_id = ?",
      )
      .run(PROFILE_ID, id);

    upsertDealers([c], PROFILE_ID, db);
    const row = db.$client
      .prepare(
        "SELECT status, exclusion_reason FROM profile_dealers WHERE search_profile_id = ? AND dealer_id = ?",
      )
      .get(PROFILE_ID, id) as { status: string; exclusion_reason: string };
    expect(row.status).toBe("excluded_conflict");
    expect(row.exclusion_reason).toBe("r");
  });

  it("re-running the same batch registers zero new candidates (idempotent)", () => {
    const batch = [
      rankedCandidate({ google_place_id: "0xa:0x1", name: "D1" }),
      rankedCandidate({ google_place_id: "0xa:0x2", name: "D2" }),
    ];
    const first = upsertDealers(batch, PROFILE_ID, db);
    expect(first.inserted).toBe(2);
    expect(first.candidatesRegistered).toBe(2);

    const second = upsertDealers(batch, PROFILE_ID, db);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(2);
    expect(second.candidatesRegistered).toBe(0);
  });
});

describe("upsertDealers — inline US hard gate", () => {
  it("skips + counts a non-US row WITHOUT writing it", () => {
    const canadian = rankedCandidate({
      name: "Maple Hyundai",
      website: "https://maplehyundai.ca",
      google_place_id: "0xca:0x1",
    });
    const us = rankedCandidate({ google_place_id: "0xus:0x1" });
    const result = upsertDealers([canadian, us], PROFILE_ID, db);
    expect(result.nonUsSkipped).toBe(1);
    expect(result.inserted).toBe(1);
    expect(dealerRow(dealerId(canadian))).toBeUndefined();
    expect(profileDealerRow(dealerId(canadian))).toBeUndefined();
  });

  it("skips + counts a Canadian-city dealer name", () => {
    const c = rankedCandidate({
      name: "Bannister Kia Chilliwack",
      website: null,
      google_place_id: "0xca:0x2",
    });
    const result = upsertDealers([c], PROFILE_ID, db);
    expect(result.nonUsSkipped).toBe(1);
    expect(dealerRow(dealerId(c))).toBeUndefined();
  });
});

describe("upsertDealers — unnamed rows", () => {
  it("skips + counts a row without a name (dealers.name is NOT NULL)", () => {
    const unnamed = rankedCandidate({ name: null, google_place_id: "0xnn:0x1" });
    const result = upsertDealers([unnamed], PROFILE_ID, db);
    expect(result.unnamedSkipped).toBe(1);
    expect(result.inserted).toBe(0);
    expect(dealerRow(dealerId(unnamed))).toBeUndefined();
  });
});
