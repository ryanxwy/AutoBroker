/**
 * L1 unit test — the profile-scoped inventory ranking glue for
 * /inventory_compare. Freezes:
 *   - hard filters run before scoring (ordered listings + over-budget listings
 *     are absent from the candidates);
 *   - the FULL 17-char vin is preserved on the flat candidate (never tail-only);
 *   - the recommended predicate (match exact/near AND inventory in_stock/
 *     in_transit AND score >= 0.6);
 *   - scannedAtMax is the max last_seen_at over the candidates;
 *   - a missing profile yields an empty result (defensive).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/restored);
 * the committed migration SQL runs against the throwaway DB. NEVER touches
 * ~/.autobroker-ts or ~/.autobroker.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, openDb, type Db } from "@autobroker/db";
import { rankInventoryForProfile } from "./compute.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

const PROFILE_ID = "profile-compute-1";
const DEALER_NEAR = "dealer-near";

/** A full 17-char VIN (the display invariant — never tail-only). */
const FULL_VIN = "KM8JBCAE3RU000001";

function seedProfile(over: {
  budgetMax?: number | null;
  trim?: string | null;
  acceptableTrimsJson?: string | null;
  preferredExteriorColorsJson?: string | null;
} = {}): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, trim, " +
        "budget_max, search_radius_miles, preferred_exterior_colors_json, " +
        "acceptable_trims_json, account_id, brand, status) " +
        "VALUES (?, 2026, 'Hyundai', 'Tucson', ?, ?, 25, ?, ?, 'acct-test-1', 'Hyundai', 'active')",
    )
    .run(
      PROFILE_ID,
      over.trim ?? "Limited",
      over.budgetMax === undefined ? 50000 : over.budgetMax,
      over.preferredExteriorColorsJson ?? null,
      over.acceptableTrimsJson ?? null,
    );
}

function insertDealer(dealerId: string, name: string, distanceMiles: number | null): void {
  db.$client
    .prepare(
      "INSERT INTO dealers (dealer_id, name, distance_miles, country) VALUES (?, ?, ?, 'US')",
    )
    .run(dealerId, name, distanceMiles);
}

function insertListing(opts: {
  listingId: string;
  vin?: string | null;
  stockNumber?: string | null;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
  exteriorColor?: string | null;
  interiorColor?: string | null;
  msrp?: number | null;
  listedPrice?: number | null;
  dealerMarkup?: number | null;
  pricingBreakdownJson?: string | null;
  inventoryStatus?: string;
  lastSeenAt?: string;
}): void {
  db.$client
    .prepare(
      "INSERT INTO inventory_listings " +
        "(listing_id, search_profile_id, dealer_id, vin, stock_number, year, make, model, trim, " +
        "exterior_color, interior_color, msrp, listed_price, dealer_markup, pricing_breakdown_json, " +
        "inventory_status, match_status, raw_listing_json, first_seen_at, last_seen_at, observed_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'exact', '{}', '2026-06-01', ?, '2026-06-01')",
    )
    .run(
      opts.listingId,
      PROFILE_ID,
      DEALER_NEAR,
      opts.vin ?? null,
      opts.stockNumber ?? null,
      opts.year ?? 2026,
      opts.make ?? "Hyundai",
      opts.model ?? "Tucson",
      opts.trim ?? "Limited",
      opts.exteriorColor ?? null,
      opts.interiorColor ?? null,
      opts.msrp ?? null,
      opts.listedPrice ?? null,
      opts.dealerMarkup ?? null,
      opts.pricingBreakdownJson ?? null,
      opts.inventoryStatus ?? "in_stock",
      opts.lastSeenAt ?? "2026-06-01",
    );
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-invcompute-"));
  mkdirSync(tmpDir, { recursive: true });
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  // 0004 adds inventory_listings.dealer_markup + pricing_breakdown_json — needed
  // for the new pricing-projection rows.
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
    "DELETE FROM inventory_listings; DELETE FROM dealers; DELETE FROM search_profiles;",
  );
});

