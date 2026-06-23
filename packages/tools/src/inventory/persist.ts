/**
 * inventory_site_scan persist writer — the ONLY write path for
 * dealer_inventory_sources + inventory_listings during a scan run.
 *
 * Capture-then-serial: the parallel capture phase performs NO SQLite writes;
 * after capture+classification, the workflow hands this single writer every
 * dealer outcome of the run and it persists them serially in ONE transaction.
 * That makes the write phase order-insensitive and race-free by construction.
 *
 * Listing upsert arms (the two restored composite UNIQUEs; upserts branch
 * their ON CONFLICT target on VIN presence):
 *   - VIN arm        → ON CONFLICT (search_profile_id, dealer_id, vin);
 *   - VIN-absent arm → ON CONFLICT (search_profile_id, dealer_id,
 *                      normalized_listing_url) WHERE vin IS NULL (the partial
 *                      unique — SQLite NULL-distinct semantics make the
 *                      non-partial VIN key dedupe VIN-bearing rows only).
 *   - SRP row then VDP VIN for the same car → "vin_promoted": the URL-keyed
 *     row is superseded and the VIN-keyed row written in the same
 *     transaction, whichever order the two captures arrive in.
 *   - rows with neither VIN nor listing URL are DROPPED and counted — no
 *     identity anchor, no row.
 *   - the same VIN at two dealers is two rows (two quotes), by key design.
 *
 * Supersession: `supersedeStale` retires rows not observed by THIS run, and
 * is gated IN the verb to sources whose last_status is 'scanned' — a
 * blocked/skipped/failed scan never retires anything.
 */

import type { Db } from "@autobroker/db";
import type { InventoryListing } from "@autobroker/core";
import { getDb } from "../db.js";
import {
  computeListingId,
  computeSourceId,
  normalizeListingUrl,
  truncateRawJson,
  urlNormalize,
  type MatchStatus,
} from "./pure.js";

/** Terminal status of one dealer's capture attempt. */
export type ScanStatus = "scanned" | "blocked" | "skipped" | "failed";

export type SupersedeReason = "not_observed" | "vin_promoted" | "manual";

/** One captured+classified listing row, ready to write. The caller has
 *  already (a) Zod-validated the 11-field extraction shape, (b) run the VIN
 *  provenance guard — a VIN that failed every snapshot must arrive here as
 *  null — and (c) classified matchStatus in code. */
export interface ClassifiedListingRow {
  listing: InventoryListing;
  matchStatus: MatchStatus;
  /** MSRP harvested off the VDP (a tools-layer derived field, NOT part of the
   *  frozen 11-field LLM emit shape); null when no MSRP label resolved. */
  msrp?: number | null;
  /** Provenance blob for raw_listing_json (32 KB cap applied at write). */
  raw: string | Record<string, unknown> | null;
}

/** One dealer's scan outcome. Non-scanned outcomes must carry zero rows —
 *  a blocked/skipped/failed capture is discarded, never persisted. */
export interface DealerScanOutcome {
  dealerId: string;
  /** The SRP URL actually captured (the canonical filtered URL when the
   *  filter ladder hit, the plain SRP otherwise). */
  sourceUrl: string;
  status: ScanStatus;
  errorJson?: string | null;
  rows?: readonly ClassifiedListingRow[];
}

export interface PersistRunResult {
  sourcesScanned: number;
  sourcesBlocked: number;
  sourcesSkipped: number;
  sourcesFailed: number;
  /** Listing rows inserted or refreshed (both arms + merge-updates). */
  listingsWritten: number;
  /** URL-keyed rows superseded by a VIN-keyed row for the same car. */
  vinPromoted: number;
  /** Rows dropped for having neither VIN nor listing URL. */
  droppedNoKey: number;
  /** Rows retired by supersedeStale across the run's scanned sources. */
  staleSuperseded: number;
}

// ---------------------------------------------------------------------------
// SQL (raw better-sqlite3 prepared statements, one transaction per run).
// ---------------------------------------------------------------------------

/** Idempotent source insert: source_id is the hash of exactly the conflict
 *  key (profile, dealer, normalized_url), so PK conflict == natural-key
 *  conflict. Existing rows keep their first_seen_at and status fields. */
