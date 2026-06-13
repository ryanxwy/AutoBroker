/**
 * dataArriving — the REALTIME-DATA-REACTIVITY proof world (U-H). Two states:
 *
 *   data_arriving        — the BEFORE world: ONE active Hyundai Tucson profile
 *                          with TWO bound dealers (the Canvas shows two dealer
 *                          tiles). The case opens a run stream in the rail, then
 *                          grows this world to three dealers.
 *   data_arriving_grown  — the GROW delta: binds a THIRD dealer to the SAME
 *                          profile (NO profile re-insert — the active row already
 *                          exists). Applied WITHOUT a reload; a data.changed
 *                          pulse on the open run channel then refetches the
 *                          dealer tiles in place → three tiles, no reload.
 *
 * The two states share one profile id so the grow binds onto the existing
 * profile. The proof is genuine because the ONLY thing between the seed-grow and
 * the three-tile assertion is the SSE pulse — there is no reload action; a
 * coincidental refetch (a reload, the Skills-popover on-open refetch) is
 * deliberately absent from the case's ui_actions.
 *
 * WHY DEALERS (not profiles): a fresh profile would trip the active-slot unique
 * index (one active profile per (account, brand)); a fresh dealer + binding
 * grows the SAME profile's dealer projection cleanly, which is exactly the view
 * (DealerTiles, keyed "dealers") that goes stale after a geosearch write today.
 */

import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

/** The one active profile id, shared by both states (the grow binds onto it). */
const PROFILE_ID = "data-arriving-tucson-1";

/** Insert one dealer + bind it to the proof profile (status='bound'). */
function bindDealer(
  db: Db,
  id: string,
  name: string,
  address: string,
  distance: number,
): void {
  const c = db.$client;
  c.prepare(
    "INSERT INTO dealers (dealer_id, name, address, city, state, postal_code, distance_miles, country) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 'US')",
  ).run(id, name, address, "Tucson", "AZ", "85704", distance);
  c.prepare(
    "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
  ).run(PROFILE_ID, id);
}

/** BEFORE: one active profile + two bound dealers. */
export const dataArriving: FixtureState = {
  id: "data_arriving",
  seed: (db: Db) => {
    const c = db.$client;
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
    bindDealer(db, "data-arriving-jim-click", "Jim Click Hyundai", "750 W Auto Mall Dr, Tucson, AZ", 4.2);
    bindDealer(db, "data-arriving-precision", "Precision Hyundai", "740 W Wetmore Rd, Tucson, AZ", 6.8);
  },
};

/** GROW: bind a THIRD dealer to the SAME profile (no profile re-insert). */
export const dataArrivingGrown: FixtureState = {
  id: "data_arriving_grown",
  seed: (db: Db) => {
    bindDealer(db, "data-arriving-royal", "Royal Hyundai", "4690 E 22nd St, Tucson, AZ", 9.1);
  },
};
