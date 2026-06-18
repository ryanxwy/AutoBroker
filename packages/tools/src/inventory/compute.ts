/**
 * Profile-scoped inventory ranking for /inventory_compare — the DB-read +
 * ranker glue. Reads one profile's row to build the match context, reads its
 * live listings (joined to dealers for the distance axis), runs the pure
 * deterministic ranker, and maps each ranked row + its source listing to the
 * flat RankedCandidate the workflow surfaces. No writes, no network.
 *
 * SQLITE INVARIANT: only packages/tools (and db beneath it) touch the product
 * DB. Raw better-sqlite3 statements via db.$client — NO drizzle-orm import.
 * Read-only: the ranker's match_status / score are transient (never persisted;
 * there is no match_score / score column).
 */

import type { Db } from "@autobroker/db";

import { listListingsForProfile } from "./read.js";
import {
  rankListings,
  type ProfileMatchCtx,
  type RankedRow,
} from "./inventory_rank.js";

/** A recommended candidate satisfies all three: a match_status of exact/near, an
 *  inventory_status of in_stock/in_transit, and a composite score >= 0.6. */
const RECOMMENDED_MATCH_STATUSES = new Set(["exact", "near"]);
const RECOMMENDED_INVENTORY_STATUSES = new Set(["in_stock", "in_transit"]);
const RECOMMENDED_MIN_SCORE = 0.6;

/**
 * One ranked inventory listing as the workflow surfaces it. Flat,
 * all-required-with-explicit-null. `vin` is the FULL 17-char string (never
 * tail-only); `stock_number` is null when the listing carries none (the rail
 * renders an em-dash). `inventory_status` / `dealer_id` are NOT NULL columns.
 * `match_status` is recomputed at rank time, never persisted.
 * `recommended` is the SINGLE source of the three-condition predicate:
 * true ⇔ match exact/near AND inventory in_stock/in_transit AND score >= 0.6.
 */
export interface RankedCandidate {
  listing_id: string;
  vin: string | null;
  stock_number: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  exterior_color: string | null;
  /** The listing's own vehicle-detail-page (VDP) href, or null — lets the card
   *  click through to the dealer's public stock page. A public URL, never budget. */
  listing_url: string | null;
  listed_price: number | null;
  msrp: number | null;
  inventory_status: string;
  dealer_id: string;
  dealer_name: string | null;
  distance_miles: number | null;
  score: number;
  reasons: string[];
  match_status: "exact" | "near" | "mismatch" | "unknown";
  /** true ⇔ match exact/near AND inventory in_stock/in_transit AND score >= 0.6.
   *  The SINGLE source of the recommended predicate; never re-derived from the three
   *  individual fields downstream. */
  recommended: boolean;
}

/** The result of ranking one profile's live inventory. */
export interface RankInventoryResult {
  /** Ranked candidates, score DESC then listing_id ASC (post-filter). */
  candidates: RankedCandidate[];
  /** The newest `last_seen_at` over the candidates (ISO string), or null when
   *  there are no candidates / none carry a usable value. */
  scannedAtMax: string | null;
  /** Candidate count (post hard-filter). */
  totalListings: number;
  /** Candidates satisfying the three-condition recommended predicate. */
  recommendedCount: number;
  /** # of dealer_inventory_sources rows with last_status='scanned' for this
   *  profile — i.e. dealer sites a site_scan actually reached. >0 distinguishes
   *  "a scan ran and found 0" from "no scan has ever run" in the empty-state copy. */
  sourcesScanned: number;
  /** # of dealer_inventory_sources rows with last_status='blocked' (sites that
   *  blocked automated scanning). */
  sourcesBlocked: number;
}

// ---------------------------------------------------------------------------
// loose-row coercion helpers (DB projection rows are snake_case dicts)
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Defensive JSON-array parse for the profile's `*_json` blobs: a malformed or
 *  non-array value yields null (the ranker treats null as "no preference"). */
function parseJsonStringArray(raw: unknown): string[] | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return null;
  }
}

/** Build the ranker's profile context from a raw search_profiles row. Radius
 *  defaults to 25 when null (the schema default); budget null disables the
 *  over-budget filter. */
function buildMatchCtx(profileRow: Record<string, unknown>): ProfileMatchCtx {
  return {
    profile_year: asNumber(profileRow["year"]) ?? asString(profileRow["year"]),
    profile_make: asString(profileRow["make"]),
    profile_model: asString(profileRow["model"]),
    profile_trim: asString(profileRow["trim"]),
    acceptable_trims: parseJsonStringArray(profileRow["acceptable_trims_json"]),
    preferred_exterior_colors: parseJsonStringArray(
      profileRow["preferred_exterior_colors_json"],
    ),
    search_radius_miles: asNumber(profileRow["search_radius_miles"]) ?? 25,
    budget_max: asNumber(profileRow["budget_max"]),
  };
}

