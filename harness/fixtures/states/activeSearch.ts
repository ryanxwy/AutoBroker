/**
 * activeSearch — the "search with results" world: ONE active search profile
 * (the Tucson corpus shape) with two bound dealers. This is the moment after
 * intake + geosearch: the Canvas projects the active profile card and renders a
 * dealer tile per bound dealer, and the Searches popover lists the one active
 * search.
 *
 * WHAT THIS SEEDS (only what the CURRENT UI renders):
 *   - 1 search_profiles row (status='active', account=acct-harness-1, brand=make)
 *   - 2 dealers + 2 profile_dealers binding them to the profile (status='bound')
 *
 * NOT SEEDED: inventory_listings / manufacturer_incentives. The current Canvas
 * has no widget that projects either (the feed says quotes/listings land as the
 * email pipeline comes online), so seeding them would assert nothing — they
 * stay deferred until a panel renders them.
 */

import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

/** The one active profile id (deterministic — a fixed synthetic id). */
const PROFILE_ID = "active-tucson-1";

export const activeSearch: FixtureState = {
  id: "active_search",
  seed: (db: Db) => {
    const c = db.$client;
    // The active search (Tucson corpus shape). account_id + brand carry the
    // active-slot key; status='active' puts it in the active list the Canvas
    // and Searches popover read.
    c.prepare(
      "INSERT INTO search_profiles " +
        "(search_profile_id, year, make, model, trim, search_radius_miles, " +
        "location_query, city, state, postal_code, latitude, longitude, " +
        "financing_preference, phone_policy, account_id, brand, location, status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      PROFILE_ID,
      2026,
      "Hyundai",
      "Tucson Hybrid",
      "SEL",
      50,
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

    // Two bound dealers — one tile each in the Canvas dealer projection.
    const dealers: Array<[string, string, string, number]> = [
      ["dealer-jim-click", "Jim Click Hyundai", "750 W Auto Mall Dr, Tucson, AZ", 4.2],
      ["dealer-precision", "Precision Hyundai", "740 W Wetmore Rd, Tucson, AZ", 6.8],
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
  },
};
