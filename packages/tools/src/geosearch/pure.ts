/**
 * dealer_geosearch deterministic core — PURE: no SQLite, no network, no LLM.
 * The haversine/dealer-id pieces are byte-stable on purpose: dealer ids must
 * not drift between runs;
 * the zoom / Maps-URL / viewport-tiling math previously lived only in prose and
 * was re-derived by the model every run — here it is promoted to L1-tested code.
 *
 * Pipeline position: planViewports (zoomForRadius + buildMapsSearchUrl +
 * tileViewports) feeds the browser scan; dedupFilter (rejectNonCandidate +
 * rankByDistance) sits between extraction and the single DB write path
 * (upsertDealers.ts), which re-checks the US gate before persisting.
 */

import { createHash } from "node:crypto";
import type { DealerCandidate } from "@autobroker/core";
import { isUsDealer } from "../geo.js";

export const EARTH_RADIUS_MILES = 3958.8;

/**
 * Haversine distance in miles (half-angle form — numerically stable near
 * zero; the √a clamp guards asin from FP drift on antipodal points).
 */
export function haversineMiles(p: {
  lat1: number;
  lng1: number;
  lat2: number;
  lng2: number;
}): number {
  const rad = (d: number): number => (d * Math.PI) / 180;
  const sinDLat = Math.sin(rad(p.lat2 - p.lat1) / 2);
  const sinDLng = Math.sin(rad(p.lng2 - p.lng1) / 2);
  const a =
    sinDLat ** 2 + Math.cos(rad(p.lat1)) * Math.cos(rad(p.lat2)) * sinDLng ** 2;
  return EARTH_RADIUS_MILES * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Zoom level for a search radius: small radii zoom in, anything over 25 mi
 * uses 10z (the per-viewport zoom of the multi-viewport tiling as well).
 */
export function zoomForRadius(miles: number): 10 | 11 | 12 {
  if (miles <= 10) return 12;
  if (miles <= 25) return 11;
  return 10;
}

/** `https://www.google.com/maps/search/<make>+dealership/@<lat>,<lng>,<zoom>z`
 *  — spaces in a multi-word make become `+` ("Land Rover" → "Land+Rover"). */
export function buildMapsSearchUrl(a: {
  make: string;
  lat: number;
  lng: number;
  zoom: number;
}): string {
  const q = a.make.trim().replace(/\s+/g, "+");
  return `https://www.google.com/maps/search/${q}+dealership/@${a.lat},${a.lng},${a.zoom}z`;
}

/** One Maps scan viewport: center + zoom + ready-to-navigate search URL. */
export interface Viewport {
  lat: number;
  lng: number;
  zoom: number;
  url: string;
  label: "C" | "N" | "S" | "E" | "W";
}

/**
 * Viewport tiling. The Maps feed only surfaces ~10 results per viewport, so a
 * single wide viewport silently drops dealers outside the central metro:
 *   - radius ≤ 50 mi → one center viewport at the radius-derived zoom;
 *   - radius > 50 mi → five viewports (center + N/S/E/W at half-radius
 *     offsets), all at 10z. Offsets use 1° lat ≈ 69 mi and
 *     1° lng ≈ 69·cos(lat) mi. Cross-viewport duplicates are collapsed later
 *     by `dedupByPlaceId`.
 */
export function tileViewports(a: {
  make: string;
  lat: number;
  lng: number;
  radiusMiles: number;
}): Viewport[] {
  const mk = (lat: number, lng: number, zoom: number, label: Viewport["label"]): Viewport => ({
    lat,
    lng,
    zoom,
    label,
    url: buildMapsSearchUrl({ make: a.make, lat, lng, zoom }),
  });
  if (a.radiusMiles <= 50) {
    return [mk(a.lat, a.lng, zoomForRadius(a.radiusMiles), "C")];
  }
  const dLat = a.radiusMiles / 2 / 69;
  const dLng = a.radiusMiles / 2 / (69 * Math.cos((a.lat * Math.PI) / 180));
  return [
    mk(a.lat, a.lng, 10, "C"),
    mk(a.lat + dLat, a.lng, 10, "N"),
    mk(a.lat - dLat, a.lng, 10, "S"),
    mk(a.lat, a.lng + dLng, 10, "E"),
    mk(a.lat, a.lng - dLng, 10, "W"),
  ];
}

/**
 * Stable 16-hex dealer id: SHA-256 of the Google place id when present
 * (truthy — an empty string falls back like null), otherwise of
 * `name|address|city`. Deterministic so re-discovery upserts are idempotent.
 * `city` is optional because the 12-field candidate shape does not carry one;
 * callers that know it (e.g. rows imported from an older data set) may pass it through.
 */
export function dealerId(c: {
  google_place_id: string | null;
  name: string | null;
  address: string | null;
  city?: string | null;
}): string {
  const key = c.google_place_id
    ? c.google_place_id
    : `${c.name ?? ""}|${c.address ?? ""}|${c.city ?? ""}`;
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}

/**
 * Authoritative cross-viewport dedup: first-seen wins per google_place_id.
 * Rows WITHOUT a place id are always kept — they cannot collide on the
 * authoritative key (their dealer_id falls back to name|address|city).
 */
export function dedupByPlaceId(candidates: readonly DealerCandidate[]): DealerCandidate[] {
  const seen = new Set<string>();
  const kept: DealerCandidate[] = [];
  for (const c of candidates) {
    if (c.google_place_id !== null) {
      if (seen.has(c.google_place_id)) continue;
      seen.add(c.google_place_id);
    }
    kept.push(c);
  }
  return kept;
}

/** Outcome of the candidate filter chain — every removal is counted so
 *  nothing is dropped silently. */
export interface CandidateFilterResult {
  kept: DealerCandidate[];
  /** Non-US (cross-border) rows dropped here so they never enter the ranked /
   *  discovered set; the upsert tool re-checks as a defense-in-depth backstop. */
  nonUsDropped: number;
  sponsoredDropped: number;
  serviceOnlyDropped: number;
  placeIdCollisionsDropped: number;
}

/**
 * The candidate filter chain, in order:
 *   1. non-US (cross-border) → DROP. A foreign dealer is non-transactable for a
 *      US buyer, so it must never enter the ranked/discovered set; the count
 *      surfaces to the narration ("N cross-border dealer(s) excluded"). The
 *      upsert tool re-checks every surviving row as a defense-in-depth backstop.
 *   2. sponsored → drop; a surviving /aclk website (ad-click redirect) →
 *      website nulled, row kept;
 *   3. service-only (service_center true) → drop;
 *   4. place-id collision → drop (first-seen wins, `dedupByPlaceId`);
 *   5. no website → KEEP with website null — downstream lead-submit surfaces
 *      the skip visibly; a missing site never silently drops a dealer.
 */
export function rejectNonCandidate(
  candidates: readonly DealerCandidate[],
): CandidateFilterResult {
  // 1. Drop non-US (cross-border) rows up front so they never reach the ranked
  //    / discovered set. The candidate carries website + name + address as
  //    geography signals (the other isUsDealer inputs are absent by design).
  const usCandidates = candidates.filter((c) =>
    isUsDealer({ website: c.website, name: c.name, address: c.address }),
  );
  const nonUsDropped = candidates.length - usCandidates.length;

  // 2. Drop sponsored placements; scrub any ad-click website that survived
  //    extraction (snapshot-parsed rows may carry one without the flag).
  const unsponsored: DealerCandidate[] = [];
  for (const c of usCandidates) {
    if (c.sponsored) continue;
    if (c.website !== null && c.website.includes("/aclk")) {
      unsponsored.push({ ...c, website: null });
    } else {
      unsponsored.push(c);
    }
  }

  // 3. Drop service/parts/repair-only listings.
  const dealersOnly = unsponsored.filter((c) => !c.service_center);

  // 4. Authoritative place-id dedup. (5 is a non-action: null-website rows
  //    stay in `kept` untouched.)
  const kept = dedupByPlaceId(dealersOnly);

  return {
    kept,
    nonUsDropped,
    sponsoredDropped: usCandidates.length - unsponsored.length,
    serviceOnlyDropped: unsponsored.length - dealersOnly.length,
    placeIdCollisionsDropped: dealersOnly.length - kept.length,
  };
}

/** A candidate annotated with its distance from the profile origin (null when
 *  the row has no coordinates — distance is unknowable, not zero). */
export type RankedDealerCandidate = DealerCandidate & {
  distance_miles: number | null;
};

/** Annotate one candidate with the haversine distance (2-dp, miles) from the
 *  profile origin. No-op (null distance) when the row lacks coordinates. */
export function annotateDistance(
  c: DealerCandidate,
  origin: { lat: number; lng: number },
): RankedDealerCandidate {
  if (c.latitude === null || c.longitude === null) {
    return { ...c, distance_miles: null };
  }
  const dist = haversineMiles({
    lat1: origin.lat,
    lng1: origin.lng,
    lat2: c.latitude,
    lng2: c.longitude,
  });
  return { ...c, distance_miles: Math.round(dist * 100) / 100 };
}

/**
 * Final distance pass: annotate every candidate, drop rows measurably OUTSIDE
 * the search radius (Maps regularly floats results far beyond it), and sort
 * ascending by distance. Rows with unknown distance (no coordinates) are kept
 * conservatively and sort last — dropping them would be a silent loss.
 */
export function rankByDistance(
  candidates: readonly DealerCandidate[],
  origin: { lat: number; lng: number },
  radiusMiles: number,
): RankedDealerCandidate[] {
  return candidates
    .map((c) => annotateDistance(c, origin))
    .filter((c) => c.distance_miles === null || c.distance_miles <= radiusMiles)
    .sort((a, b) => {
      if (a.distance_miles === null) return b.distance_miles === null ? 0 : 1;
      if (b.distance_miles === null) return -1;
      return a.distance_miles - b.distance_miles;
    });
}
