/**
 * inventoryListings — the "ranked inventory" world: ONE active search profile
 * with bound dealers AND a set of inventory_listings, so the Canvas Inventory
 * candidates section projects ranked candidates (the /inventory_compare ranker
 * reads + scores them at render time; nothing is persisted).
 *
 * WHAT THIS SEEDS (only what the Inventory candidates panel renders):
 *   - 1 search_profiles row (status='active', account=acct-harness-1, brand=make,
 *     trim='Limited', budget_max so the over-budget filter has a cap)
 *   - 2 dealers + 2 profile_dealers bindings (for the distance axis + dealer name)
 *   - inventory_listings spanning the ranker's branches: an exact-trim in-stock
 *     row with a FULL 17-char VIN, a NULL listed_price row (the "incomplete"
 *     badge), a NULL stock_number row (the em-dash), an ORDERED row (dropped by
 *     the hard filter), and an over-budget row (dropped by the budget filter).
 *
 * EXPECTED RANKER OUTCOME: 3 candidates survive the hard filters (the in-stock
 * exact-trim row, the null-price row, the null-stock row); the ordered + the
 * over-budget rows are excluded. The func case asserts that exact count.
 */

import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

/** The one active profile id (deterministic — a fixed synthetic id). */
const PROFILE_ID = "inventory-tucson-1";
const DEALER_NEAR = "dealer-jim-click";
const DEALER_FAR = "dealer-precision";

/** A full 17-char VIN (the display invariant — never tail-only). */
const FULL_VIN = "KM8JBCAE3RU000042";

export const inventoryListings: FixtureState = {
  id: "inventory_listings",
  seed: (db: Db) => {
    const c = db.$client;

    // The active search. trim 'Limited' drives the trim-exact axis; budget_max
    // 45000 gives the over-budget filter a cap (1.10 * 45000 = 49500).
    c.prepare(
      "INSERT INTO search_profiles " +
        "(search_profile_id, year, make, model, trim, budget_max, search_radius_miles, " +
        "preferred_exterior_colors_json, location_query, city, state, postal_code, " +
        "latitude, longitude, financing_preference, phone_policy, account_id, brand, location, status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      PROFILE_ID,
      2026,
      "Hyundai",
      "Tucson Hybrid",
      "Limited",
      45000,
      50,
      JSON.stringify(["Shimmering Silver"]),
      "Tucson, AZ 85704",
      "Tucson",
      "AZ",
      "85704",
      32.3349,
      -110.9762,
      "finance",
      "fake",
      "acct-harness-1",
      "Hyundai",
      "Tucson, AZ 85704",
      "active",
    );

    // Two bound dealers — the distance axis + the dealer-name display.
    const dealers: Array<[string, string, string, number]> = [
      [DEALER_NEAR, "Jim Click Hyundai", "750 W Auto Mall Dr, Tucson, AZ", 4.2],
      [DEALER_FAR, "Precision Hyundai", "740 W Wetmore Rd, Tucson, AZ", 6.8],
    ];
    const insertDealer = c.prepare(
      "INSERT INTO dealers (dealer_id, name, address, city, state, postal_code, distance_miles, country) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'US')",
    );
    const bind = c.prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
    );
    for (const [id, name, address, distance] of dealers) {
      insertDealer.run(id, name, address, "Tucson", "AZ", "85704", distance);
      bind.run(PROFILE_ID, id);
    }

    // The inventory listings spanning the ranker branches.
    const insertListing = c.prepare(
      "INSERT INTO inventory_listings " +
        "(listing_id, search_profile_id, dealer_id, vin, stock_number, year, make, model, trim, " +
        "exterior_color, msrp, listed_price, inventory_status, match_status, raw_listing_json, " +
        "first_seen_at, last_seen_at, observed_at, interior_color, dealer_markup, pricing_breakdown_json) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?)",
    );
    // The strong candidate carries a LABELED dealer markup + a parsed add-on so
    // the Inventory detail modal has honest red/amber data to surface (the func
    // lane asserts the red markup row); the others leave the new columns null so
    // their cards stay flag-free.
    const STRONG_BREAKDOWN = JSON.stringify({
      addOns: [{ label: "Nitrogen tire fill", amount: 299 }],
      addonsTotal: 299,
      priceGated: false,
      breakdownParsed: true,
    });
    // (a) the strong candidate — exact trim, in stock, full VIN, under budget,
    //     preferred color, near dealer → top-ranked + recommended. Plus a $2,500
    //     labeled market adjustment + a $299 add-on (the breakdown red/amber flags).
    insertListing.run(
      "lst_strong",
      PROFILE_ID,
      DEALER_NEAR,
      FULL_VIN,
      "STK-A1",
      2026,
      "Hyundai",
      "Tucson Hybrid",
      "Limited",
      "Shimmering Silver",
      46500,
      44175,
      "in_stock",
      "exact",
      "2026-06-01",
      "2026-06-10",
      "2026-06-01",
      "Gray Cloth",
      2500,
      STRONG_BREAKDOWN,
    );
    // (b) a NULL listed_price row → the "incomplete" badge (passes the budget filter).
    insertListing.run(
      "lst_incomplete",
      PROFILE_ID,
      DEALER_FAR,
      "KM8JBCAE3RU000043",
      "STK-B2",
      2026,
      "Hyundai",
      "Tucson Hybrid",
      "SEL",
      "Black",
      45000,
      null,
      "in_stock",
      "near",
      "2026-06-01",
      "2026-06-05",
      "2026-06-01",
      null,
      null,
      null,
    );
    // (c) a NULL stock_number row → the em-dash.
    insertListing.run(
      "lst_nostock",
      PROFILE_ID,
      DEALER_FAR,
      "KM8JBCAE3RU000044",
      null,
      2026,
      "Hyundai",
      "Tucson Hybrid",
      "SEL",
      "White",
      44000,
      42000,
      "in_stock",
      "near",
      "2026-06-01",
      "2026-06-03",
      "2026-06-01",
      null,
      null,
      null,
    );
    // (d) an ORDERED row → dropped by the hard filter (never a candidate).
    insertListing.run(
      "lst_ordered",
      PROFILE_ID,
      DEALER_NEAR,
      "KM8JBCAE3RU000045",
      "STK-D4",
      2026,
      "Hyundai",
      "Tucson Hybrid",
      "Limited",
      "Blue",
      46500,
      43000,
      "ordered",
      "exact",
      "2026-06-01",
      "2026-06-02",
      "2026-06-01",
      null,
      null,
      null,
    );
    // (e) an over-budget row (53000 > 1.10 * 45000 = 49500) → dropped.
    insertListing.run(
      "lst_pricey",
      PROFILE_ID,
      DEALER_NEAR,
      "KM8JBCAE3RU000046",
      "STK-E5",
      2026,
      "Hyundai",
      "Tucson Hybrid",
      "Limited",
      "Red",
      52000,
      53000,
      "in_stock",
      "exact",
      "2026-06-01",
      "2026-06-04",
      "2026-06-01",
      null,
      null,
      null,
    );
  },
};
