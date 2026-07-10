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
import { collapseSameVinAcrossDealers } from "./aggregatorPersist.js";
import { classifyColorAvailability, normalizeColor } from "./colorMatch.js";
import {
  rankListings,
  type ProfileMatchCtx,
  type RankedRow,
} from "./inventory_rank.js";

/** A recommended candidate satisfies all three: a match_status of exact/near, an
 *  inventory_status of in_stock/in_transit/unknown, and a composite score >= 0.6.
 *  `unknown` is included because many dealer platforms list a new car on the SRP
 *  with no availability badge the scraper recognizes, so the listing persists
 *  `unknown` — withholding a recommendation from an on-model, in-budget, in-radius
 *  car purely because its availability could not be READ would silently kill the
 *  recommendation engine on those platforms. The score >= 0.6 + exact/near gates
 *  still bound the set; `ordered`/`sold` stay excluded; and an `unknown`-availability
 *  recommendation is surfaced with an "availability unconfirmed" caveat (the data
 *  layer keeps the `unknown` distinction, so the UI never claims a confirmed stock). */
const RECOMMENDED_MATCH_STATUSES = new Set(["exact", "near"]);
const RECOMMENDED_INVENTORY_STATUSES = new Set(["in_stock", "in_transit", "unknown"]);
const RECOMMENDED_MIN_SCORE = 0.6;

/**
 * One ranked inventory listing as the workflow surfaces it. Flat,
 * all-required-with-explicit-null. `vin` is the FULL 17-char string (never
 * tail-only); `stock_number` is null when the listing carries none (the rail
 * renders an em-dash). `inventory_status` / `dealer_id` are NOT NULL columns.
 * `match_status` is recomputed at rank time, never persisted.
 * `recommended` is the SINGLE source of the three-condition predicate:
 * true ⇔ match exact/near AND inventory in_stock/in_transit/unknown AND score >= 0.6.
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
  interior_color: string | null;
  /** The listing's own vehicle-detail-page (VDP) href, or null — lets the card
   *  click through to the dealer's public stock page. A public URL, never budget. */
  listing_url: string | null;
  listed_price: number | null;
  msrp: number | null;
  /** The dealer's own LABELED market adjustment (markup) in dollars, or null when
   *  none was harvested. Only a labeled ADM line is ever stored — never a
   *  selling>MSRP inference. */
  dealer_markup: number | null;
  /** Dealer add-on line items (the junk buyers hate), parsed from the
   *  pricing_breakdown_json blob; [] when none were captured. */
  add_ons: { label: string; amount: number }[];
  /** Sum of the add-on amounts in dollars, or null. */
  addons_total: number | null;
  /** A LABELED dealer discount (savings off MSRP) in dollars, or null — recovered
   *  by the folded LLM price-block read (the deterministic harvest omits it). */
  dealer_discount: number | null;
  /** A short verbatim manufacturer-incentive phrase, or null. Same provenance. */
  incentives_text: string | null;
  /** true when the listing price was hidden behind a "Get your price" CTA. */
  price_gated: boolean;
  /** true ⇔ a price-stack region was actually read on the VDP. false means "no
   *  breakdown captured" (a null/absent/unparseable blob) — the UI renders this
   *  as "couldn't read", distinct from "harvested, found nothing". */
  breakdown_parsed: boolean;
  inventory_status: string;
  dealer_id: string;
  dealer_name: string | null;
  distance_miles: number | null;
  /** The joined source row's type — 'aggregator_srp' for a shopping-site listing
   *  (Cars.com/visor.vin/Edmunds), null for a dealer-site listing (no aggregator
   *  source). Drives the "via {host}" provenance line. */
  source_type: string | null;
  /** The hostname of the joined source_url (e.g. "www.cars.com"), or null — the
   *  host-only text the provenance line renders. Computed in code from source_url. */
  source_host: string | null;
  score: number;
  reasons: string[];
  match_status: "exact" | "near" | "mismatch" | "unknown";
  /** true ⇔ match exact/near AND inventory in_stock/in_transit/unknown AND score >= 0.6.
   *  The SINGLE source of the recommended predicate; never re-derived from the three
   *  individual fields downstream. */
  recommended: boolean;
}

