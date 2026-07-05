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
import { emitInventoryPriceChange } from "./auditWriter.js";
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
  /** LABELED dealer market-adjustment (markup) harvested off the VDP — a
   *  tools-layer derived sibling like `msrp`. The 0-vs-null sentinel is
   *  load-bearing for the harvest-aware merge (see the persist COALESCE notes):
   *  the caller passes `0` to mean "VDP harvested, no markup → CLEAR a prior
   *  value", `null`/undefined to mean "VDP not harvested → PRESERVE". */
  dealerMarkup?: number | null;
  /** Pricing-breakdown blob (add-ons / parse-coverage) for the
   *  pricing_breakdown_json column. Same sentinel discipline: an explicit
   *  non-null empty-breakdown string CLEARS a prior blob; null/undefined
   *  PRESERVES it. Kept in sync with dealerMarkup by the caller. */
  pricingBreakdownJson?: string | null;
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
  /** Scanned sources whose stale sweep was skipped by the coverage-collapse
   *  guard (a truncated capture re-observed too little of the live lot to
   *  trust its absences). Their unseen rows stay live, not mass-retired. */
  sourcesQuarantined: number;
  /** Listings whose listed_price changed on this re-scan (an audit_log
   *  inventory.price_change row was written for each). */
  priceChanges: number;
}

// ---------------------------------------------------------------------------
// SQL (raw better-sqlite3 prepared statements, one transaction per run).
// ---------------------------------------------------------------------------

/** Idempotent source insert: source_id is the hash of exactly the conflict
 *  key (profile, dealer, normalized_url), so PK conflict == natural-key
 *  conflict. Existing rows keep their first_seen_at and status fields.
 *  source_type + discovery_method are bound per run (defaults 'srp' /
 *  'geosearch_website' reproduce the site_scan grain). */
const INSERT_SOURCE = `
INSERT INTO dealer_inventory_sources (
  source_id, search_profile_id, dealer_id, source_type, source_url,
  normalized_url, discovery_method, parent_source_id, first_seen_at,
  last_status, blocked_count
) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pending', 0)
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
  raw_listing_json, first_seen_at, last_seen_at, observed_at, msrp,
  dealer_markup, pricing_breakdown_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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
  -- Harvest-aware merge for the VDP-only markup/breakdown fields. These are
  -- harvested for only a budget-bounded SUBSET of listings per scan, so the
  -- carried value is a 0-vs-null SENTINEL set by the CALLER (not by persist):
  --   value 0 / explicit empty-breakdown string = "VDP visited, none found" → CLEAR
  --     (COALESCE(0, old) = 0, COALESCE('{}', old) = '{}'),
  --   NULL                                       = "VDP not visited"         → PRESERVE
  --     (COALESCE(NULL, old) = old).
  -- COALESCE is therefore correct in BOTH directions: it clears on an explicit
  -- non-null carry yet preserves a prior value on a not-harvested re-scan — so a
  -- red-flag markup never ratchets (a removed markup honestly clears) while a
  -- sparse re-scan never blanks a known one.
  dealer_markup          = COALESCE(excluded.dealer_markup, inventory_listings.dealer_markup),
  pricing_breakdown_json = COALESCE(excluded.pricing_breakdown_json, inventory_listings.pricing_breakdown_json),
  inventory_status       = excluded.inventory_status,
  listing_url            = COALESCE(excluded.listing_url, inventory_listings.listing_url),
  normalized_listing_url = COALESCE(excluded.normalized_listing_url, inventory_listings.normalized_listing_url),
  match_status           = excluded.match_status,
  raw_listing_json       = excluded.raw_listing_json,
  last_seen_at           = excluded.last_seen_at,
  observed_at            = excluded.observed_at,
  -- Re-observing a row a prior run retired as not_observed REACTIVATES it (the
  -- car came back, or a transient scrape-miss is corrected) — it must never
  -- linger as a zombie (superseded_at set yet observed today). vin_promoted and
  -- manual supersessions are structural, so ONLY not_observed is undone here.
  superseded_at          = CASE WHEN inventory_listings.superseded_reason = 'not_observed' THEN NULL ELSE inventory_listings.superseded_at END,
  superseded_reason      = CASE WHEN inventory_listings.superseded_reason = 'not_observed' THEN NULL ELSE inventory_listings.superseded_reason END
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
  -- Same 0-vs-null sentinel COALESCE as LISTING_ON_CONFLICT_BODY (positional ?):
  -- an explicit 0 / empty-breakdown carry CLEARS, NULL PRESERVES.
  dealer_markup          = COALESCE(?, dealer_markup),
  pricing_breakdown_json = COALESCE(?, pricing_breakdown_json),
  inventory_status       = ?,
  listing_url            = COALESCE(?, listing_url),
  normalized_listing_url = COALESCE(?, normalized_listing_url),
  match_status           = ?,
  raw_listing_json       = ?,
  last_seen_at           = ?,
  observed_at            = ?
WHERE listing_id = ?
`;