const INSERT_SOURCE = `
INSERT INTO dealer_inventory_sources (
  source_id, search_profile_id, dealer_id, source_type, source_url,
  normalized_url, discovery_method, parent_source_id, first_seen_at,
  last_status, blocked_count
) VALUES (?, ?, ?, 'srp', ?, ?, 'geosearch_website', NULL, ?, 'pending', 0)
ON CONFLICT(source_id) DO NOTHING
`;

/** Status mark: blocked increments blocked_count; scanned resets it to 0
 *  (first successful scan clears the strike count); others leave it alone. */
const MARK_SOURCE = `
UPDATE dealer_inventory_sources SET
  last_status = ?,
  last_scanned_at = ?,
  error_json = ?,
  blocked_count = CASE ?
    WHEN 'blocked' THEN blocked_count + 1
    WHEN 'scanned' THEN 0
    ELSE blocked_count END
WHERE source_id = ?
`;

/** Live URL-keyed row that a VIN-bearing write for the same car supersedes. */
const SELECT_LIVE_NULL_VIN_ROW = `
SELECT listing_id FROM inventory_listings
WHERE search_profile_id = ? AND dealer_id = ? AND vin IS NULL
  AND normalized_listing_url = ? AND superseded_at IS NULL
`;

const SUPERSEDE_VIN_PROMOTED = `
UPDATE inventory_listings SET superseded_at = ?, superseded_reason = 'vin_promoted'
WHERE listing_id = ?
`;

/** Orphan prevention for the VIN-absent arm: if ANY live row (including a
 *  VIN-bearing one) already owns this URL, update it instead of inserting a
 *  NULL-VIN companion — the partial unique cannot link the two arms, so this
 *  lookup keeps the dedup contract closed in both capture orders. VIN-bearing
 *  rows sort first (the stronger key wins). */
const SELECT_LIVE_URL_ROW = `
SELECT listing_id FROM inventory_listings
WHERE search_profile_id = ? AND dealer_id = ?
  AND normalized_listing_url = ? AND superseded_at IS NULL
ORDER BY vin IS NULL, first_seen_at
LIMIT 1
`;

const LISTING_INSERT_COLS = `(
  listing_id, search_profile_id, dealer_id, source_id, vin, stock_number,
  year, make, model, trim, exterior_color, interior_color, listed_price,
  inventory_status, listing_url, normalized_listing_url, match_status,
  raw_listing_json, first_seen_at, last_seen_at, observed_at, msrp
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Refresh semantics on conflict: identity fields merge null-preserving
 *  (a sparser re-scan never blanks a known value); status/match/raw and the
 *  freshness timestamps overwrite unconditionally; first_seen_at survives. */
const LISTING_ON_CONFLICT_BODY = `
  source_id              = COALESCE(excluded.source_id, inventory_listings.source_id),
  stock_number           = COALESCE(excluded.stock_number, inventory_listings.stock_number),
  year                   = COALESCE(excluded.year, inventory_listings.year),
  make                   = COALESCE(excluded.make, inventory_listings.make),
  model                  = COALESCE(excluded.model, inventory_listings.model),
  trim                   = COALESCE(excluded.trim, inventory_listings.trim),
  exterior_color         = COALESCE(excluded.exterior_color, inventory_listings.exterior_color),
  interior_color         = COALESCE(excluded.interior_color, inventory_listings.interior_color),
  listed_price           = COALESCE(excluded.listed_price, inventory_listings.listed_price),
  msrp                   = COALESCE(excluded.msrp, inventory_listings.msrp),
  inventory_status       = excluded.inventory_status,
  listing_url            = COALESCE(excluded.listing_url, inventory_listings.listing_url),
  normalized_listing_url = COALESCE(excluded.normalized_listing_url, inventory_listings.normalized_listing_url),
  match_status           = excluded.match_status,
  raw_listing_json       = excluded.raw_listing_json,
  last_seen_at           = excluded.last_seen_at,
  observed_at            = excluded.observed_at
