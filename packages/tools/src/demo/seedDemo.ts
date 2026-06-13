/**
 * seedDemo — write a small, renderable SAMPLE world into the (already-isolated)
 * demo product DB so the whole dashboard can be point-tested with ZERO config:
 * no API key, no Gmail, no network. Tools-layer because tools owns every DB
 * write; the seed never imports a harness fixture (the harness is a separate
 * layer behind the dependency wall).
 *
 * THE WORLD (only what the current UI actually renders):
 *   - one local account row (the active-slot uniqueness + the snake_case profile
 *     views key off account_id) — created here if the DB is fresh and has none;
 *   - TWO active search profiles on DISTINCT brands, so each holds its own
 *     active (account, brand) slot (the partial unique index forbids only two
 *     active rows sharing a brand) → the Searches popover lists both, and the
 *     home canvas has two cards to disambiguate;
 *   - the first profile carries TWO bound dealers → the Canvas dealer tiles +
 *     the profile's dealer projection populate.
 *
 * IDEMPOTENT: seeds only when the DB has ZERO search profiles. A demo dir that
 * already holds the sample world (the owner relaunched) is left untouched, so
 * any edits they made while poking around survive the next launch.
 *
 * ISOLATION: this function writes whatever DB handle it is given. The caller
 * (the server boot, in demo mode) opens the handle against the ISOLATED demo
 * data dir — never the real ~/.autobroker-ts — so this can never reach real
 * data.
 */

import type { Db } from "../db.js";

/** Deterministic synthetic ids — stable across relaunches (idempotent reseed
 *  is gated on zero profiles, but fixed ids keep the world predictable). */
const ACCOUNT_ID = "acct-demo-1";
const PROFILE_TUCSON = "demo-tucson-1";
const PROFILE_RAV4 = "demo-rav4-1";

/**
 * Seed the sample demo world into `db` if it is empty. Returns whether a seed
 * was written (false when the world already existed — the idempotent skip).
 */
export function seedDemoData(db: Db): boolean {
  const c = db.$client;

  const existing = c.prepare("SELECT COUNT(*) AS n FROM search_profiles").get() as { n: number };
  if (existing.n > 0) return false; // world already present — leave it alone.

  // Ensure an account row exists (the bundle boot seeds one on a fresh DB, but
  // an account-less DB must still get a non-null account_id so the two profiles
  // share one active-slot namespace). Reuse the sole existing account if any.
  const account = c.prepare("SELECT account_id FROM accounts LIMIT 1").get() as
    | { account_id: string }
    | undefined;
  let accountId = account?.account_id;
  if (accountId === undefined) {
    c.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run(
      ACCOUNT_ID,
      "demo@localhost",
    );
    accountId = ACCOUNT_ID;
  }

  // Two active profiles on distinct brands (Hyundai, Toyota) → two active slots,
  // no uniqueness conflict. Only committed schema columns are written.
  const insertProfile = c.prepare(
    "INSERT INTO search_profiles " +
      "(search_profile_id, year, make, model, trim, budget_max, search_radius_miles, " +
      "location_query, city, state, postal_code, latitude, longitude, " +
      "financing_preference, phone_policy, account_id, brand, location, status) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fake', ?, ?, ?, 'active')",
  );
  const profiles: Array<[string, number, string, string, string, number, string]> = [
    [PROFILE_TUCSON, 2026, "Hyundai", "Tucson Hybrid", "SEL", 38000, "Hyundai"],
    [PROFILE_RAV4, 2026, "Toyota", "RAV4", "XLE", 36000, "Toyota"],
  ];
  for (const [id, year, make, model, trim, budget, brand] of profiles) {
    insertProfile.run(
      id,
      year,
      make,
      model,
      trim,
      budget,
      50,
      "Tucson, AZ 85704",
      "Tucson",
      "AZ",
      "85704",
      32.3349,
      -110.9762,
      "finance",
      accountId,
      brand,
      "Tucson, AZ 85704",
    );
  }

  // Two bound dealers on the first profile → a tile each in the Canvas dealer
  // projection (the second profile stays dealer-less — the pre-geosearch shape).
  const insertDealer = c.prepare(
    "INSERT INTO dealers (dealer_id, name, address, city, state, postal_code, distance_miles, rating, review_count, country) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'US')",
  );
  const bind = c.prepare(
    "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
  );
  const dealers: Array<[string, string, string, number, number, number]> = [
    ["demo-dealer-jim-click", "Jim Click Hyundai", "750 W Auto Mall Dr, Tucson, AZ", 4.2, 4.4, 1820],
    ["demo-dealer-precision", "Precision Hyundai", "740 W Wetmore Rd, Tucson, AZ", 6.8, 4.1, 940],
  ];
  for (const [id, name, address, distance, rating, reviews] of dealers) {
    insertDealer.run(id, name, address, "Tucson", "AZ", "85704", distance, rating, reviews);
    bind.run(PROFILE_TUCSON, id);
  }

  return true;
}
