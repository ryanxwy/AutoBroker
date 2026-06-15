/**
 * Pure ranking math for /inventory_compare — the deterministic inventory
 * ranker. No DB, no network, no write contracts: it consumes the dict-shaped
 * rows the listings read helper returns and produces ranked rows for the rail.
 *
 * Four weighted axes (sum exactly 1.0): trim (0.45), price (0.25), color
 * (0.15), distance (0.15). Weights are module constants — not profile-tunable.
 * `match_status` is recomputed at rank time and never persisted (no score /
 * match_status column is written by this skill).
 */

import { classifyMatchStatus } from "./pure.js";

// ---------------------------------------------------------------------------
// Weights — sum is exactly 1.0 (frozen by a unit test).
// ---------------------------------------------------------------------------

export const TRIM_WEIGHT = 0.45;
export const PRICE_WEIGHT = 0.25;
export const COLOR_WEIGHT = 0.15;
export const DISTANCE_WEIGHT = 0.15;

const PRICE_FLOOR_FACTOR = 0.95; // floor = 0.95 * msrp
const PRICE_CLIP_MAX = 0.2; // clip ((listed - floor) / floor) at 0.20
const NO_COLOR_PREFERENCE = "no preference"; // sentinel (lowercased)
const OTHER_COLOR_SCORE = 0.2; // non-preferred / missing-color color score

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Profile-side context the ranker needs. `search_radius_miles` is NOT
 *  nullable; `budget_max` null disables the over-budget filter. */
export interface ProfileMatchCtx {
  profile_year: number | string | null;
  profile_make: string | null;
  profile_model: string | null;
  profile_trim: string | null;
  acceptable_trims: string[] | null;
  preferred_exterior_colors: string[] | null;
  search_radius_miles: number;
  budget_max: number | null;
}