`;

const UPSERT_VIN_ARM = `
INSERT INTO inventory_listings ${LISTING_INSERT_COLS}
ON CONFLICT (search_profile_id, dealer_id, vin) DO UPDATE SET ${LISTING_ON_CONFLICT_BODY}
`;

const UPSERT_URL_ARM = `
INSERT INTO inventory_listings ${LISTING_INSERT_COLS}
ON CONFLICT (search_profile_id, dealer_id, normalized_listing_url) WHERE vin IS NULL
DO UPDATE SET ${LISTING_ON_CONFLICT_BODY}
`;

/** The positional merge-update twin of LISTING_ON_CONFLICT_BODY, for the
 *  orphan-prevention path (updating an existing row found by URL). */
const UPDATE_LIVE_ROW = `
UPDATE inventory_listings SET
  source_id              = COALESCE(?, source_id),
  stock_number           = COALESCE(?, stock_number),
  year                   = COALESCE(?, year),
  make                   = COALESCE(?, make),
  model                  = COALESCE(?, model),
  trim                   = COALESCE(?, trim),
  exterior_color         = COALESCE(?, exterior_color),
  interior_color         = COALESCE(?, interior_color),
  listed_price           = COALESCE(?, listed_price),
  msrp                   = COALESCE(?, msrp),
  inventory_status       = ?,
  listing_url            = COALESCE(?, listing_url),
  normalized_listing_url = COALESCE(?, normalized_listing_url),
  match_status           = ?,
  raw_listing_json       = ?,
  last_seen_at           = ?,
  observed_at            = ?
WHERE listing_id = ?
`;

const SELECT_SOURCE_STATUS = `
SELECT last_status FROM dealer_inventory_sources WHERE source_id = ?
`;

const SUPERSEDE_STALE = `
UPDATE inventory_listings SET superseded_at = ?, superseded_reason = ?
WHERE search_profile_id = ? AND source_id = ?
  AND observed_at < ? AND superseded_at IS NULL