// ---------------------------------------------------------------------------
// Enrich-only conflict bodies (conflictMode === "enrich_only"). A collision
// NEVER overwrites an existing non-null column: every fill-if-null COALESCE is
// existing-first (COALESCE(existing, incoming) keeps a known value, fills only a
// null). inventory_status never downgrades — an incoming value replaces the
// existing one ONLY when the existing is 'unknown' and the incoming is not.
// match_status + raw_listing_json are preserved verbatim (both NOT NULL), and
// superseded_at / superseded_reason are left untouched (no reactivation). Only
// last_seen_at / observed_at are bumped. Fresh inserts still land full data via
// the shared INSERT column list; only the DO UPDATE body differs here.
const LISTING_ON_CONFLICT_BODY_ENRICH = `
  source_id              = COALESCE(inventory_listings.source_id, excluded.source_id),
  stock_number           = COALESCE(inventory_listings.stock_number, excluded.stock_number),
  year                   = COALESCE(inventory_listings.year, excluded.year),
  make                   = COALESCE(inventory_listings.make, excluded.make),
  model                  = COALESCE(inventory_listings.model, excluded.model),
  trim                   = COALESCE(inventory_listings.trim, excluded.trim),
  exterior_color         = COALESCE(inventory_listings.exterior_color, excluded.exterior_color),
  interior_color         = COALESCE(inventory_listings.interior_color, excluded.interior_color),
  listed_price           = COALESCE(inventory_listings.listed_price, excluded.listed_price),
  msrp                   = COALESCE(inventory_listings.msrp, excluded.msrp),
  dealer_markup          = COALESCE(inventory_listings.dealer_markup, excluded.dealer_markup),
  pricing_breakdown_json = COALESCE(inventory_listings.pricing_breakdown_json, excluded.pricing_breakdown_json),
  inventory_status       = CASE
    WHEN inventory_listings.inventory_status = 'unknown' AND excluded.inventory_status <> 'unknown'
    THEN excluded.inventory_status
    ELSE inventory_listings.inventory_status END,
  listing_url            = COALESCE(inventory_listings.listing_url, excluded.listing_url),
  normalized_listing_url = COALESCE(inventory_listings.normalized_listing_url, excluded.normalized_listing_url),
  match_status           = inventory_listings.match_status,
  raw_listing_json       = inventory_listings.raw_listing_json,
  last_seen_at           = excluded.last_seen_at,
  observed_at            = excluded.observed_at
`;

const UPSERT_VIN_ARM_ENRICH = `
INSERT INTO inventory_listings ${LISTING_INSERT_COLS}
ON CONFLICT (search_profile_id, dealer_id, vin) DO UPDATE SET ${LISTING_ON_CONFLICT_BODY_ENRICH}
`;

const UPSERT_URL_ARM_ENRICH = `
INSERT INTO inventory_listings ${LISTING_INSERT_COLS}
ON CONFLICT (search_profile_id, dealer_id, normalized_listing_url) WHERE vin IS NULL
DO UPDATE SET ${LISTING_ON_CONFLICT_BODY_ENRICH}
`;

/** Enrich-only positional twin of UPDATE_LIVE_ROW (orphan-prevention path). Same
 *  20-param order as UPDATE_LIVE_ROW so the caller builds ONE param array: every
 *  fill-if-null column is existing-first COALESCE, the inventory_status guard is
 *  a single-bind NULLIF (never-downgrade), and match_status / raw_listing_json
 *  keep the existing value (COALESCE over a NOT NULL column ignores the bind). */