describe("rankInventoryForProfile", () => {
  it("drops ordered + over-budget listings before scoring, preserves the full vin, and keeps null prices", () => {
    seedProfile({ budgetMax: 40000 });
    insertDealer(DEALER_NEAR, "Near Hyundai", 5.0);

    // Kept: exact-trim in-stock with a full VIN, under budget.
    insertListing({
      listingId: "lst_keep",
      vin: FULL_VIN,
      stockNumber: "STK-1",
      exteriorColor: "Shimmering Silver",
      msrp: 38000,
      listedPrice: 36000,
    });
    // Dropped: ordered status.
    insertListing({ listingId: "lst_ordered", inventoryStatus: "ordered", listedPrice: 36000 });
    // Dropped: over budget (listed 45000 > 1.10 * 40000 = 44000).
    insertListing({ listingId: "lst_pricey", listedPrice: 45000 });
    // Kept: null listed_price passes the budget filter.
    insertListing({ listingId: "lst_nullprice", stockNumber: null, listedPrice: null });

    const { candidates, totalListings } = rankInventoryForProfile(db, PROFILE_ID);
    const ids = candidates.map((c) => c.listing_id);

    expect(totalListings).toBe(2);
    expect(ids).toContain("lst_keep");
    expect(ids).toContain("lst_nullprice");
    expect(ids).not.toContain("lst_ordered");
    expect(ids).not.toContain("lst_pricey");

    const keep = candidates.find((c) => c.listing_id === "lst_keep")!;
    // The full 17-char VIN is preserved verbatim.
    expect(keep.vin).toBe(FULL_VIN);
    expect(keep.vin).toHaveLength(17);
    expect(keep.stock_number).toBe("STK-1");
    expect(keep.dealer_name).toBe("Near Hyundai");
    expect(keep.distance_miles).toBe(5.0);

    const nullPrice = candidates.find((c) => c.listing_id === "lst_nullprice")!;
    expect(nullPrice.listed_price).toBeNull();
    expect(nullPrice.stock_number).toBeNull();
  });

  it("counts a recommended candidate (exact match, in_stock, score >= 0.6) and excludes a mismatch", () => {
    seedProfile({ budgetMax: null, preferredExteriorColorsJson: JSON.stringify(["Shimmering Silver"]) });
    insertDealer(DEALER_NEAR, "Near Hyundai", 0.0);

    // A strong recommended candidate: exact identity + trim, preferred color,
    // near, priced just under MSRP → composite well above 0.6.
    insertListing({
      listingId: "lst_strong",
      vin: FULL_VIN,
      exteriorColor: "Shimmering Silver",
      msrp: 46500,
      listedPrice: 44175,
      inventoryStatus: "in_stock",
    });
    // A mismatch (different model) → not recommended (match_status mismatch).
    insertListing({
      listingId: "lst_mismatch",
      model: "Santa Fe",
      msrp: 46500,
      listedPrice: 44175,
      inventoryStatus: "in_stock",
    });

    const { candidates, recommendedCount } = rankInventoryForProfile(db, PROFILE_ID);

    const strong = candidates.find((c) => c.listing_id === "lst_strong")!;
    expect(strong.match_status).toBe("exact");
    expect(strong.score).toBeGreaterThanOrEqual(0.6);
    expect(strong.reasons).toContain("trim_exact");
    expect(strong.reasons).toContain("preferred_color");
    // The per-candidate recommended flag is true for the strong candidate.
    expect(strong.recommended).toBe(true);

    const mismatch = candidates.find((c) => c.listing_id === "lst_mismatch")!;
    expect(mismatch.match_status).toBe("mismatch");
    // The per-candidate recommended flag is false for the mismatch.
    expect(mismatch.recommended).toBe(false);

    // Only the strong candidate satisfies all three recommended conditions.
    expect(recommendedCount).toBe(1);
    // recommendedCount equals the count of candidates with recommended === true.
    expect(candidates.filter((c) => c.recommended).length).toBe(recommendedCount);
  });

  it("recommends a compatible richer-variant trim (buyer 'XLE', lot has 'XLE Premium') — the 0/142 fix", () => {
    // The buyer asked for "XLE"; the lot carries only "XLE Premium" (a richer
    // XLE-family trim). Under exact-only matching this scored trim_off (0.0) and
    // capped below the 0.6 recommend floor → 0 recommended. The compatible tier
    // lifts it to a near-match so it is recommendable.
    seedProfile({
      trim: "XLE",
      budgetMax: null,
      preferredExteriorColorsJson: JSON.stringify(["Shimmering Silver"]),
    });
    insertDealer(DEALER_NEAR, "Near Toyota", 0.0);
    insertListing({
      listingId: "lst_premium",
      vin: FULL_VIN,
      trim: "XLE Premium",
      exteriorColor: "Shimmering Silver",
      msrp: 46500,
      listedPrice: 44175,
      inventoryStatus: "in_stock",
    });

    const { candidates, recommendedCount } = rankInventoryForProfile(db, PROFILE_ID);
    const premium = candidates.find((c) => c.listing_id === "lst_premium")!;
    expect(premium.reasons).toContain("trim_compatible");
    // A compatible variant is a near-match (NOT exact), but still recommendable.
    expect(premium.match_status).toBe("near");
    expect(premium.score).toBeGreaterThanOrEqual(0.6);
    expect(premium.recommended).toBe(true);
    expect(recommendedCount).toBe(1);
  });

  it("does not recommend an in_transit-only / out-of-stock listing below the inventory-status set", () => {
    seedProfile({ budgetMax: null });
    insertDealer(DEALER_NEAR, "Near Hyundai", 0.0);
    // Exact + high score but inventory_status 'sold' → not in the recommended set.
    insertListing({
      listingId: "lst_sold",
      vin: FULL_VIN,
      msrp: 46500,
      listedPrice: 44175,
      inventoryStatus: "sold",
    });

    const { candidates, recommendedCount, totalListings } = rankInventoryForProfile(db, PROFILE_ID);
    expect(totalListings).toBe(1);
    expect(recommendedCount).toBe(0);
    // The per-candidate flag also reflects false.
    expect(candidates[0]!.recommended).toBe(false);
  });

  it("reports the max last_seen_at over the candidates as scannedAtMax", () => {
    seedProfile({ budgetMax: null });
    insertDealer(DEALER_NEAR, "Near Hyundai", 0.0);
    insertListing({ listingId: "lst_old", listedPrice: 30000, lastSeenAt: "2026-06-01T00:00:00Z" });
    insertListing({ listingId: "lst_new", listedPrice: 30000, lastSeenAt: "2026-06-10T00:00:00Z" });

    const { scannedAtMax } = rankInventoryForProfile(db, PROFILE_ID);
    expect(scannedAtMax).toBe("2026-06-10T00:00:00Z");
  });

  it("projects dealer_markup and interior_color from the listing row", () => {
    seedProfile({ budgetMax: null });
    insertDealer(DEALER_NEAR, "Near Hyundai", 0.0);
    insertListing({
      listingId: "lst_markup",
      vin: FULL_VIN,
      interiorColor: "Gray Cloth",
      msrp: 38000,
      listedPrice: 41000,
      dealerMarkup: 3000,
    });

    const { candidates } = rankInventoryForProfile(db, PROFILE_ID);
    const row = candidates.find((c) => c.listing_id === "lst_markup")!;
    expect(row.dealer_markup).toBe(3000);
    expect(row.interior_color).toBe("Gray Cloth");
  });

  it("parses a populated pricing_breakdown_json into add_ons/addons_total/price_gated/breakdown_parsed and drops malformed entries", () => {
    seedProfile({ budgetMax: null });
    insertDealer(DEALER_NEAR, "Near Hyundai", 0.0);
    insertListing({
      listingId: "lst_breakdown",
      vin: FULL_VIN,
      listedPrice: 36000,
      pricingBreakdownJson: JSON.stringify({
        addOns: [
          { label: "Nitrogen tires", amount: 299 },
          { label: "Paint protection", amount: 1295 },
          // malformed entries (missing/typed-wrong amount/label) are dropped:
          { label: "No amount" },
          { amount: 500 },
          { label: 7, amount: 100 },
        ],
        addonsTotal: 1594,
        priceGated: true,
        breakdownParsed: true,
      }),
    });

    const { candidates } = rankInventoryForProfile(db, PROFILE_ID);
    const row = candidates.find((c) => c.listing_id === "lst_breakdown")!;
    expect(row.add_ons).toEqual([
      { label: "Nitrogen tires", amount: 299 },
      { label: "Paint protection", amount: 1295 },
    ]);
    expect(row.addons_total).toBe(1594);
    expect(row.price_gated).toBe(true);
    expect(row.breakdown_parsed).toBe(true);
  });

  it("treats a null pricing_breakdown_json as the honest 'not captured' default", () => {
    seedProfile({ budgetMax: null });
    insertDealer(DEALER_NEAR, "Near Hyundai", 0.0);
    insertListing({ listingId: "lst_nobreakdown", vin: FULL_VIN, listedPrice: 36000 });

    const { candidates } = rankInventoryForProfile(db, PROFILE_ID);
    const row = candidates.find((c) => c.listing_id === "lst_nobreakdown")!;
    expect(row.add_ons).toEqual([]);
    expect(row.addons_total).toBeNull();
    expect(row.price_gated).toBe(false);
    expect(row.breakdown_parsed).toBe(false);
    expect(row.dealer_markup).toBeNull();
  });

  it("does not throw on a malformed pricing_breakdown_json, falling back to the not-captured default", () => {
    seedProfile({ budgetMax: null });
    insertDealer(DEALER_NEAR, "Near Hyundai", 0.0);
    insertListing({
      listingId: "lst_badjson",
      vin: FULL_VIN,
      listedPrice: 36000,
      pricingBreakdownJson: "{not valid json",
    });

    expect(() => rankInventoryForProfile(db, PROFILE_ID)).not.toThrow();
    const { candidates } = rankInventoryForProfile(db, PROFILE_ID);
    const row = candidates.find((c) => c.listing_id === "lst_badjson")!;
    expect(row.add_ons).toEqual([]);
    expect(row.breakdown_parsed).toBe(false);
  });

  it("returns an empty result for a missing profile", () => {
    const result = rankInventoryForProfile(db, "no-such-profile");
    expect(result).toEqual({
      candidates: [],
      scannedAtMax: null,
      totalListings: 0,
      recommendedCount: 0,
      sourcesScanned: 0,
      sourcesBlocked: 0,
      allInventoryTrims: [],
    });
  });
});
