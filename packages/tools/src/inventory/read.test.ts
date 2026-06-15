/**
 * L1 unit test — the listings read helper for /inventory_compare. Freezes:
 *   - live listings for a profile are returned with the dealer name + distance
 *     stapled via the LEFT JOIN;
 *   - a listing whose dealer is absent (or whose dealer row is missing) yields a
 *     null distance, never a crash;
 *   - the dealerDistances map is keyed by dealer_id;
 *   - superseded rows (superseded_at NOT NULL) are excluded.
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
import { listListingsForProfile } from "./read.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

const PROFILE_ID = "profile-read-1";
const OTHER_PROFILE_ID = "profile-read-2";
const DEALER_NEAR = "dealer-near";

function insertDealer(dealerId: string, name: string, distanceMiles: number | null): void {
  db.$client
    .prepare(
      "INSERT INTO dealers (dealer_id, name, distance_miles, country) VALUES (?, ?, ?, 'US')",
    )
    .run(dealerId, name, distanceMiles);
}

function insertListing(opts: {
  listingId: string;
  searchProfileId: string;
  dealerId: string;
  supersededAt?: string | null;
}): void {
  db.$client
    .prepare(
      "INSERT INTO inventory_listings " +
        "(listing_id, search_profile_id, dealer_id, inventory_status, match_status, " +
        "raw_listing_json, first_seen_at, last_seen_at, observed_at, superseded_at) " +
        "VALUES (?, ?, ?, 'in_stock', 'exact', '{}', '2026-06-01', '2026-06-01', '2026-06-01', ?)",
    )
    .run(opts.listingId, opts.searchProfileId, opts.dealerId, opts.supersededAt ?? null);
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-invread-"));
  mkdirSync(tmpDir, { recursive: true });
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
  db.$client.exec("DELETE FROM inventory_listings; DELETE FROM dealers;");
});

describe("listListingsForProfile", () => {
  it("returns live rows with dealer name + distance stapled, and a distance map", () => {
    insertDealer(DEALER_NEAR, "Near Hyundai", 12.5);
    // Listing whose dealer has a distance.
    insertListing({ listingId: "lst_a", searchProfileId: PROFILE_ID, dealerId: DEALER_NEAR });
    // Listing whose dealer row is absent (no dealers row → LEFT JOIN nulls).
    insertListing({ listingId: "lst_b", searchProfileId: PROFILE_ID, dealerId: "dealer-missing" });

    const { listings, dealerDistances } = listListingsForProfile(db, PROFILE_ID);

    expect(listings).toHaveLength(2);
    const byId = new Map(listings.map((r) => [r["listing_id"], r]));

    const a = byId.get("lst_a")!;
    expect(a["dealer_name"]).toBe("Near Hyundai");
    expect(a["distance_miles"]).toBe(12.5);

    const b = byId.get("lst_b")!;
    expect(b["dealer_name"]).toBeNull();
    expect(b["distance_miles"]).toBeNull();

    expect(dealerDistances).toEqual({
      [DEALER_NEAR]: 12.5,
      "dealer-missing": null,
    });
  });

  it("excludes superseded rows", () => {
    insertDealer(DEALER_NEAR, "Near Hyundai", 5.0);
    insertListing({ listingId: "lst_live", searchProfileId: PROFILE_ID, dealerId: DEALER_NEAR });
    insertListing({
      listingId: "lst_dead",
      searchProfileId: PROFILE_ID,
      dealerId: DEALER_NEAR,
      supersededAt: "2026-06-02",
    });

    const { listings } = listListingsForProfile(db, PROFILE_ID);
    expect(listings.map((r) => r["listing_id"])).toEqual(["lst_live"]);
  });

  it("scopes to the requested profile only", () => {
    insertDealer(DEALER_NEAR, "Near Hyundai", 5.0);
    insertListing({ listingId: "lst_mine", searchProfileId: PROFILE_ID, dealerId: DEALER_NEAR });
    insertListing({ listingId: "lst_other", searchProfileId: OTHER_PROFILE_ID, dealerId: DEALER_NEAR });

    const { listings } = listListingsForProfile(db, PROFILE_ID);
    expect(listings.map((r) => r["listing_id"])).toEqual(["lst_mine"]);
  });

  it("returns empty results for a profile with no listings", () => {
    const { listings, dealerDistances } = listListingsForProfile(db, "profile-none");
    expect(listings).toEqual([]);
    expect(dealerDistances).toEqual({});
  });
});
