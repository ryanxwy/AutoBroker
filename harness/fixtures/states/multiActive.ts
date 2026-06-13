/**
 * multiActive — the "which one?" world: TWO active search profiles. This is the
 * disambiguation moment — a profile-scoped skill with no pin must ask which
 * search to act on. The two profiles have DIFFERENT makes (brands), so each
 * holds its own active (account, brand) slot — the partial unique index
 * uq_search_profiles_active_account_brand only forbids two active rows sharing a
 * brand, not two distinct brands.
 *
 * WHAT THIS SEEDS: 2 search_profiles rows (both status='active', both on
 * acct-harness-1, brand=make). No dealers — the disambiguation surface is the
 * Searches popover row LIST, which renders one searches-row-<id> per active
 * profile regardless of dealers.
 */

import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

export const multiActive: FixtureState = {
  id: "multi_active",
  seed: (db: Db) => {
    const insert = db.$client.prepare(
      "INSERT INTO search_profiles " +
        "(search_profile_id, year, make, model, trim, search_radius_miles, " +
        "location_query, city, state, postal_code, latitude, longitude, " +
        "financing_preference, phone_policy, account_id, brand, location, status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')",
    );
    // Two distinct brands → two active slots, no uniqueness conflict.
    const rows: Array<[string, number, string, string, string]> = [
      ["multi-tucson-1", 2026, "Hyundai", "Tucson Hybrid", "SEL"],
      ["multi-rav4-1", 2026, "Toyota", "RAV4", "XLE"],
    ];
    for (const [id, year, make, model, trim] of rows) {
      insert.run(
        id,
        year,
        make,
        model,
        trim,
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
        make,
        "Tucson, AZ 85704",
      );
    }
  },
};
