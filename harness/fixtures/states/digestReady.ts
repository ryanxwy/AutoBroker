/**
 * digestReady — the world for the notify-click UI test: an active search the
 * dashboard renders, into which a background notification can be delivered.
 *
 * SEAM: the notification's deep-link target is a digest result page that does
 * not exist yet (a later report/digest wave). So this state seeds a renderable
 * active-search world (one active profile + a bound dealer) and the notify-click
 * test asserts the window FOCUS + the navigation ATTEMPT — NOT a real digest
 * page. When the digest page lands, the deep link points at it and this same
 * world carries the assertion forward.
 *
 * WHAT THIS SEEDS (only what the CURRENT UI renders):
 *   - 1 search_profiles row (status='active') — the Canvas projects its card
 *   - 1 dealer + 1 profile_dealers binding — one dealer tile
 *
 * NOT SEEDED: any manufacturer_incentives / digest rows — no surface renders a
 * digest in the dashboard yet (the deep-link target seam), so seeding one would
 * assert nothing.
 */

import type { Db } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

const PROFILE_ID = "digest-tucson-1";

export const digestReady: FixtureState = {
  id: "digest_ready",
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
    c.prepare(
      "INSERT INTO dealers (dealer_id, name, address, city, state, postal_code, distance_miles, country) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'US')",
    ).run("dealer-jim-click", "Jim Click Hyundai", "750 W Auto Mall Dr, Tucson, AZ", "Tucson", "AZ", "85704", 4.2);
    c.prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
    ).run(PROFILE_ID, "dealer-jim-click");
  },
};
