/**
 * inventory_aggregator_scan persist closures — the tools-layer glue the
 * aggregator workflow's persist step calls beyond the shared persistScanResults
 * writer. Two DB closures (raw better-sqlite3 via db.$client — no drizzle-orm)
 * and two pure helpers:
 *
 *   - resolveOrMintDealer   — match a shopping-site tile's dealer to one already
 *                             linked to the profile (exact normalized name +
 *                             city/state), else mint a fresh dealers row.
 *   - selectExistingVinOwners — which of a batch of VINs a live listing already
 *                             owns (so an aggregator write can prefer an existing
 *                             rooftop over a minted one).
 *   - capTopListings        — price-ascending top-N slice (nulls last).
 *   - collapseSameVinAcrossDealers — read-side same-VIN dedup for the compare
 *                             projection, preferring the non-aggregator row.
 */

import type { Db } from "@autobroker/db";

import { dealerId } from "../geosearch/pure.js";

// ---------------------------------------------------------------------------
// Normalization — lowercase, punctuation → space, whitespace collapsed. Both
// sides of every match run through the SAME transform so "Costa-Mesa Toyota"
// and "Costa Mesa Toyota" resolve to one dealer (exact-after-normalize, never
// fuzzy/token/website matching).
// ---------------------------------------------------------------------------

function normalizeName(value: string | null): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** State token: lowercase, alphanumerics only ("CA" → "ca", "Ca." → "ca"). */
function normalizeState(value: string | null): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Split a "City, ST" tile string into the normalized city + state used for
 *  matching and for the minted dealers row. Missing pieces → empty strings. */
function parseCityState(cityState: string | null): { city: string; state: string } {
  const parts = (cityState ?? "").split(",");
  return {
    city: normalizeName(parts[0] ?? ""),
    state: normalizeState(parts[1] ?? ""),
  };
}

// ---------------------------------------------------------------------------
// resolveOrMintDealer
// ---------------------------------------------------------------------------

const SELECT_PROFILE_DEALERS = `
SELECT d.dealer_id, d.name, d.city, d.state
FROM dealers d
JOIN profile_dealers pd ON pd.dealer_id = d.dealer_id
WHERE pd.search_profile_id = ?
`;

/** Mint a dealers row (aggregator provenance): only the columns a shopping-site
 *  tile supplies; the rest keep their DB defaults. INSERT OR IGNORE keeps a
 *  re-mint idempotent (same hash → same PK → no duplicate). */
const INSERT_DEALER = `
INSERT OR IGNORE INTO dealers (dealer_id, name, city, state, distance_miles, country)
VALUES (?, ?, ?, ?, ?, 'US')
`;

export interface ResolveOrMintDealerArgs {
  profileId: string;
  dealerName: string;
  /** "City, ST" as shown on the tile, or null. */
  cityState: string | null;
  distanceMiles: number | null;
}

export interface ResolveOrMintDealerResult {
  dealerId: string;
  method: "matched_name_city" | "minted";
}

/**
 * Resolve a shopping-site tile's dealer to a real dealers row. Match: EXACT
 * normalized-name AND city AND state equality against dealers already linked to
 * this profile (profile_dealers join, read-only) — no fuzzy/token/website
 * matching. Miss: mint a dealers row keyed by the geosearch dealerId() hash
 * (name|address|city, address empty), verbatim tile name in the column,
 * normalized city/state, country 'US'. Never writes profile_dealers; never
 * mutates an existing dealers row.
 */
export function resolveOrMintDealer(
  db: Db,
  args: ResolveOrMintDealerArgs,
): ResolveOrMintDealerResult {
  const wantName = normalizeName(args.dealerName);
  const { city, state } = parseCityState(args.cityState);

  const linked = db.$client.prepare(SELECT_PROFILE_DEALERS).all(args.profileId) as Array<{
    dealer_id: string;
    name: string | null;
    city: string | null;
    state: string | null;
  }>;
  for (const d of linked) {
    if (
      normalizeName(d.name) === wantName &&
      normalizeName(d.city) === city &&
      normalizeState(d.state) === state
    ) {
      return { dealerId: d.dealer_id, method: "matched_name_city" };
    }
  }

  const id = dealerId({ google_place_id: null, name: args.dealerName, address: "", city });
  db.$client.prepare(INSERT_DEALER).run(id, args.dealerName, city, state, args.distanceMiles);
  return { dealerId: id, method: "minted" };
}

