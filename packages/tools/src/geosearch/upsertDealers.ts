/**
 * upsertDealers — the ONLY write path of dealer_geosearch. Ported from the
 * established contract, with the US gate inlined (one path, no
 * second-line duplicate).
 *
 * SQLITE INVARIANT: only packages/tools (and db beneath it) touch the product
 * DB. Raw better-sqlite3 prepared statements via db.$client; one transaction
 * per batch.
 *
 * Write semantics:
 *   - dealers: upsert by dealer_id PK — INSERT … ON CONFLICT(dealer_id)
 *     DO UPDATE of the refreshable fields. The website is stored with
 *     trailing slashes stripped. `country` is never in the column list: the
 *     12-field candidate carries no country signal, so the DB DEFAULT 'US'
 *     fills it on insert and an existing value is preserved on update
 *     (column-omit = "only written when known").
 *   - profile_dealers: INSERT OR IGNORE a (search_profile_id, dealer_id,
 *     status='candidate') row. The composite PK makes the ignore total: an
 *     existing row of ANY status (candidate / bound / excluded_conflict /
 *     closed_out) is untouched — re-discovery never reverts a bound or
 *     excluded dealer.
 *   - US hard gate: `isUsDealer` re-checked here per row (the filter chain
 *     upstream only MARKS non-US). Non-US rows are skipped and counted, never
 *     written.
 */

import type { Db } from "@autobroker/db";
import { getDb } from "../db.js";
import { isUsDealer } from "../geo.js";
import { dealerId, type RankedDealerCandidate } from "./pure.js";

export interface UpsertDealersResult {
  /** New dealers rows created. */
  inserted: number;
  /** Existing dealers rows refreshed. */
  updated: number;
  /** New profile_dealers candidate rows (existing rows of any status no-op). */
  candidatesRegistered: number;
  /** Rows the inline US gate rejected — skipped and counted, never written. */
  nonUsSkipped: number;
  /** Rows without a name — dealers.name is NOT NULL, so they cannot be
   *  persisted; skipped and counted (never a silent drop). */
  unnamedSkipped: number;
}

const SELECT_DEALER_EXISTS = "SELECT 1 FROM dealers WHERE dealer_id = ?";

const UPSERT_DEALER = `
INSERT INTO dealers (
  dealer_id, name, address, phone, website, google_place_id,
  latitude, longitude, distance_miles, rating, review_count
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(dealer_id) DO UPDATE SET
  name            = excluded.name,
  address         = excluded.address,
  phone           = excluded.phone,
  website         = excluded.website,
  google_place_id = excluded.google_place_id,
  latitude        = excluded.latitude,
  longitude       = excluded.longitude,
  distance_miles  = excluded.distance_miles,
  rating          = excluded.rating,
  review_count    = excluded.review_count
`;

const INSERT_CANDIDATE = `
INSERT OR IGNORE INTO profile_dealers (search_profile_id, dealer_id, status)
VALUES (?, ?, 'candidate')
`;

/** Trailing-slash normalization for stored websites (null passes through). */
function stripTrailingSlash(url: string | null): string | null {
  return url === null ? null : url.replace(/\/+$/, "");
}

/**
 * Persist filtered candidates into `dealers` + `profile_dealers` for one
 * search profile, in a single transaction. Idempotent: re-running with the
 * same candidates refreshes dealers rows and registers zero new candidates.
 */
export function upsertDealers(
  candidates: readonly RankedDealerCandidate[],
  searchProfileId: string,
  db: Db = getDb(),
): UpsertDealersResult {
  const existsStmt = db.$client.prepare(SELECT_DEALER_EXISTS);
  const upsertStmt = db.$client.prepare(UPSERT_DEALER);
  const candidateStmt = db.$client.prepare(INSERT_CANDIDATE);

  const txn = db.$client.transaction((): UpsertDealersResult => {
    const result: UpsertDealersResult = {
      inserted: 0,
      updated: 0,
      candidatesRegistered: 0,
      nonUsSkipped: 0,
      unnamedSkipped: 0,
    };

    for (const c of candidates) {
      // Inline US hard gate (the filter chain only marked these rows).
      // Website + name are the only geography signals the candidate carries.
      if (!isUsDealer({ website: c.website, name: c.name })) {
        result.nonUsSkipped += 1;
        continue;
      }
      if (c.name === null || c.name.trim() === "") {
        result.unnamedSkipped += 1;
        continue;
      }

      const id = dealerId(c);
      const existed = existsStmt.get(id) !== undefined;
      upsertStmt.run(
        id,
        c.name,
        c.address,
        c.phone,
        stripTrailingSlash(c.website),
        c.google_place_id,
        c.latitude,
        c.longitude,
        c.distance_miles,
        c.rating,
        c.review_count,
      );
      if (existed) result.updated += 1;
      else result.inserted += 1;

      // OR IGNORE on the composite PK: a row of ANY existing status is a
      // total no-op — `changes` is 1 only for a genuinely new candidate row.
      const reg = candidateStmt.run(searchProfileId, id);
      result.candidatesRegistered += reg.changes;
    }

    return result;
  });

  return txn();
}
