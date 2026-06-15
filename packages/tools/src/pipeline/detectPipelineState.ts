/**
 * detectPipelineState — the pure-SQL re-derivation of which of the four
 * pipeline child steps still have work to do for one profile. Run FRESH on
 * every pipeline invocation: there is NO checkpoint table, so a re-run after a
 * partial pass picks up only the still-applicable steps (the non-durable
 * parity delta). Each predicate is an existence check over output rows; the
 * child idempotency keys (the dealer_quotes / quote_audits UNIQUE indexes and
 * the 7-day incentive cache) are what prevent re-running a still-applicable
 * step from duplicating.
 *
 * The four predicates (canonical fan-out order extract → scrape → audit →
 * compare):
 *
 *   extract  — a `messages` row for the profile whose quote_extraction_status
 *              is 'pending' (the un-extracted reply). The status enum is
 *              pending/succeeded/failed; 'pending' is the only un-extracted
 *              class. We NEVER read or mutate messages.processed_at here.
 *
 *   scrape   — the profile's vehicle (make, model) has NO manufacturer_incentives
 *              row scraped within the last 7 days. The cache row key is
 *              (make, model, zip); the profile carries make/model/postal_code,
 *              so the predicate joins the profile's vehicle + zip to the cache
 *              and asks "is there a fresh row?" — absence (or a stale row) means
 *              scrape is applicable. Boundary: a row scraped EXACTLY 7 days ago
 *              is still fresh (window inclusive), mirroring the cache gate.
 *
 *   audit    — a `dealer_quotes` row for the profile that lacks a `quote_audits`
 *              row at the CURRENT audit_pass_version. audit_pass_version has no
 *              source constant in this layer (the audit skill defines it), so it
 *              is a REQUIRED parameter — never hardcoded here.
 *
 *   compare  — at least two dealer_quotes rows exist for the profile (the
 *              comparable set). Pure existence count ≥ 2.
 *
 * SQLITE INVARIANT: reads go through the raw better-sqlite3 handle (db.$client)
 * like the sibling persist/watermark modules — tools never imports drizzle-orm
 * operators.
 */

import type { Db } from "@autobroker/db";

/** Inclusive 7-day freshness window for the incentive scrape predicate. A row
 *  scraped exactly 7 days before `nowMs` is still fresh. */
const SCRAPE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface DetectPipelineStateArgs {
  searchProfileId: string;
  /** The current audit pass version (defined by the audit skill; passed in,
   *  never hardcoded). */
  auditPassVersion: string;
  /** Epoch-ms "now" used by the scrape 7-day window. */
  nowMs: number;
  db?: Db;
}

/** The four applicable-step flags, in canonical order. */
export interface PipelineStateFlags {
  extract: boolean;
  scrape: boolean;
  audit: boolean;
  compare: boolean;
}

// A 'pending' message for the profile = an un-extracted reply.
const SELECT_HAS_PENDING_MESSAGE = `
SELECT 1
  FROM messages
 WHERE search_profile_id = ?
   AND quote_extraction_status = 'pending'
 LIMIT 1
`;

// The profile's vehicle make/model/zip — the scrape predicate's left side.
const SELECT_PROFILE_VEHICLE = `
SELECT make, model, postal_code
  FROM search_profiles
 WHERE search_profile_id = ?
 LIMIT 1
`;

// The scraped_at markers for the profile's (make, model, zip) slice. make/model
// matched case-insensitively (one logical slice cannot fork on letter case,
// mirroring the persist writer); zip exact. scraped_at is stored as an ISO-8601
// STRING by the incentive writer, so freshness is decided in JS (Date.parse) —
// NOT via a SQL `scraped_at >= <epoch-ms>` filter, which compares a TEXT column
// against a number and (since SQLite sorts every TEXT value above every number)
// would report EVERY row as fresh, so the scrape step would never fire.
const SELECT_INCENTIVE_SCRAPED_ATS = `
SELECT scraped_at
  FROM manufacturer_incentives
 WHERE LOWER(make) = LOWER(?)
   AND LOWER(model) = LOWER(?)
   AND zip = ?
`;

// A dealer_quote for the profile lacking a quote_audits row at the current
// pass version (the un-audited quote). NOT EXISTS over the (dealer_quote_id,
// audit_pass_version) UNIQUE pair.
const SELECT_HAS_UNAUDITED_QUOTE = `
SELECT 1
  FROM dealer_quotes dq
 WHERE dq.search_profile_id = ?
   AND NOT EXISTS (
         SELECT 1
           FROM quote_audits qa
          WHERE qa.dealer_quote_id = dq.quote_id
            AND qa.audit_pass_version = ?
       )
 LIMIT 1
`;

// ≥2 comparable dealer_quotes for the profile.
const SELECT_QUOTE_COUNT = `
SELECT COUNT(*) AS n
  FROM dealer_quotes
 WHERE search_profile_id = ?
`;

/**
 * Re-derive the four applicable-step flags for one profile from the live DB.
 * Pure read; no writes, no checkpoint. The scrape predicate is FALSE-by-skip
 * only when a fresh row already covers the slice — a profile with no vehicle
 * row (impossible in practice, defensive) yields scrape=false (nothing to key
 * the scrape on).
 */
export function detectPipelineState(args: DetectPipelineStateArgs): PipelineStateFlags {
  const db = args.db;
  if (db === undefined) {
    throw new Error("detectPipelineState: a db handle is required");
  }
  const profileId = args.searchProfileId;

  const hasPending =
    db.$client.prepare(SELECT_HAS_PENDING_MESSAGE).get(profileId) !== undefined;

  const vehicle = db.$client.prepare(SELECT_PROFILE_VEHICLE).get(profileId) as
    | { make?: unknown; model?: unknown; postal_code?: unknown }
    | undefined;

  let needsScrape = false;
  if (
    vehicle !== undefined &&
    typeof vehicle.make === "string" &&
    typeof vehicle.model === "string" &&
    typeof vehicle.postal_code === "string"
  ) {
    const freshCutoffMs = args.nowMs - SCRAPE_CACHE_TTL_MS;
    const scrapedRows = db.$client
      .prepare(SELECT_INCENTIVE_SCRAPED_ATS)
      .all(vehicle.make, vehicle.model, vehicle.postal_code) as { scraped_at?: unknown }[];
    // A row is fresh iff its scraped_at parses to a time at/after the cutoff
    // (window inclusive — a row scraped exactly 7 days ago is still fresh). The
    // canonical stored form is an ISO-8601 string (Date.parse); a numeric
    // epoch-ms is also accepted defensively. Unparseable/missing → not fresh
    // (fail-open to scrape, matching the incentive cache gate).
    const hasFresh = scrapedRows.some((r) => {
      const raw = r.scraped_at;
      const ms = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
      return Number.isFinite(ms) && ms >= freshCutoffMs;
    });
    // Scrape is applicable iff no fresh row covers the slice.
    needsScrape = !hasFresh;
  }

  const hasUnaudited =
    db.$client.prepare(SELECT_HAS_UNAUDITED_QUOTE).get(profileId, args.auditPassVersion) !==
    undefined;

  const countRow = db.$client.prepare(SELECT_QUOTE_COUNT).get(profileId) as
    | { n?: unknown }
    | undefined;
  const quoteCount = typeof countRow?.n === "number" ? countRow.n : 0;

  return {
    extract: hasPending,
    scrape: needsScrape,
    audit: hasUnaudited,
    compare: quoteCount >= 2,
  };
}