/** One ranked listing. `listing` is the original dict-shaped row. */
export interface RankedRow {
  listing_id: string;
  score: number;
  reasons: string[];
  match_status: string;
  listing: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Coercion helpers — rows are loose snake_case dicts (DB projection shape).
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clip(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/** statistics.median parity: sorted, even-length = MEAN of the two middles
 *  (SQLite/JS have no builtin). Caller guarantees a non-empty input. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ---------------------------------------------------------------------------
// Axis scoring
// ---------------------------------------------------------------------------

/** Trim axis: exact → 1.0/trim_exact; acceptable → 0.7/trim_acceptable; else
 *  → 0.0/trim_off. Case-insensitive on all three sides; always exactly one
 *  chip. */
function trimAxis(
  listingTrim: string | null,
  profileTrim: string | null,
  acceptableTrims: string[] | null,
): [number, string] {
  const listingLc = (listingTrim ?? "").trim().toLowerCase();
  const profileLc = (profileTrim ?? "").trim().toLowerCase();

  if (profileLc !== "" && listingLc !== "" && listingLc === profileLc) {
    return [1.0, "trim_exact"];
  }

  const acceptableLc = new Set(
    (acceptableTrims ?? []).filter((t) => t).map((t) => (t ?? "").trim().toLowerCase()),
  );
  if (listingLc !== "" && acceptableLc.has(listingLc)) {
    return [0.7, "trim_acceptable"];
  }

  return [0.0, "trim_off"];
}

/** Price axis: 1 - clip((listed - floor)/floor, 0, 0.20), floor = 0.95*msrp
 *  (or 0.95*median when msrp absent). Neutral 0.5 fallbacks for a missing
 *  price / no floor basis / non-positive floor. Discount chip "{pct}% under
 *  MSRP" only when msrp present, listed < msrp, and pct >= 1 (pct off RAW
 *  msrp). */
function priceAxis(
  listedPrice: number | null,
  msrp: number | null,
  medianListedPrice: number | null,
): [number, string | null] {
  if (listedPrice === null) return [0.5, "price_missing"];

  let floor: number;
  if (msrp !== null) {
    floor = PRICE_FLOOR_FACTOR * msrp;
  } else if (medianListedPrice !== null && medianListedPrice > 0) {
    floor = PRICE_FLOOR_FACTOR * medianListedPrice;
  } else {
    return [0.5, null];
  }

  if (floor <= 0) return [0.5, null];

  const delta = (listedPrice - floor) / floor;
  const score = 1.0 - clip(delta, 0.0, PRICE_CLIP_MAX);

  if (msrp !== null && listedPrice < msrp) {
    // Parity-safe round (no .5-edge in the corpus); banker's-vs-half-up does
    // not diverge here.
    const pct = Math.round(((msrp - listedPrice) / msrp) * 100);
    if (pct >= 1) return [score, `${pct}% under MSRP`];
  }

  return [score, null];
}

/** Color axis: no prefs / "No preference" sentinel → 0.5; exterior in prefs →
 *  1.0/preferred_color; missing color or non-pref → 0.2. */
function colorAxis(
  exteriorColor: string | null,
  preferredColors: string[] | null,
): [number, string | null] {
  if (preferredColors === null || preferredColors.length === 0) return [0.5, null];

  const prefsLc = new Set(
    preferredColors.filter((c) => c).map((c) => (c ?? "").trim().toLowerCase()),
  );
  if (prefsLc.has(NO_COLOR_PREFERENCE)) return [0.5, null];

  if (!exteriorColor) return [OTHER_COLOR_SCORE, null];

  if (prefsLc.has(exteriorColor.trim().toLowerCase())) return [1.0, "preferred_color"];

  return [OTHER_COLOR_SCORE, null];
}

/** Distance axis: 1 - clip(distance/radius, 0, 1); null → 0.5; radius <= 0 →
 *  0.5. Never emits a reason chip. */
function distanceAxis(distanceMiles: number | null, searchRadiusMiles: number): number {
  if (distanceMiles === null) return 0.5;
  if (searchRadiusMiles <= 0) return 0.5;
  return 1.0 - clip(distanceMiles / searchRadiusMiles, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Score one listing against a profile context. `distanceMiles` is the resolved
 * dealer-to-buyer distance (null when unknown). `medianListedPrice` is the
 * batch median for the price-axis fallback when the listing's msrp is null;
 * pass null when scoring a single row in isolation.
 */
export function scoreListing(
  ctx: ProfileMatchCtx,
  listing: Record<string, unknown>,
  distanceMiles: number | null,
  medianListedPrice: number | null = null,
): RankedRow {
  const [trimScore, trimReason] = trimAxis(
    asString(listing["trim"]),
    ctx.profile_trim,
    ctx.acceptable_trims,
  );
  const [priceScore, priceReason] = priceAxis(
    asNumber(listing["listed_price"]),
    asNumber(listing["msrp"]),
    medianListedPrice,
  );
  const [colorScore, colorReason] = colorAxis(
    asString(listing["exterior_color"]),
    ctx.preferred_exterior_colors,
  );
  const distanceScore = distanceAxis(distanceMiles, ctx.search_radius_miles);

  const score =
    TRIM_WEIGHT * trimScore +
    PRICE_WEIGHT * priceScore +
    COLOR_WEIGHT * colorScore +
    DISTANCE_WEIGHT * distanceScore;

  // Reason ORDER: trim chip (always) → price chip (if any) → color chip (if
  // any). Distance never contributes a chip.
  const reasons: string[] = [trimReason];
  if (priceReason) reasons.push(priceReason);
  if (colorReason) reasons.push(colorReason);

  const matchStatus = classifyMatchStatus(
    ctx.profile_year,
    ctx.profile_make,
    ctx.profile_model,
    ctx.profile_trim,
    ctx.acceptable_trims,
    asNumber(listing["year"]) ?? asString(listing["year"]),
    asString(listing["make"]),
    asString(listing["model"]),
    asString(listing["trim"]),
  );

  return {
    listing_id: String(listing["listing_id"]),
    score,
    reasons,
    match_status: matchStatus,
    listing,
  };
}

/**
 * Hard filters, run BEFORE scoring. Drops `inventory_status == "ordered"`
 * (null/"" kept) and rows with `listed_price > 1.10 * budget_max` (strict >;
 * NULL listed_price passes; budget null keeps all). Returns a NEW array — the
 * input is not mutated.
 */
export function applyFilters(
  rows: Record<string, unknown>[],
  ctx: ProfileMatchCtx,
): Record<string, unknown>[] {
  const cap = ctx.budget_max !== null ? ctx.budget_max * 1.1 : null;
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    if ((asString(row["inventory_status"]) ?? "") === "ordered") continue;
    if (cap !== null) {
      const lp = asNumber(row["listed_price"]);
      if (lp !== null && lp > cap) continue;
    }
    out.push(row);
  }
  return out;
}

/**
 * Filter → median → score → sort. `dealerDistances` maps dealer_id → miles (or
 * null); a row whose dealer is missing from the map falls to the neutral
 * distance branch. Sorted score DESC, then listing_id ASC (plain string
 * compare), stable.
 */
export function rankListings(
  ctx: ProfileMatchCtx,
  rows: Record<string, unknown>[],
  dealerDistances: Record<string, number | null>,
): RankedRow[] {
  const filtered = applyFilters(rows, ctx);

  const prices = filtered
    .map((r) => asNumber(r["listed_price"]))
    .filter((p): p is number => p !== null);
  const medianLp = prices.length > 0 ? median(prices) : null;

  const scored = filtered.map((row) => {
    const dealerId = asString(row["dealer_id"]);
    const dist = dealerId ? (dealerDistances[dealerId] ?? null) : null;
    return scoreListing(ctx, row, dist, medianLp);
  });

  // score DESC, then listing_id ASC (plain string <). Array.sort is stable.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.listing_id < b.listing_id ? -1 : a.listing_id > b.listing_id ? 1 : 0),
  );
  return scored;
}
