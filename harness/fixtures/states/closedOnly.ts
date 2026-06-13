/**
 * closedOnly — the restore-from-empty world: ONE closed search and NO active
 * search. The active (account, brand) slot is FREE, so restoring the closed row
 * succeeds (it returns to active without tripping the partial unique index).
 *
 * This is the clean RESTORE-success fixture (contrast closedProfile, which seeds
 * an active Hyundai alongside a closed Hyundai → a restore there CONFLICTS). The
 * Canvas shows the empty state with no active profile; the Searches popover shows
 * the closed row under the Closed group, restorable.
 *
 * WHAT THIS SEEDS: 1 search_profiles row, status='closed'.
 */

import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

/** The deterministic closed-profile id (referenced by the case's row anchors). */
export const CLOSED_ID = "closed-only-1";

export const closedOnly: FixtureState = {
  id: "closed_only",
  seed: (db: Db) => {
    db.$client
      .prepare(
        "INSERT INTO search_profiles " +
          "(search_profile_id, year, make, model, trim, search_radius_miles, " +
          "location_query, city, state, postal_code, latitude, longitude, " +
          "financing_preference, phone_policy, account_id, brand, location, status) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'closed')",
      )
      .run(
        CLOSED_ID,
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
      );
  },
};
