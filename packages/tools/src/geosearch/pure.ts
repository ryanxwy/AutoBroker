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

// --------------------------------------------------------------------------- //
// Brand relevance — drop a rooftop that names a DIFFERENT franchise            //
// --------------------------------------------------------------------------- //

// Franchised new-car makes → every name token (canonical + common aliases) that
// marks a rooftop as carrying that make. The off-brand filter is name-only and
// FAIL-OPEN by design: a rooftop is dropped ONLY when its name advertises a
// competing make AND does NOT contain the searched make. A neutral/used/multi-
// brand name ("AutoNation", "Larry H. Miller", "DriveTime") matches nothing here
// and is always kept. Same conservative posture as the cross-border name filter
// (geo.ts): the goal is to drop obvious noise, never to risk excluding a real
// dealer of the searched make.
const MAKE_ALIASES: Record<string, readonly string[]> = {
  acura: ["acura"],
  "alfa romeo": ["alfa romeo"],
  audi: ["audi"],
  bmw: ["bmw"],
  buick: ["buick"],
  cadillac: ["cadillac"],
  chevrolet: ["chevrolet", "chevy"],
  chrysler: ["chrysler"],
  dodge: ["dodge"],
  fiat: ["fiat"],
  ford: ["ford"],
  genesis: ["genesis"],
  gmc: ["gmc"],
  honda: ["honda"],
  hyundai: ["hyundai"],
  infiniti: ["infiniti"],
  jaguar: ["jaguar"],
  jeep: ["jeep"],
  kia: ["kia"],
  "land rover": ["land rover", "range rover"],
  lexus: ["lexus"],
  lincoln: ["lincoln"],
  lucid: ["lucid"],
  maserati: ["maserati"],
  mazda: ["mazda"],
  "mercedes-benz": ["mercedes-benz", "mercedes", "benz"],
  mini: ["mini"],
  mitsubishi: ["mitsubishi"],
  nissan: ["nissan"],
  polestar: ["polestar"],
  porsche: ["porsche"],
  ram: ["ram"],
  rivian: ["rivian"],
  subaru: ["subaru"],
  tesla: ["tesla"],
  toyota: ["toyota"],
  volkswagen: ["volkswagen", "vw"],
  volvo: ["volvo"],
};

/** Escape a token for inclusion in a regex alternation (tokens are curated, but
 *  hyphens/spaces stay literal and any metachar is neutralized). */