/** The result of ranking one profile's live inventory. */
export interface RankInventoryResult {
  /** Ranked candidates, match tier (exact/near before mismatch/unknown) then
   *  score DESC then listing_id ASC (post-filter). */
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
  /** # of shopping-site sources (source_type='aggregator_srp') with
   *  last_status='scanned' — Cars.com/visor.vin/Edmunds an aggregator scan
   *  reached, counted SEPARATELY from dealer sites so the empty-state can say
   *  "shopping sites" distinctly. */
  shoppingSourcesScanned: number;
  /** # of shopping-site sources (source_type='aggregator_srp') with
   *  last_status='blocked' — shopping sites that blocked automated scanning. */
  shoppingSourcesBlocked: number;
  /** # of same-(profile, VIN) rows collapsed across different dealer_ids in this
   *  projection (the aggregator/dealer duplicate belt — a VIN under both a minted
   *  aggregator rooftop and the real dealer rooftop shows once), or 0. */
  sameVinCollapsed: number;
  /** Distinct trim strings over ALL of the profile's live listings — the
   *  UNFILTERED set (before the budget/availability hard-filter), so trim
   *  grounding sees a trim a dealer stocks even when it is over budget or
   *  on-order. Verbatim dealer strings (e.g. "LX CVT", "EX-L Hybrid"). */
  allInventoryTrims: string[];
  /** Distinct exterior-color names over ALL the profile's live listings (the
   *  UNFILTERED set, mirroring allInventoryTrims) — the REAL stocked names the
   *  color cross-check reconciles loose prefs against. */
  allInventoryColors: string[];
  /** Color config cross-check advisory — per UNMATCHED preferred color (the
   *  ranker's colorAxis is EXACT equality, so a loose "red" scores low against
   *  "Radiant Red Metallic II"), the real stocked names to OFFER so the buyer can
   *  ADD the canonical name (then colorAxis fires). Only the actionable ones — a
   *  real whole-token overlap exists AND the canonical name is not already a pref
   *  / equal to the pref verbatim — appear; [] when every preferred color already
   *  matches exactly or nothing overlaps. ASSIST-only: never auto-written. */
  colorCrossCheck: { requested: string; suggestions: string[] }[];
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

/** The hostname of a listing's joined source_url (e.g. "www.cars.com"), or null
 *  when there is no source join or the value is absent/unparseable. Host-only —
 *  never the full path (the provenance line shows just the site). */
function sourceHostOf(sourceUrl: string | null): string | null {
  if (sourceUrl === null || sourceUrl.trim() === "") return null;
  try {
    return new URL(sourceUrl).hostname;
  } catch {
    return null;
  }
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

/** The structured pricing breakdown projected from a listing's
 *  `pricing_breakdown_json` text column. */
interface ParsedBreakdown {
  add_ons: { label: string; amount: number }[];
  addons_total: number | null;
  /** A LABELED dealer discount (savings off MSRP) in dollars, or null. Recovered
   *  only by the folded LLM price-block read; the deterministic harvest omits it. */
  dealer_discount: number | null;
  /** A short verbatim manufacturer-incentive phrase (e.g. "$500 military rebate"),
   *  or null. Same provenance as dealer_discount. */
  incentives_text: string | null;
  price_gated: boolean;
  breakdown_parsed: boolean;
}

/** The honest "no breakdown captured" default — used when the column is
 *  null/absent/unparseable. breakdown_parsed false means "couldn't read", which
 *  the UI distinguishes from a parsed-but-empty breakdown (breakdownParsed true,
 *  no add-ons). */
const EMPTY_BREAKDOWN: ParsedBreakdown = {
  add_ons: [],
  addons_total: null,
  dealer_discount: null,
  incentives_text: null,
  price_gated: false,
  breakdown_parsed: false,
};

/** Defensively parse the `pricing_breakdown_json` blob
 *  (`{addOns, addonsTotal, priceGated, breakdownParsed}`, camelCase). NEVER
 *  throws: a null/absent column, malformed JSON, or a non-object payload all
 *  yield EMPTY_BREAKDOWN. Add-on entries that aren't {label:string,
 *  amount:finite-number} are dropped. */
function parseBreakdown(raw: unknown): ParsedBreakdown {
  if (typeof raw !== "string" || raw.trim() === "") return EMPTY_BREAKDOWN;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_BREAKDOWN;
  }
  if (typeof parsed !== "object" || parsed === null) return EMPTY_BREAKDOWN;
  const blob = parsed as Record<string, unknown>;
  const add_ons: { label: string; amount: number }[] = [];
  const rawAddOns = blob["addOns"];
  if (Array.isArray(rawAddOns)) {
    for (const entry of rawAddOns) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const label = e["label"];
      const amount = e["amount"];
      if (typeof label === "string" && typeof amount === "number" && Number.isFinite(amount)) {
        add_ons.push({ label, amount });
      }
    }
  }
  let incentives_text: string | null = null;
  const rawIncentives = blob["incentivesText"];
  if (typeof rawIncentives === "string" && rawIncentives.trim() !== "") {
    incentives_text = rawIncentives;
  }
  return {
    add_ons,
    addons_total: asNumber(blob["addonsTotal"]),
    dealer_discount: asNumber(blob["dealerDiscount"]),
    incentives_text,
    price_gated: blob["priceGated"] === true,
    breakdown_parsed: blob["breakdownParsed"] === true,
  };
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
  const breakdown = parseBreakdown(listing["pricing_breakdown_json"]);
  return {
    listing_id: ranked.listing_id,
    vin: asString(listing["vin"]),
    stock_number: asString(listing["stock_number"]),
    year: asNumber(listing["year"]),
    make: asString(listing["make"]),
    model: asString(listing["model"]),
    trim: asString(listing["trim"]),
    exterior_color: asString(listing["exterior_color"]),
    interior_color: asString(listing["interior_color"]),
    listing_url: asString(listing["listing_url"]),
    listed_price: asNumber(listing["listed_price"]),
    msrp: asNumber(listing["msrp"]),
    dealer_markup: asNumber(listing["dealer_markup"]),
    add_ons: breakdown.add_ons,
    addons_total: breakdown.addons_total,
    dealer_discount: breakdown.dealer_discount,
    incentives_text: breakdown.incentives_text,
    price_gated: breakdown.price_gated,
    breakdown_parsed: breakdown.breakdown_parsed,
    // inventory_status / dealer_id are NOT NULL columns; default to "" defensively.
    inventory_status,
    dealer_id: asString(listing["dealer_id"]) ?? "",
    dealer_name: asString(listing["dealer_name"]),
    distance_miles: asNumber(listing["distance_miles"]),
    // Provenance from the source-row join (both null for a dealer-site listing).
    source_type: asString(listing["source_type"]),
    source_host: sourceHostOf(asString(listing["source_url"])),
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
      shoppingSourcesScanned: 0,
      shoppingSourcesBlocked: 0,
      sameVinCollapsed: 0,
      allInventoryTrims: [],
      allInventoryColors: [],
      colorCrossCheck: [],
    };
  }

  // Scan provenance: how many sources a scan actually reached vs were blocked,
  // SPLIT by source_type so the empty-state can speak of dealer sites and
  // shopping sites (Cars.com/visor.vin/Edmunds) distinctly. Dealer sources keep the
  // sourcesScanned/sourcesBlocked meaning (backward compat); aggregator_srp
  // sources feed the shopping* counts. Read-only.
  const sourceTally = db.$client
    .prepare(
      "SELECT " +
        "SUM(CASE WHEN source_type != 'aggregator_srp' AND last_status = 'scanned' THEN 1 ELSE 0 END) AS dealer_scanned, " +
        "SUM(CASE WHEN source_type != 'aggregator_srp' AND last_status = 'blocked' THEN 1 ELSE 0 END) AS dealer_blocked, " +
        "SUM(CASE WHEN source_type = 'aggregator_srp' AND last_status = 'scanned' THEN 1 ELSE 0 END) AS shopping_scanned, " +
        "SUM(CASE WHEN source_type = 'aggregator_srp' AND last_status = 'blocked' THEN 1 ELSE 0 END) AS shopping_blocked " +
        "FROM dealer_inventory_sources WHERE search_profile_id = ?",
    )
    .get(profileId) as
    | {
        dealer_scanned: number | null;
        dealer_blocked: number | null;
        shopping_scanned: number | null;
        shopping_blocked: number | null;
      }
    | undefined;
  const sourcesScanned = Number(sourceTally?.dealer_scanned ?? 0);
  const sourcesBlocked = Number(sourceTally?.dealer_blocked ?? 0);
  const shoppingSourcesScanned = Number(sourceTally?.shopping_scanned ?? 0);
  const shoppingSourcesBlocked = Number(sourceTally?.shopping_blocked ?? 0);

  const ctx = buildMatchCtx(profileRow);
  const { listings, dealerDistances } = listListingsForProfile(db, profileId);
  const ranked = rankListings(ctx, listings, dealerDistances);
  // Read-time same-VIN collapse belt: a VIN that lives under both a minted
  // aggregator rooftop and the real dealer rooftop shows once (the richer,
  // non-aggregator row wins). Applied AFTER ranking so the collapse follows the
  // ranked order; the counts below reflect the collapsed (shown) set.
  const { rows: candidates, collapsedCount: sameVinCollapsed } = collapseSameVinAcrossDealers(
    ranked.map(toCandidate),
  );

  // Distinct trims over the UNFILTERED listings (before the budget/availability
  // hard-filter) — so trim grounding sees a trim a dealer stocks even when it is
  // over budget or on-order, never falsely reporting "no dealer carries it".
  const allInventoryTrims = [
    ...new Set(
      listings
        .map((l) => asString(l["trim"]))
        .filter((t): t is string => t !== null && t.trim() !== ""),
    ),
  ];

  // Distinct stocked exterior-color names over the SAME unfiltered set — the
  // ground truth for the color cross-check (mirrors allInventoryTrims).
  const allInventoryColors = [
    ...new Set(
      listings
        .map((l) => asString(l["exterior_color"]))
        .filter((c): c is string => c !== null && c.trim() !== ""),
    ),
  ];

  // Color config cross-check: reconcile the buyer's loose preferred colors to the
  // real stocked names. The ranker's colorAxis is EXACT equality, so a loose
  // "red" never fires against "Radiant Red Metallic II". Surface the canonical
  // stocked names to OFFER (the buyer taps to add one — assist, never auto-write).
  // "Actionable" (what the UI shows) = a stocked name whole-token-overlaps the
  // loose pref AND that canonical name is not already in the prefs / equal to the
  // pref verbatim. (If it were, colorAxis already fires → nothing to do — i.e.
  // the requested color is "unmatched" by the EXACT ranker yet HAS a real name to
  // suggest.) Degrades to [] for no inventory / all-already-matched prefs.
  const preferredColors = ctx.preferred_exterior_colors ?? [];
  const prefNormSet = new Set(preferredColors.map(normalizeColor));
  const colorCrossCheck = classifyColorAvailability(preferredColors, allInventoryColors)
    .map((c) => {
      const reqNorm = normalizeColor(c.requested);
      const suggestions = c.suggestions.filter((s) => {
        const n = normalizeColor(s);
        return n !== reqNorm && !prefNormSet.has(n);
      });
      return { requested: c.requested, suggestions };
    })
    .filter((c) => c.suggestions.length > 0);

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
    shoppingSourcesScanned,
    shoppingSourcesBlocked,
    sameVinCollapsed,
    allInventoryTrims,
    allInventoryColors,
    colorCrossCheck,
  };
}
