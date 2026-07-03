/**
 * L1 unit tests — the inventory_aggregator_scan persist closures. Freezes:
 *   - resolveOrMintDealer: exact + case/punctuation-normalized match against a
 *     profile-linked dealer; different-city same-name mints; mint is idempotent
 *     (same hash → one row); the minted row carries city/state/distance/country;
 *   - selectExistingVinOwners: live rows only (superseded excluded);
 *   - capTopListings: price ascending, nulls last, stable key tiebreak, cap;
 *   - collapseSameVinAcrossDealers: same VIN across dealers collapses to the
 *     non-aggregator row (else first), null VINs kept, collapses counted.
 *
 * ISOLATION: a throwaway os.tmpdir() AUTOBROKER_DATA_DIR + the committed
 * migration SQL, exactly like persist.test.ts. NEVER touches ~/.autobroker*.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, openDb, type Db } from "@autobroker/db";
import type { InventoryListing } from "@autobroker/core";
import { persistScanResults, type ClassifiedListingRow, type DealerScanOutcome } from "./persist.js";
import {
  capTopListings,
  collapseSameVinAcrossDealers,
  resolveOrMintDealer,
  selectExistingVinOwners,
} from "./aggregatorPersist.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

const PROFILE_ID = "profile-agg-1";
const DEALER_A = "aaaa111122223333";
const SRP_A = "https://alpha-hyundai.example/new-inventory/index.htm";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-aggpersist-"));
  mkdirSync(tmpDir, { recursive: true });
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0004_empty_celestials.sql"), "utf8"));
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
  db.$client.exec(
    "DELETE FROM inventory_listings; DELETE FROM dealer_inventory_sources; DELETE FROM profile_dealers; DELETE FROM dealers;",
  );
});

function listing(overrides: Partial<InventoryListing> = {}): InventoryListing {
  return {
    year: 2026,
    make: "Hyundai",
    model: "Tucson",
    trim: "SEL",
    vin: null,
    stock_number: null,
    price: 33999,
    exterior_color: "White",
    interior_color: null,
    inventory_status: "in_stock",
    listing_url: null,
    ...overrides,
  };
}

function row(overrides: Partial<InventoryListing> = {}): ClassifiedListingRow {
  return { listing: listing(overrides), matchStatus: "exact", raw: { via: "test" } };
}

function scanned(dealerId: string, sourceUrl: string, rows: ClassifiedListingRow[]): DealerScanOutcome {
  return { dealerId, sourceUrl, status: "scanned", rows };
}

function linkDealer(id: string, name: string, city: string, state: string): void {
  db.$client
    .prepare("INSERT INTO dealers (dealer_id, name, city, state, country) VALUES (?, ?, ?, ?, 'US')")
    .run(id, name, city, state);
  db.$client
    .prepare("INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'candidate')")
    .run(PROFILE_ID, id);
}

describe("resolveOrMintDealer", () => {
  it("EXACT match against a profile-linked dealer → matched_name_city", () => {
    linkDealer("dlr-existing", "Costa Mesa Toyota", "Costa Mesa", "CA");
    const r = resolveOrMintDealer(db, {
      profileId: PROFILE_ID,
      dealerName: "Costa Mesa Toyota",
      cityState: "Costa Mesa, CA",
      distanceMiles: 5,
    });
    expect(r).toEqual({ dealerId: "dlr-existing", method: "matched_name_city" });
    expect(db.$client.prepare("SELECT count(*) AS n FROM dealers").get()).toEqual({ n: 1 }); // no mint
  });

  it("case + punctuation + hyphen-vs-space differences still MATCH (normalized equality)", () => {
    linkDealer("dlr-existing", "Costa Mesa Toyota", "Costa Mesa", "CA");
    const r = resolveOrMintDealer(db, {
      profileId: PROFILE_ID,
      dealerName: "costa-mesa  TOYOTA!",
      cityState: "COSTA MESA, ca",
      distanceMiles: 5,
    });
    expect(r.method).toBe("matched_name_city");
    expect(r.dealerId).toBe("dlr-existing");
  });

  it("same name but a DIFFERENT city → mint (name+city+state must all match)", () => {
    linkDealer("dlr-existing", "Costa Mesa Toyota", "Costa Mesa", "CA");
    const r = resolveOrMintDealer(db, {
      profileId: PROFILE_ID,
      dealerName: "Costa Mesa Toyota",
      cityState: "Irvine, CA",
      distanceMiles: 8,
    });
    expect(r.method).toBe("minted");
    expect(r.dealerId).not.toBe("dlr-existing");
  });

  it("a linked dealer of ANOTHER profile is not matched → mint", () => {
    // Same dealers row, but linked to a different profile only.
    db.$client
      .prepare("INSERT INTO dealers (dealer_id, name, city, state, country) VALUES ('dlr-other', 'Other Toyota', 'Costa Mesa', 'CA', 'US')")
      .run();
    db.$client
      .prepare("INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES ('some-other-profile', 'dlr-other', 'candidate')")
      .run();
    const r = resolveOrMintDealer(db, {
      profileId: PROFILE_ID,
      dealerName: "Other Toyota",
      cityState: "Costa Mesa, CA",
      distanceMiles: 5,
    });
    expect(r.method).toBe("minted");
    expect(r.dealerId).not.toBe("dlr-other");
  });

  it("mint is idempotent — same tile twice yields the same id and a single row", () => {
    const args = {
      profileId: PROFILE_ID,
      dealerName: "New Brand Kia",
      cityState: "Anaheim, CA",
      distanceMiles: 12,
    } as const;
    const a = resolveOrMintDealer(db, args);
    const b = resolveOrMintDealer(db, args);
    expect(a.method).toBe("minted");
    expect(b.method).toBe("minted");
    expect(a.dealerId).toBe(b.dealerId);
    expect(
      db.$client.prepare("SELECT count(*) AS n FROM dealers WHERE dealer_id = ?").get(a.dealerId),
    ).toEqual({ n: 1 });
  });

  it("minted row carries verbatim name, normalized city/state, distance, country 'US'", () => {
    const r = resolveOrMintDealer(db, {
      profileId: PROFILE_ID,
      dealerName: "Zippy Mazda",
      cityState: "Tustin, CA",
      distanceMiles: 7.5,
    });
    const dealer = db.$client
      .prepare("SELECT * FROM dealers WHERE dealer_id = ?")
      .get(r.dealerId) as Record<string, unknown>;
    expect(dealer.name).toBe("Zippy Mazda"); // verbatim tile name
    expect(dealer.city).toBe("tustin"); // normalized
    expect(dealer.state).toBe("ca"); // normalized
    expect(dealer.distance_miles).toBe(7.5);
    expect(dealer.country).toBe("US");
  });
});

describe("selectExistingVinOwners", () => {
  const VIN_LIVE = "KM8J33A2XPU100901";
  const VIN_DEAD = "KM8J33A2XPU100902";

  it("returns the live owner and EXCLUDES superseded rows / absent VINs", () => {
    persistScanResults({
      searchProfileId: PROFILE_ID,
      runStartedAt: "2026-06-12T01:00:00.000Z",
      outcomes: [scanned(DEALER_A, SRP_A, [row({ vin: VIN_LIVE }), row({ vin: VIN_DEAD })])],
      db,
      now: "2026-06-12T01:05:00.000Z",
    });
    // Retire the DEAD vin's row.
    db.$client
      .prepare("UPDATE inventory_listings SET superseded_at = ?, superseded_reason = 'not_observed' WHERE vin = ?")
      .run("2026-06-12T02:00:00.000Z", VIN_DEAD);

    const owners = selectExistingVinOwners(db, PROFILE_ID, [VIN_LIVE, VIN_DEAD, "NOSUCHVIN00000000"]);
    expect(owners.size).toBe(1);
    expect(owners.get(VIN_LIVE)).toBe(DEALER_A);
    expect(owners.has(VIN_DEAD)).toBe(false);
    expect(owners.has("NOSUCHVIN00000000")).toBe(false);
  });

  it("returns an empty map for an empty VIN list (no query)", () => {
    expect(selectExistingVinOwners(db, PROFILE_ID, []).size).toBe(0);
  });
});

describe("capTopListings (pure)", () => {
  it("sorts price ascending with null prices LAST and caps the result", () => {
    const rows = [
      { price: 300, listingKey: "b" },
      { price: null, listingKey: "a" },
      { price: 100, listingKey: "z" },
      { price: 100, listingKey: "y" },
      { price: 200, listingKey: "c" },
    ];
    expect(capTopListings(rows, 3).map((r) => r.listingKey)).toEqual(["y", "z", "c"]);
    // Full sort (no cap): nulls last, ties broken by key ascending.
    expect(capTopListings(rows, 10).map((r) => r.listingKey)).toEqual(["y", "z", "c", "b", "a"]);
  });

  it("breaks null-vs-null ties by listing key (stable, deterministic)", () => {
    const rows = [
      { price: null, listingKey: "z" },
      { price: null, listingKey: "a" },
    ];
    expect(capTopListings(rows).map((r) => r.listingKey)).toEqual(["a", "z"]);
  });

  it("returns all rows when the cap exceeds the length; default cap is 10", () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({ price: i, listingKey: `k${i}` }));
    expect(capTopListings(rows)).toHaveLength(10); // default cap
    expect(capTopListings(rows, 100)).toHaveLength(14);
  });
});

describe("collapseSameVinAcrossDealers (pure)", () => {
  it("collapses a same-VIN aggregator+dealer pair to the dealer row and counts it", () => {
    const candidates = [
      { vin: "VIN1", dealer_id: "d-agg", source_type: "aggregator_srp" },
      { vin: "VIN1", dealer_id: "d-real", source_type: "srp" },
      { vin: null, dealer_id: "d-x", source_type: "aggregator_srp" },
      { vin: "VIN2", dealer_id: "d-agg2", source_type: "aggregator_srp" },
    ];
    const { rows, collapsedCount } = collapseSameVinAcrossDealers(candidates);
    expect(collapsedCount).toBe(1);
    expect(rows).toHaveLength(3);
    const vin1 = rows.find((r) => r.vin === "VIN1")!;
    expect(vin1.source_type).toBe("srp"); // the richer dealer-site row is kept
    expect(vin1.dealer_id).toBe("d-real");
    // The null-VIN row and the singleton VIN2 survive untouched.
    expect(rows.some((r) => r.vin === null)).toBe(true);
    expect(rows.some((r) => r.vin === "VIN2")).toBe(true);
  });

  it("all-aggregator group keeps the FIRST row (no non-aggregator to prefer)", () => {
    const candidates = [
      { vin: "V", dealer_id: "a", source_type: "aggregator_srp" },
      { vin: "V", dealer_id: "b", source_type: "aggregator_srp" },
    ];
    const { rows, collapsedCount } = collapseSameVinAcrossDealers(candidates);
    expect(collapsedCount).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dealer_id).toBe("a");
  });

  it("no duplicate VINs → nothing collapsed", () => {
    const candidates = [
      { vin: "A", dealer_id: "d1", source_type: "aggregator_srp" },
      { vin: "B", dealer_id: "d2", source_type: "srp" },
      { vin: null, dealer_id: "d3", source_type: "aggregator_srp" },
    ];
    const { rows, collapsedCount } = collapseSameVinAcrossDealers(candidates);
    expect(collapsedCount).toBe(0);
    expect(rows).toHaveLength(3);
  });
});
