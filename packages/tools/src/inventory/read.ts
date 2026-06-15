/**
 * Listings read helper for /inventory_compare — the DB-read side of the
 * deterministic ranker. Reads the live (non-superseded) inventory listings for
 * one profile and staples each listing's dealer distance via a LEFT JOIN, so
 * the pure ranker can score without re-opening the connection.
 *
 * SQLITE INVARIANT: only packages/tools (and db beneath it) touch the product
 * DB. Raw better-sqlite3 statements via db.$client — NO drizzle-orm import.
 * Read-only: no writes, no network.
 */

import type { Db } from "@autobroker/db";

/** Result of reading a profile's live listings for the ranker. */
export interface ProfileListingsRead {
  /** Live (non-superseded) listing rows, snake_case, with `dealer_name` and
   *  `distance_miles` stapled from the dealer join. */
  listings: Record<string, unknown>[];
  /** dealer_id → distance_miles (or null), built from the joined rows. */
  dealerDistances: Record<string, number | null>;
}

const SELECT_LISTINGS =
  "SELECT inventory_listings.*, d.name AS dealer_name, d.distance_miles AS distance_miles " +
  "FROM inventory_listings " +
  "LEFT JOIN dealers d ON d.dealer_id = inventory_listings.dealer_id " +
  "WHERE inventory_listings.search_profile_id = ? " +
  "AND inventory_listings.superseded_at IS NULL " +
  "ORDER BY inventory_listings.listing_id";

/**
 * Read the live listings bound to one profile (joined to dealers for the
 * distance axis). Returns the snake_case rows plus a `dealer_id → distance`
 * map for the ranker's `rankListings` distance argument. Superseded rows are
 * excluded.
 */
export function listListingsForProfile(db: Db, profileId: string): ProfileListingsRead {
  const listings = db.$client.prepare(SELECT_LISTINGS).all(profileId) as Record<
    string,
    unknown
  >[];

  const dealerDistances: Record<string, number | null> = {};
  for (const row of listings) {
    const dealerId = row["dealer_id"];
    if (typeof dealerId === "string") {
      const dist = row["distance_miles"];
      dealerDistances[dealerId] = typeof dist === "number" ? dist : null;
    }
  }

  return { listings, dealerDistances };
}