function escapeRe(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary alternation over the tokens (longest-first so "range rover"
 *  wins over "rover"); null when the list is empty. Mirrors the geo.ts city-token
 *  construction — a token matches only on non-letter boundaries, so "ford" does
 *  NOT match inside "Crawford". No `g` flag (sticky lastIndex would make repeated
 *  `.test()` stateful). */
function tokenBoundaryRe(tokens: readonly string[]): RegExp | null {
  if (tokens.length === 0) return null;
  const alt = [...tokens]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join("|");
  return new RegExp("(?:^|[^A-Za-z])(" + alt + ")(?:[^A-Za-z]|$)", "i");
}

/** Resolve the searched make to its full token set (canonical + aliases). null
 *  when the make is unknown/exotic — the caller then SKIPS the brand filter
 *  (fail-open: never filter on a make we don't model). */
function resolveMakeTokens(make: string | null | undefined): readonly string[] | null {
  if (!make) return null;
  const norm = make.trim().toLowerCase();
  if (norm === "") return null;
  for (const [key, tokens] of Object.entries(MAKE_ALIASES)) {
    if (key === norm || tokens.includes(norm)) return tokens;
  }
  return null;
}

/**
 * True iff a rooftop's NAME advertises a competing franchise and does NOT carry
 * the searched make — the only case we drop. Keeps: a name carrying the searched
 * make (even alongside others, e.g. "…Chevrolet GMC" for a Chevrolet search), a
 * neutral/multi-brand/used name, a null name, or an unknown searched make.
 */
export function isOffBrand(name: string | null, make: string | null | undefined): boolean {
  const searched = resolveMakeTokens(make);
  if (searched === null) return false; // unknown make → fail-open, never filter
  if (name === null || name.trim() === "") return false;
  const searchedRe = tokenBoundaryRe(searched);
  if (searchedRe && searchedRe.test(name)) return false; // carries the searched make → keep
  const searchedSet = new Set(searched);
  const competing = Object.values(MAKE_ALIASES)
    .flat()
    .filter((t) => !searchedSet.has(t));
  const competingRe = tokenBoundaryRe(competing);
  return competingRe !== null && competingRe.test(name); // names ONLY a different make → drop
}

// --------------------------------------------------------------------------- //
// Rooftop dedup — collapse same-website co-located duplicate cards            //
// --------------------------------------------------------------------------- //

/** Normalized rooftop host: lowercased hostname minus a leading "www." (TLD
 *  kept, so "courtesynissanofmesa.com" stays distinct from a sibling host).
 *  null when unparseable (a null-host row is NEVER merged). */
export function normalizeWebsiteHost(website: string | null): string | null {
  if (website === null || website.trim() === "") return null;
  try {
    const u = new URL(website);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/** Name tokens that mark a NON-primary sub-listing of a rooftop (a Service /
 *  Parts card sharing the rooftop's website). Used only to pick which of two
 *  co-located same-host rows to keep — never to drop on its own. */
const ROOFTOP_SUBLISTING_RE = /\b(service|parts|body shop|collision|service center)\b/i;

/** Max mutual distance (mi) for two same-host rows to count as the SAME physical
 *  rooftop. Bounds the merge so two genuinely-different rooftops of one dealer
 *  group that happen to share a group domain but sit far apart are NOT collapsed. */
const ROOFTOP_PROXIMITY_MILES = 1;

/** True iff two same-host candidates are the same physical rooftop: co-located
 *  within ROOFTOP_PROXIMITY_MILES when both carry coordinates, else identical
 *  normalized address. Coordinate-less rows with differing addresses are NOT
 *  merged (fail-open). */
function sameRooftop(a: DealerCandidate, b: DealerCandidate): boolean {
  if (
    a.latitude !== null &&
    a.longitude !== null &&
    b.latitude !== null &&
    b.longitude !== null
  ) {
    return (
      haversineMiles({ lat1: a.latitude, lng1: a.longitude, lat2: b.latitude, lng2: b.longitude }) <=
      ROOFTOP_PROXIMITY_MILES
    );
  }
  const addrA = (a.address ?? "").trim().toLowerCase();
  const addrB = (b.address ?? "").trim().toLowerCase();
  return addrA !== "" && addrA === addrB;
}

/** Prefer the PRIMARY card of a rooftop: a non-"…Service/Parts" name beats a
 *  sub-listing; then the shorter name; then first-seen (stable). */
function preferPrimary(incumbent: DealerCandidate, challenger: DealerCandidate): DealerCandidate {
  const incSub = ROOFTOP_SUBLISTING_RE.test(incumbent.name ?? "");
  const chSub = ROOFTOP_SUBLISTING_RE.test(challenger.name ?? "");
  if (incSub !== chSub) return incSub ? challenger : incumbent;
  const incLen = (incumbent.name ?? "").length;
  const chLen = (challenger.name ?? "").length;
  if (chLen < incLen) return challenger;
  return incumbent;
}

/** Collapse co-located same-host duplicate rooftops (e.g. a dealer's primary
 *  card + its "…Service" card with a different place id). Rows with no parseable
 *  host are always kept (cannot collide on the host key). Preserves order. */
export function dedupRooftops(candidates: readonly DealerCandidate[]): {
  kept: DealerCandidate[];
  dropped: number;
} {
  const kept: DealerCandidate[] = [];
  const hostIndex = new Map<string, number>(); // host → index into `kept`
  let dropped = 0;
  for (const c of candidates) {
    const host = normalizeWebsiteHost(c.website);
    if (host === null) {
      kept.push(c);
      continue;
    }
    const priorIdx = hostIndex.get(host);
    if (priorIdx !== undefined && sameRooftop(kept[priorIdx]!, c)) {
      kept[priorIdx] = preferPrimary(kept[priorIdx]!, c);
      dropped += 1;
      continue;
    }
    if (priorIdx === undefined) hostIndex.set(host, kept.length);
    kept.push(c);
  }
  return { kept, dropped };
}

/** Outcome of the candidate filter chain — every removal is counted so
 *  nothing is dropped silently. */
export interface CandidateFilterResult {
  kept: DealerCandidate[];
  /** Non-US (cross-border) rows dropped here so they never enter the ranked /
   *  discovered set; the upsert tool re-checks as a defense-in-depth backstop. */
  nonUsDropped: number;
  /** Rows whose name advertises ONLY a competing make (off-brand noise) dropped. */
  offBrandDropped: number;
  sponsoredDropped: number;
  serviceOnlyDropped: number;
  placeIdCollisionsDropped: number;
  /** Co-located same-website duplicate rooftop cards merged into one. */
  duplicateRooftopsDropped: number;
}

/**
 * The candidate filter chain, in order:
 *   1. non-US (cross-border) → DROP. A foreign dealer is non-transactable for a
 *      US buyer, so it must never enter the ranked/discovered set; the count
 *      surfaces to the narration ("N cross-border dealer(s) excluded"). The
 *      upsert tool re-checks every surviving row as a defense-in-depth backstop.
 *   2. off-brand → DROP when `opts.make` is given and the name advertises ONLY a
 *      competing franchise (fail-open: kept on a neutral name or an unknown make);
 *   3. sponsored → drop; a surviving /aclk website (ad-click redirect) →
 *      website nulled, row kept;
 *   4. service-only (service_center true) → drop;
 *   5. place-id collision → drop (first-seen wins, `dedupByPlaceId`);
 *   6. duplicate rooftop → merge co-located same-website cards (`dedupRooftops`);
 *   7. no website → KEEP with website null — downstream lead-submit surfaces
 *      the skip visibly; a missing site never silently drops a dealer.
 */
export function rejectNonCandidate(
  candidates: readonly DealerCandidate[],
  opts: { make?: string | null } = {},
): CandidateFilterResult {
  // 1. Drop non-US (cross-border) rows up front so they never reach the ranked
  //    / discovered set. The candidate carries website + name + address as
  //    geography signals (the other isUsDealer inputs are absent by design).
  const usCandidates = candidates.filter((c) =>
    isUsDealer({ website: c.website, name: c.name, address: c.address }),
  );
  const nonUsDropped = candidates.length - usCandidates.length;

  // 2. Drop off-brand rooftops (name advertises only a competing make). Skipped
  //    entirely when the searched make is unknown/exotic (fail-open).
  const onBrand = usCandidates.filter((c) => !isOffBrand(c.name, opts.make));
  const offBrandDropped = usCandidates.length - onBrand.length;

  // 3. Drop sponsored placements; scrub any ad-click website that survived
  //    extraction (snapshot-parsed rows may carry one without the flag).
  const unsponsored: DealerCandidate[] = [];
  for (const c of onBrand) {
    if (c.sponsored) continue;
    if (c.website !== null && c.website.includes("/aclk")) {
      unsponsored.push({ ...c, website: null });
    } else {
      unsponsored.push(c);
    }
  }

  // 4. Drop service/parts/repair-only listings.
  const dealersOnly = unsponsored.filter((c) => !c.service_center);

  // 5. Authoritative place-id dedup.
  const deduped = dedupByPlaceId(dealersOnly);

  // 6. Rooftop dedup: collapse a primary card + its co-located same-website
  //    "…Service" card (distinct place ids, so 5 left both). (7 is a non-action:
  //    null-website rows stay in `kept` untouched.)
  const { kept, dropped: duplicateRooftopsDropped } = dedupRooftops(deduped);

  return {
    kept,
    nonUsDropped,
    offBrandDropped,
    sponsoredDropped: onBrand.length - unsponsored.length,
    serviceOnlyDropped: unsponsored.length - dealersOnly.length,
    placeIdCollisionsDropped: dealersOnly.length - deduped.length,
    duplicateRooftopsDropped,
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