// ---------------------------------------------------------------------------
// selectExistingVinOwners
// ---------------------------------------------------------------------------

const SELECT_VIN_OWNER = `
SELECT dealer_id FROM inventory_listings
WHERE search_profile_id = ? AND vin = ? AND superseded_at IS NULL
ORDER BY dealer_id
LIMIT 1
`;

/**
 * For each VIN, the dealer_id of a LIVE listing (superseded_at IS NULL) that
 * already owns it — VINs with no live owner are absent from the map. When a VIN
 * lives at more than one rooftop the lowest dealer_id wins (deterministic).
 */
export function selectExistingVinOwners(
  db: Db,
  profileId: string,
  vins: readonly string[],
): Map<string, string> {
  const owners = new Map<string, string>();
  if (vins.length === 0) return owners;
  const stmt = db.$client.prepare(SELECT_VIN_OWNER);
  for (const vin of vins) {
    const row = stmt.get(profileId, vin) as { dealer_id: string } | undefined;
    if (row !== undefined) owners.set(vin, row.dealer_id);
  }
  return owners;
}

// ---------------------------------------------------------------------------
// capTopListings — pure top-N slice.
// ---------------------------------------------------------------------------

/** Minimal shape capTopListings sorts on: the advertised price (null = "call
 *  for price", sorts last) and a stable per-listing key for the tiebreak. */
export interface CapListingCandidate {
  price: number | null;
  listingKey: string;
}

/**
 * Keep the `cap` cheapest listings: price ascending, null prices last, ties
 * broken by `listingKey` ascending (a total order → deterministic, stable).
 */
export function capTopListings<T extends CapListingCandidate>(
  rows: readonly T[],
  cap = 10,
): T[] {
  return [...rows]
    .sort((a, b) => {
      if (a.price === null || b.price === null) {
        if (a.price === b.price) return a.listingKey < b.listingKey ? -1 : a.listingKey > b.listingKey ? 1 : 0;
        return a.price === null ? 1 : -1;
      }
      if (a.price !== b.price) return a.price - b.price;
      return a.listingKey < b.listingKey ? -1 : a.listingKey > b.listingKey ? 1 : 0;
    })
    .slice(0, cap);
}

// ---------------------------------------------------------------------------
// collapseSameVinAcrossDealers — pure read-side dedup for the compare view.
// ---------------------------------------------------------------------------

/** Minimal shape the collapse groups on: the VIN (null = never collapsed) and
 *  the source_type used to prefer the richer row over an aggregator one. */
export interface VinCollapseCandidate {
  vin: string | null;
  source_type: string | null;
}

/**
 * Collapse the same VIN appearing under multiple dealer_ids to a single row:
 * when the group mixes sources, keep the first NON-`aggregator_srp` row (the
 * dealer-site listing is richer / clickable), else the first row. Null-VIN rows
 * are never collapsed. Order follows each VIN's first appearance;
 * `collapsedCount` is the number of rows removed.
 */
export function collapseSameVinAcrossDealers<T extends VinCollapseCandidate>(
  candidates: readonly T[],
): { rows: T[]; collapsedCount: number } {
  const byVin = new Map<string, T[]>();
  for (const c of candidates) {
    if (c.vin === null) continue;
    const group = byVin.get(c.vin);
    if (group) group.push(c);
    else byVin.set(c.vin, [c]);
  }

  const representative = (group: T[]): T =>
    group.find((r) => r.source_type !== "aggregator_srp") ?? group[0]!;

  const rows: T[] = [];
  const emitted = new Set<string>();
  for (const c of candidates) {
    if (c.vin === null) {
      rows.push(c);
      continue;
    }
    if (emitted.has(c.vin)) continue;
    emitted.add(c.vin);
    rows.push(representative(byVin.get(c.vin)!));
  }
  return { rows, collapsedCount: candidates.length - rows.length };
}
