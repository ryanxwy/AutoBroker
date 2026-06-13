/**
 * closedProfile — the closed/inactive world: ONE active search alongside ONE
 * closed search. "Closed" is the search_profiles.status='closed' value the
 * close() service writes (it frees the active (account, brand) slot). The
 * active-list read filters status='active' OR NULL, so a 'closed' row is hidden
 * from the Searches popover and the Canvas — exactly the assertion this state
 * proves.
 *
 * Both rows share the SAME make (Hyundai): because the closed row no longer
 * holds the active slot, the active Hyundai row coexists with it without
 * tripping the partial unique index (which only constrains status='active').
 *
 * WHAT THIS SEEDS: 2 search_profiles rows — one status='active', one
 * status='closed' (distinct trims so their synthetic ids differ).
 */

import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

/** The deterministic ids (referenced by the case's row-presence/absence anchors). */
export const ACTIVE_ID = "closed-active-1";
export const CLOSED_ID = "closed-inactive-1";

export const closedProfile: FixtureState = {
  id: "closed_profile",
  seed: (db: Db) => {
    const insert = db.$client.prepare(
      "INSERT INTO search_profiles " +
        "(search_profile_id, year, make, model, trim, search_radius_miles, " +
        "location_query, city, state, postal_code, latitude, longitude, " +
        "financing_preference, phone_policy, account_id, brand, location, status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const base = [
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
    ] as const;
    // The visible active search.
    insert.run(ACTIVE_ID, 2026, "Hyundai", "Tucson Hybrid", "SEL", ...base, "active");
    // The closed search (status='closed') — hidden from the active list. A
    // distinct trim keeps it a separate row from the active one.
    insert.run(CLOSED_ID, 2025, "Hyundai", "Tucson Hybrid", "Limited", ...base, "closed");
  },
};