`;

// ---------------------------------------------------------------------------
// supersedeStale — scanned sources ONLY, enforced in the verb.
// ---------------------------------------------------------------------------

/**
 * Soft-delete listings of one source that were not observed at/after
 * `runStartedAt` (ISO-8601 string; observed_at comparisons are lexicographic,
 * which is chronological for ISO timestamps). Returns the count of
 * newly-superseded rows; already-superseded rows are untouched.
 *
 * Gated IN the verb: unless the source row exists AND last_status ===
 * 'scanned', this supersedes NOTHING and returns 0 — a blocked, skipped or
 * failed scan can never retire rows, and an unknown source proves nothing.
 */
export function supersedeStale(opts: {
  searchProfileId: string;
  sourceId: string;
  runStartedAt: string;
  reason?: SupersedeReason;
  db?: Db;
  now?: string;
}): number {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date().toISOString();
  const source = db.$client.prepare(SELECT_SOURCE_STATUS).get(opts.sourceId) as
    | { last_status: string }
    | undefined;
  if (source === undefined || source.last_status !== "scanned") return 0;
  const result = db.$client
    .prepare(SUPERSEDE_STALE)
    .run(
      now,
      opts.reason ?? "not_observed",
      opts.searchProfileId,
      opts.sourceId,
      opts.runStartedAt,
    );
  return result.changes;
}

// ---------------------------------------------------------------------------
// persistScanResults — the single writer for one run.
// ---------------------------------------------------------------------------

/**
 * Persist every dealer outcome of one scan run, serially, in one transaction.
 * `runStartedAt` (ISO) is the staleness watermark: rows of a freshly SCANNED
 * source observed before it are retired (reason 'not_observed'); rows written
 * by this call carry observed_at = now and therefore survive.
 *
 * Fail-loud contract: a non-scanned outcome carrying rows throws — blocked or
 * skipped captures must be discarded upstream, never smuggled into the DB.
 */
export function persistScanResults(opts: {
  searchProfileId: string;
  runStartedAt: string;
  outcomes: readonly DealerScanOutcome[];
  db?: Db;
  now?: string;
}): PersistRunResult {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date().toISOString();
  const profileId = opts.searchProfileId;

  const insertSource = db.$client.prepare(INSERT_SOURCE);
  const markSource = db.$client.prepare(MARK_SOURCE);
  const selectLiveNullVin = db.$client.prepare(SELECT_LIVE_NULL_VIN_ROW);
  const supersedePromoted = db.$client.prepare(SUPERSEDE_VIN_PROMOTED);
  const upsertVinArm = db.$client.prepare(UPSERT_VIN_ARM);
  const selectLiveUrlRow = db.$client.prepare(SELECT_LIVE_URL_ROW);
  const updateLiveRow = db.$client.prepare(UPDATE_LIVE_ROW);
  const upsertUrlArm = db.$client.prepare(UPSERT_URL_ARM);

  const txn = db.$client.transaction((): PersistRunResult => {
    const result: PersistRunResult = {
      sourcesScanned: 0,
      sourcesBlocked: 0,
      sourcesSkipped: 0,
      sourcesFailed: 0,
      listingsWritten: 0,
      vinPromoted: 0,
      droppedNoKey: 0,
      staleSuperseded: 0,
    };

    for (const outcome of opts.outcomes) {
      const rows = outcome.rows ?? [];
      if (outcome.status !== "scanned" && rows.length > 0) {
        throw new Error(
          `persistScanResults: ${outcome.status} outcome for dealer ` +
            `${outcome.dealerId} carries ${rows.length} rows — non-scanned ` +
            "captures are discarded, never persisted",
        );
      }

      const normalizedUrl = urlNormalize(outcome.sourceUrl);
      const sourceId = computeSourceId(profileId, outcome.dealerId, normalizedUrl);
      insertSource.run(sourceId, profileId, outcome.dealerId, outcome.sourceUrl, normalizedUrl, now);
      markSource.run(
        outcome.status,
        now,
        outcome.errorJson ?? null,
        outcome.status,
        sourceId,
      );
      switch (outcome.status) {
        case "scanned":
          result.sourcesScanned += 1;
          break;
        case "blocked":
          result.sourcesBlocked += 1;
          break;
        case "skipped":
          result.sourcesSkipped += 1;
          break;
        case "failed":
          result.sourcesFailed += 1;
          break;
      }
      if (outcome.status !== "scanned") continue;

      for (const row of rows) {
        const vin = row.listing.vin || null; // empty string = no VIN
        const listingUrl = row.listing.listing_url || null;
        const nlurl = listingUrl === null ? null : normalizeListingUrl(listingUrl);
        if (vin === null && (nlurl === null || nlurl === "")) {
          result.droppedNoKey += 1;
          continue;
        }
        const rawJson = truncateRawJson(row.raw);

        // Positional params shared by both INSERT arms (listing_id first).
        const insertParams = (listingId: string): unknown[] => [
          listingId,
          profileId,
          outcome.dealerId,
          sourceId,
          vin,
          row.listing.stock_number,
          row.listing.year,
          row.listing.make,
          row.listing.model,
          row.listing.trim,
          row.listing.exterior_color,
          row.listing.interior_color,
          row.listing.price,
          row.listing.inventory_status,
          listingUrl,
          nlurl,
          row.matchStatus,
          rawJson,
          now,
          now,
          now,
          row.msrp ?? null,
        ];

        if (vin !== null) {
          // VIN arm. First retire any live URL-keyed twin of the same car
          // (SRP row captured without VIN, VIN recovered on its VDP).
          if (nlurl !== null && nlurl !== "") {
            const stale = selectLiveNullVin.get(profileId, outcome.dealerId, nlurl) as
              | { listing_id: string }
              | undefined;
            if (stale !== undefined) {
              supersedePromoted.run(now, stale.listing_id);
              result.vinPromoted += 1;
            }
          }
          upsertVinArm.run(
            ...insertParams(computeListingId(profileId, outcome.dealerId, vin, nlurl)),
          );
          result.listingsWritten += 1;
        } else {
          // VIN-absent arm, with orphan prevention: a live row already owning
          // this URL (possibly VIN-bearing, from the other capture order) is
          // updated in place rather than shadowed by a NULL-VIN companion.
          const existing = selectLiveUrlRow.get(profileId, outcome.dealerId, nlurl) as
            | { listing_id: string }
            | undefined;
          if (existing !== undefined) {
            updateLiveRow.run(
              sourceId,
              row.listing.stock_number,
              row.listing.year,
              row.listing.make,
              row.listing.model,
              row.listing.trim,
              row.listing.exterior_color,
              row.listing.interior_color,
              row.listing.price,
              row.msrp ?? null,
              row.listing.inventory_status,
              listingUrl,
              nlurl,
              row.matchStatus,
              rawJson,
              now,
              now,
              existing.listing_id,
            );
          } else {
            upsertUrlArm.run(
              ...insertParams(computeListingId(profileId, outcome.dealerId, null, nlurl)),
            );
          }
          result.listingsWritten += 1;
        }
      }

      // Fresh full scan: retire this source's rows not observed by THIS run.
      // The verb re-checks last_status='scanned' itself (we just marked it),
      // so a blocked/skipped source above never reaches a supersede.
      result.staleSuperseded += supersedeStale({
        searchProfileId: profileId,
        sourceId,
        runStartedAt: opts.runStartedAt,
        db,
        now,
      });
    }

    return result;
  });

  return txn();
}