/** Map a ranked row + its source listing to the flat RankedCandidate. */
function toCandidate(ranked: RankedRow): RankedCandidate {
  const listing = ranked.listing;
  const match_status = ranked.match_status as RankedCandidate["match_status"];
  const inventory_status = asString(listing["inventory_status"]) ?? "";
  const score = ranked.score;
  // Compute the recommended flag here — the SINGLE source so count and flags agree.
  const recommended =
    RECOMMENDED_MATCH_STATUSES.has(match_status) &&
    RECOMMENDED_INVENTORY_STATUSES.has(inventory_status) &&
    score >= RECOMMENDED_MIN_SCORE;
  return {
    listing_id: ranked.listing_id,
    vin: asString(listing["vin"]),
    stock_number: asString(listing["stock_number"]),
    year: asNumber(listing["year"]),
    make: asString(listing["make"]),
    model: asString(listing["model"]),
    trim: asString(listing["trim"]),
    exterior_color: asString(listing["exterior_color"]),
    listing_url: asString(listing["listing_url"]),
    listed_price: asNumber(listing["listed_price"]),
    msrp: asNumber(listing["msrp"]),
    // inventory_status / dealer_id are NOT NULL columns; default to "" defensively.
    inventory_status,
    dealer_id: asString(listing["dealer_id"]) ?? "",
    dealer_name: asString(listing["dealer_name"]),
    distance_miles: asNumber(listing["distance_miles"]),
    score,
    reasons: ranked.reasons,
    match_status,
    recommended,
  };
}

const SELECT_PROFILE = "SELECT * FROM search_profiles WHERE search_profile_id = ?";

/**
 * Rank one profile's live inventory listings. Reads the profile row + its
 * listings (joined to dealers), runs the pure ranker, and returns the flat
 * candidates plus the header tallies. A profile with no row yields an empty
 * result (the caller resolves existence; this is defensive). Read-only.
 */
export function rankInventoryForProfile(db: Db, profileId: string): RankInventoryResult {
  const profileRow = db.$client.prepare(SELECT_PROFILE).get(profileId) as
    | Record<string, unknown>
    | undefined;
  if (profileRow === undefined) {
    return {
      candidates: [],
      scannedAtMax: null,
      totalListings: 0,
      recommendedCount: 0,
      sourcesScanned: 0,
      sourcesBlocked: 0,
    };
  }

  // Scan provenance: how many dealer sites a site_scan actually reached vs were
  // blocked. Lets the empty-state distinguish "scan ran, found 0" from "never
  // scanned" (read-only; dealer_inventory_sources is written only by site_scan).
  const sourceTally = db.$client
    .prepare(
      "SELECT " +
        "SUM(CASE WHEN last_status = 'scanned' THEN 1 ELSE 0 END) AS scanned, " +
        "SUM(CASE WHEN last_status = 'blocked' THEN 1 ELSE 0 END) AS blocked " +
        "FROM dealer_inventory_sources WHERE search_profile_id = ?",
    )
    .get(profileId) as { scanned: number | null; blocked: number | null } | undefined;
  const sourcesScanned = Number(sourceTally?.scanned ?? 0);
  const sourcesBlocked = Number(sourceTally?.blocked ?? 0);

  const ctx = buildMatchCtx(profileRow);
  const { listings, dealerDistances } = listListingsForProfile(db, profileId);
  const ranked = rankListings(ctx, listings, dealerDistances);
  const candidates = ranked.map(toCandidate);

  // scannedAtMax = max last_seen_at over the (post-filter) candidate listings.
  // Listings carry last_seen_at as an ISO/text timestamp; pick the lexically
  // greatest non-empty value (ISO-8601 sorts chronologically).
  let scannedAtMax: string | null = null;
  for (const r of ranked) {
    const seen = asString(r.listing["last_seen_at"]);
    if (seen !== null && seen !== "" && (scannedAtMax === null || seen > scannedAtMax)) {
      scannedAtMax = seen;
    }
  }

  // Derive the count from the per-candidate flag — count and flags can never disagree.
  const recommendedCount = candidates.filter((c) => c.recommended).length;

  return {
    candidates,
    scannedAtMax,
    totalListings: candidates.length,
    recommendedCount,
    sourcesScanned,
    sourcesBlocked,
  };
}