const UPDATE_LIVE_ROW_ENRICH = `
UPDATE inventory_listings SET
  source_id              = COALESCE(source_id, ?),
  stock_number           = COALESCE(stock_number, ?),
  year                   = COALESCE(year, ?),
  make                   = COALESCE(make, ?),
  model                  = COALESCE(model, ?),
  trim                   = COALESCE(trim, ?),
  exterior_color         = COALESCE(exterior_color, ?),
  interior_color         = COALESCE(interior_color, ?),
  listed_price           = COALESCE(listed_price, ?),
  msrp                   = COALESCE(msrp, ?),
  dealer_markup          = COALESCE(dealer_markup, ?),
  pricing_breakdown_json = COALESCE(pricing_breakdown_json, ?),
  inventory_status       = CASE WHEN inventory_status = 'unknown'
    THEN COALESCE(NULLIF(?, 'unknown'), 'unknown') ELSE inventory_status END,
  listing_url            = COALESCE(listing_url, ?),
  normalized_listing_url = COALESCE(normalized_listing_url, ?),
  match_status           = COALESCE(match_status, ?),
  raw_listing_json       = COALESCE(raw_listing_json, ?),
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

// Coverage-collapse guard (truncated-scan protection). A scanned source whose
// live population is at least COVERAGE_COLLAPSE_FLOOR rows is quarantined — its
// stale sweep skipped — when this run re-observed fewer than
// COVERAGE_COLLAPSE_FRACTION of that population. A paginated / JS-render miss
// that returns a sliver of the lot is still status='scanned', so the all-or-
// nothing supersede gate cannot see the partial success; without this brake it
// would mass-retire every unseen car as sold. Small lots (< FLOOR) are exempt
// so genuine turnover on a tiny inventory still retires normally. NOTE: this
// lives in the shared persistScanResults writer, so inventory_link_scan gets
// the same protection — benign there (link-scan sources usually hold < FLOOR
// listings, so the guard rarely trips).
const COVERAGE_COLLAPSE_FLOOR = 6;
const COVERAGE_COLLAPSE_FRACTION = 0.34;

const COUNT_LIVE_FOR_SOURCE = `
SELECT count(*) AS n FROM inventory_listings
WHERE search_profile_id = ? AND source_id = ? AND superseded_at IS NULL
`;

// Rows of this source observed at/after the run watermark — the re-observed and
// newly-added cars (observed_at comparisons are lexicographic == chronological
// for ISO timestamps). The complement of these among the live set is what the
// stale sweep would retire.
const COUNT_FRESH_OBSERVED_FOR_SOURCE = `
SELECT count(*) AS n FROM inventory_listings
WHERE search_profile_id = ? AND source_id = ?
  AND superseded_at IS NULL AND observed_at >= ?
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
  /** source_type + discovery_method for freshly-inserted source rows. Defaults
   *  ('srp' / 'geosearch_website') reproduce the site_scan source grain. */
  sourceType?: string;
  discoveryMethod?: string;
  /** When false, skip the stale sweep AND its coverage-collapse bookkeeping
   *  entirely (staleSuperseded / sourcesQuarantined stay 0). Aggregator writes
   *  pass false — absence from a top-N shopping-site slice is not lot absence. */
  staleSweep?: boolean;
  /** "enrich_only" turns every collision into a fill-if-null / never-downgrade
   *  merge that never overwrites an existing non-null column and emits NO
   *  price_change audit (cross-source disagreement is feed lag, not movement);
   *  fresh inserts still carry full data. Default reproduces the site_scan
   *  new-wins merge. */
  conflictMode?: "default" | "enrich_only";
}): PersistRunResult {
  const db = opts.db ?? getDb();
  const now = opts.now ?? new Date().toISOString();
  const profileId = opts.searchProfileId;
  const sourceType = opts.sourceType ?? "srp";
  const discoveryMethod = opts.discoveryMethod ?? "geosearch_website";
  const staleSweep = opts.staleSweep ?? true;
  const enrichMode = opts.conflictMode === "enrich_only";

  const insertSource = db.$client.prepare(INSERT_SOURCE);
  const markSource = db.$client.prepare(MARK_SOURCE);
  const selectLiveNullVin = db.$client.prepare(SELECT_LIVE_NULL_VIN_ROW);
  const supersedePromoted = db.$client.prepare(SUPERSEDE_VIN_PROMOTED);
  const upsertVinArm = db.$client.prepare(enrichMode ? UPSERT_VIN_ARM_ENRICH : UPSERT_VIN_ARM);
  const selectLiveUrlRow = db.$client.prepare(SELECT_LIVE_URL_ROW);
  const updateLiveRow = db.$client.prepare(enrichMode ? UPDATE_LIVE_ROW_ENRICH : UPDATE_LIVE_ROW);
  const upsertUrlArm = db.$client.prepare(enrichMode ? UPSERT_URL_ARM_ENRICH : UPSERT_URL_ARM);
  const countLive = db.$client.prepare(COUNT_LIVE_FOR_SOURCE);
  const countFreshObserved = db.$client.prepare(COUNT_FRESH_OBSERVED_FOR_SOURCE);
  const selectPriceById = db.$client.prepare(
    "SELECT listed_price FROM inventory_listings WHERE listing_id = ?",
  );
  // Capture the price at a listing_id BEFORE its write, and after the write emit an
  // inventory.price_change audit row iff a NON-NULL new price actually differs from
  // a prior price (a null new price COALESCE-preserves the old → not a change; a
  // null old price is a fresh listing → not a change). Mirrors LISTING_ON_CONFLICT_
  // BODY's COALESCE so no bogus "price -> null" rows are written.
  const priceBefore = (listingId: string): number | null => {
    const r = selectPriceById.get(listingId) as { listed_price: number | null } | undefined;
    return r?.listed_price ?? null;
  };

  const txn = db.$client.transaction((): PersistRunResult => {
    const result: PersistRunResult = {
      sourcesScanned: 0,
      sourcesBlocked: 0,
      sourcesSkipped: 0,
      sourcesFailed: 0,
      listingsWritten: 0,
      vinPromoted: 0,
      priceChanges: 0,
      sourcesQuarantined: 0,
      droppedNoKey: 0,
      staleSuperseded: 0,
    };

    // Emit one inventory.price_change audit row (+ count it) iff a NON-NULL new
    // price actually differs from a prior price — the COALESCE-aware guard above.
    // Notes: a reactivated/relisted car (a not_observed row that returns at a new
    // price) DOES emit (defensible for "price dropped since you last looked"); the
    // VIN-absent (URL) arm passes vin=null even when the existing row is VIN-bearing
    // — the canonical vin is resolvable via the listing_id, which is always exact.
    const recordPriceChange = (
      listingId: string,
      oldPrice: number | null,
      newPrice: number | null | undefined,
      dealerId: string,
      vin: string | null,
    ): void => {
      if (oldPrice !== null && newPrice !== null && newPrice !== undefined && oldPrice !== newPrice) {
        emitInventoryPriceChange({ db, listingId, searchProfileId: profileId, dealerId, vin, oldPrice, newPrice, at: now });
        result.priceChanges += 1;
      }
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
      insertSource.run(
        sourceId,
        profileId,
        outcome.dealerId,
        sourceType,
        outcome.sourceUrl,
        normalizedUrl,
        discoveryMethod,
        now,
      );
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

        // Cross-source MSRP inversion guard. Within one VDP snapshot the same-page
        // harvest resolves an inversion by nulling the *listed price* and trusting
        // the MSRP; an inversion that survives to here is the CROSS-source case —
        // the directly-observed SRP listing price paired with an MSRP fanned out
        // from a possibly-mismatched VDP. Here the reliability flips: the SRP price
        // is the observed field and the MSRP is the derived, cross-attributed one
        // and the likelier mis-parse (e.g. a $19,991 "MSRP" beneath a $33,915
        // listed price), so null the MSRP and keep the price. dealerMarkup is a
        // separate labeled field, so this never disturbs the markup signal.
        const msrp =
          row.msrp != null && row.listing.price != null && row.listing.price > row.msrp
            ? null
            : row.msrp ?? null;

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
          msrp,
          // Harvest-aware sentinel (caller-supplied): 0 / empty-blob string =
          // "VDP visited, none" → CLEAR; null = "not harvested" → PRESERVE.
          row.dealerMarkup ?? null,
          row.pricingBreakdownJson ?? null,
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
          const vinListingId = computeListingId(profileId, outcome.dealerId, vin, nlurl);
          // enrich_only never emits a price_change (cross-source disagreement is
          // feed lag) — skip the priceBefore/recordPriceChange machinery entirely.
          const oldPriceVin = enrichMode ? null : priceBefore(vinListingId);
          upsertVinArm.run(...insertParams(vinListingId));
          result.listingsWritten += 1;
          if (!enrichMode) recordPriceChange(vinListingId, oldPriceVin, row.listing.price, outcome.dealerId, vin);
        } else {
          // VIN-absent arm, with orphan prevention: a live row already owning
          // this URL (possibly VIN-bearing, from the other capture order) is
          // updated in place rather than shadowed by a NULL-VIN companion.
          const existing = selectLiveUrlRow.get(profileId, outcome.dealerId, nlurl) as
            | { listing_id: string }
            | undefined;
          if (existing !== undefined) {
            const oldPriceUrl = enrichMode ? null : priceBefore(existing.listing_id);
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
              msrp,
              // Harvest-aware sentinel (same order as UPDATE_LIVE_ROW's new ?s,
              // BEFORE the trailing listing_id): 0/empty-blob CLEARS, null PRESERVES.
              row.dealerMarkup ?? null,
              row.pricingBreakdownJson ?? null,
              row.listing.inventory_status,
              listingUrl,
              nlurl,
              row.matchStatus,
              rawJson,
              now,
              now,
              existing.listing_id,
            );
            if (!enrichMode) recordPriceChange(existing.listing_id, oldPriceUrl, row.listing.price, outcome.dealerId, null);
          } else {
            const urlListingId = computeListingId(profileId, outcome.dealerId, null, nlurl);
            // a reactivated row carries a prior price (default mode only)
            const oldPriceNew = enrichMode ? null : priceBefore(urlListingId);
            upsertUrlArm.run(...insertParams(urlListingId));
            if (!enrichMode) recordPriceChange(urlListingId, oldPriceNew, row.listing.price, outcome.dealerId, null);
          }
          result.listingsWritten += 1;
        }
      }

      // Fresh full scan: retire this source's rows not observed by THIS run —
      // UNLESS the coverage-collapse guard trips. A scanned-but-truncated
      // capture (pagination / JS render returned a fraction of the lot) would
      // otherwise mass-retire every unseen car as sold; quarantine the sweep
      // instead so the unseen rows stay live (and age into the stale freshness
      // bucket). RECOVERY IS CONDITIONAL: a transient truncation self-heals —
      // the next full scan re-observes the lot and the genuinely-gone cars
      // retire normally. But a GENUINE sustained loss of more than
      // (1 - COVERAGE_COLLAPSE_FRACTION) of the lot keeps tripping the guard, so
      // those rows stay live until a healthy scan — a deliberate conservative
      // tradeoff (keep stale-but-present data over mass-false-sold). The
      // quarantine is surfaced via result.sourcesQuarantined for visibility; an
      // auto-resolving age / consecutive-quarantine backstop is a follow-up.
      //
      // staleSweep === false skips the sweep AND its bookkeeping entirely: a
      // shopping-site scan only ever sees a top-N slice, so absence from it is
      // never absence-from-lot evidence (those rows age via last_seen_at only).
      if (!staleSweep) continue;
      const liveNow = (countLive.get(profileId, sourceId) as { n: number }).n;
      const freshObserved = (
        countFreshObserved.get(profileId, sourceId, opts.runStartedAt) as { n: number }
      ).n;
      if (liveNow >= COVERAGE_COLLAPSE_FLOOR && freshObserved < COVERAGE_COLLAPSE_FRACTION * liveNow) {
        result.sourcesQuarantined += 1;
      } else {
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
    }

    return result;
  });

  return txn();
}
