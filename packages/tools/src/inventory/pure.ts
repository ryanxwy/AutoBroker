/**
 * inventory_site_scan deterministic core — pure helpers shared by the scan
 * pipeline: URL normalizers, the stable source/listing id hashes, the
 * profile-match classifier, the VIN provenance guard, the batched US gate and
 * the raw-JSON write cap.
 *
 * PARITY: `urlNormalize`, `computeSourceId`, `computeListingId`,
 * `classifyMatchStatus` and `validateVinProvenance` are byte-identical ports
 * of the established service semantics — same hash construction, same
 * normalization rules, same truthiness quirks. Do not "improve" them: the ids
 * they mint are the idempotency keys of dealer_inventory_sources and
 * inventory_listings, and any drift forks the keyspace.
 */

import { createHash } from "node:crypto";
import { isUsDealer, type IsUsDealerOptions } from "../geo.js";

// ---------------------------------------------------------------------------
// URL parsing primitives (shared by both normalizers).
//
// Deliberately NOT the WHATWG URL class: these reproduce the exact component
// splitting the id hashes were minted with — scheme only when the prefix is a
// valid scheme token, netloc only after "//", fragment dropped first, query
// split on the first "?", and a ";params" suffix dropped from the LAST path
// segment.
// ---------------------------------------------------------------------------

interface SplitUrl {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
}

function splitUrl(raw: string): SplitUrl {
  let rest = raw;
  let scheme = "";
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):([\s\S]*)$/.exec(rest);
  if (schemeMatch !== null) {
    scheme = schemeMatch[1]!.toLowerCase();
    rest = schemeMatch[2]!;
  }

  let netloc = "";
  if (rest.startsWith("//")) {
    const after = rest.slice(2);
    const end = after.search(/[/?#]/);
    netloc = end === -1 ? after : after.slice(0, end);
    rest = end === -1 ? "" : after.slice(end);
  }

  const hashIdx = rest.indexOf("#");
  if (hashIdx !== -1) rest = rest.slice(0, hashIdx); // fragment dropped first

  let path = rest;
  let query = "";
  const qIdx = rest.indexOf("?");
  if (qIdx !== -1) {
    path = rest.slice(0, qIdx);
    query = rest.slice(qIdx + 1);
  }

  // Drop a ";params" suffix on the LAST path segment (e.g. ";jsessionid=…").
  const lastSlash = path.lastIndexOf("/");
  const semiIdx = path.indexOf(";", lastSlash === -1 ? 0 : lastSlash);
  if (semiIdx !== -1) path = path.slice(0, semiIdx);

  return { scheme, netloc, path, query };
}

/** Reassemble scheme://netloc/path?query (no fragment, no path-params). */
function unsplitUrl(scheme: string, netloc: string, path: string, query: string): string {
  let url = path;
  if (netloc !== "" || url.startsWith("//")) {
    if (url !== "" && !url.startsWith("/")) url = `/${url}`;
    url = `//${netloc}${url}`;
  }
  if (scheme !== "") url = `${scheme}:${url}`;
  if (query !== "") url = `${url}?${query}`;
  return url;
}

/** Trailing slashes stripped, but root stays "/". A fully empty path → "/". */
function normalizePath(path: string): string {
  const stripped = path.replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped;
}

// ---------------------------------------------------------------------------
// urlNormalize — the WRITE-side key (lossless on query params).
// ---------------------------------------------------------------------------

/**
 * Normalize a URL for stable equality keys. This is the write-side key for
 * dealer_inventory_sources.normalized_url and the input to `computeSourceId`.
 *
 * Rules:
 *   - empty input → empty string;
 *   - lowercase scheme + host; missing scheme is upgraded to "https";
 *   - strip trailing slashes on the path, but preserve "/" for root;
 *   - drop the fragment;
 *   - sort the raw "key=value" query pairs alphabetically (LOSSLESS — no
 *     param is dropped; tracking-param stripping belongs to
 *     `normalizeListingUrl`, never here).
 */
export function urlNormalize(url: string): string {
  if (!url) return "";
  const { scheme, netloc, path, query } = splitUrl(url.trim());
  const sortedQuery = query
    .split("&")
    .filter((kv) => kv !== "")
    .sort()
    .join("&");
  return unsplitUrl(scheme || "https", netloc.toLowerCase(), normalizePath(path), sortedQuery);
}

// ---------------------------------------------------------------------------
// normalizeListingUrl — the VIN-absent listing dedup key.
// ---------------------------------------------------------------------------

/** Exact-match tracking keys (lowercased). */
const TRACKING_PARAM_EXACT = new Set([
  "gclid",
  "fbclid",
  "mc_eid",
  "mc_cid",
  "ref",
  "campaign",
]);

/** Prefix-match tracking keys: the conventional utm_* family plus common
 *  vendor trackers observed on dealer SRPs. NOTE "ref" is a PREFIX here, so
 *  refid/referrer/refresh-style keys are all stripped — aggressive by design
 *  (a phantom-dropped functional param only weakens dedup, never correctness,
 *  because the VIN arm wins whenever a VIN is present). */
const TRACKING_PARAM_PREFIXES = [
  "utm_",
  "_ga",
  "_gl",
  "gclid",
  "fbclid",
  "mc_eid",
  "mc_cid",
  "ref",
  "ref_",
  "campaign",
] as const;

function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  if (TRACKING_PARAM_EXACT.has(k)) return true;
  return TRACKING_PARAM_PREFIXES.some((p) => k.startsWith(p));
}

/**
 * Canonicalize a listing (VDP) URL for the VIN-ABSENT dedup key: the value of
 * inventory_listings.normalized_listing_url and the fallback identity fed to
 * `computeListingId` when the row has no VIN.
 *
 * Exact normalization, in order:
 *   1. empty/whitespace input → empty string;
 *   2. scheme-less input upgraded to "https://" (leading slashes dropped);
 *   3. lowercase scheme + host;
 *   4. drop the fragment;
 *   5. drop every tracking query param — key matching {gclid, fbclid, mc_eid,
 *      mc_cid, ref, campaign} exactly or starting with utm_/_ga/_gl/gclid/
 *      fbclid/mc_eid/mc_cid/ref/ref_/campaign (case-insensitive);
 *   6. sort the surviving raw "key=value" pairs alphabetically (stable
 *      ordering, no re-encoding);
 *   7. strip trailing slashes on the path, preserving "/" for root.
 *
 * Distinct from `urlNormalize`: that one is lossless on query params (the
 * source write key); this one strips tracking junk so two hrefs to the same
 * car cannot mint two rows.
 */
export function normalizeListingUrl(url: string): string {
  if (!url) return "";
  let cleaned = url.trim();
  if (cleaned === "") return "";
  if (!cleaned.includes("://")) cleaned = `https://${cleaned.replace(/^\/+/, "")}`;
  const { scheme, netloc, path, query } = splitUrl(cleaned);
  const keptQuery = query
    .split("&")
    .filter((kv) => kv !== "" && !isTrackingParam(kv.split("=", 1)[0]!))
    .sort()
    .join("&");
  return unsplitUrl(scheme || "https", netloc.toLowerCase(), normalizePath(path), keptQuery);
}

// ---------------------------------------------------------------------------
// Stable ids — the idempotency keys. BYTE-IDENTICAL construction.
// ---------------------------------------------------------------------------

function sha256Hex16(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}

/** `src_<sha256(profile|dealer|normalized_url)[:16]>`. */
export function computeSourceId(
  profileId: string,
  dealerId: string,
  normalizedUrl: string,
): string {
  return `src_${sha256Hex16(`${profileId}|${dealerId}|${normalizedUrl}`)}`;
}

/**
 * `lst_<sha256(profile|dealer|vin_or_url)[:16]>`. VIN takes precedence over
 * the fallback URL when present (empty string counts as absent). Throws when
 * both identity anchors are missing — the caller must DROP such rows (and
 * count them) before minting ids.
 */
export function computeListingId(
  profileId: string,
  dealerId: string,
  vin: string | null,
  fallbackUrl: string | null,
): string {
  const key = vin || fallbackUrl;
  if (!key) throw new Error("listing requires VIN or fallback_url");
  return `lst_${sha256Hex16(`${profileId}|${dealerId}|${key}`)}`;
}

// ---------------------------------------------------------------------------
// classifyMatchStatus — profile-vs-listing match, deterministic code (trim
// matching lives HERE — trim never goes into filter URLs or widgets).
// ---------------------------------------------------------------------------

export const MATCH_STATUSES = ["exact", "near", "mismatch", "unknown"] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

/**
 * Classify a listing against a search profile.
 *
 *   - "unknown"  — any required identity field on the LISTING (year/make/
 *                  model) is missing;
 *   - "exact"    — year/make/model match AND trim matches the profile trim or
 *                  is in `acceptableTrims`;
 *   - "near"     — year/make/model match AND trim missing or off;
 *   - "mismatch" — identity fields populated but not aligned (year off, wrong
 *                  make/model, or a profile with missing identity fields).
 *
 * Case-insensitive on make/model/trim; year compared as strings so int/string
 * sources agree. `acceptableTrims` is the parsed list (callers translate the
 * DB acceptable_trims_json string before invoking).
 */
export function classifyMatchStatus(
  profileYear: number | string | null,
  profileMake: string | null,
  profileModel: string | null,
  profileTrim: string | null,
  acceptableTrims: readonly string[] | null,
  year: number | string | null,
  make: string | null,
  model: string | null,
  trim: string | null,
): MatchStatus {
  if (!year || !make || !model) return "unknown";

  const pm = (profileMake ?? "").toLowerCase();
  const pmd = (profileModel ?? "").toLowerCase();
  const lm = make.toLowerCase();
  const lmd = model.toLowerCase();

  const yearMatch = String(year) === String(profileYear);
  const makeMatch = lm === pm && pm !== "";
  const modelMatch = lmd === pmd && pmd !== "";

  if (!(yearMatch && makeMatch && modelMatch)) {
    // Anything populated-but-misaligned is a mismatch: the listing is not
    // this profile's vehicle (year-off-with-model-match included).
    return "mismatch";
  }

  const trimLc = (trim ?? "").toLowerCase();
  const acceptableLc = new Set(
    (acceptableTrims ?? []).filter((t) => t).map((t) => t.trim().toLowerCase()),
  );
  if (profileTrim && trimLc === profileTrim.toLowerCase()) return "exact";
  if (trimLc !== "" && acceptableLc.has(trimLc)) return "exact";
  return "near";
}

// ---------------------------------------------------------------------------
// validateVinProvenance — the VIN-hallucination guard.
// ---------------------------------------------------------------------------

const VIN_FORBIDDEN_CHARS = /[IOQ]/;

/**
 * True iff `vin` looks well-formed (exactly 17 chars, none of I/O/Q) AND
 * appears verbatim (case-insensitive substring) in `snapshotText`.
 *
 * The snapshot is page-scoped: callers check the SRP snapshot first and, for
 * VDP-harvested VINs, that listing's own VDP snapshot — recording WHICH
 * snapshot id vouched for the VIN. Rows whose VIN fails every available
 * snapshot are dropped (and counted) — an LLM-emitted VIN is never trusted on
 * its own.
 */
export function validateVinProvenance(vin: string, snapshotText: string): boolean {
  if (!vin || !snapshotText) return false;
  if (vin.length !== 17) return false;
  if (VIN_FORBIDDEN_CHARS.test(vin.toUpperCase())) return false;
  return snapshotText.toLowerCase().includes(vin.toLowerCase());
}

// ---------------------------------------------------------------------------
// isUsDealerBatch — ONE call for the whole target set.
// ---------------------------------------------------------------------------

/**
 * Batched US gate: classify every dealer in one call (index-aligned results).
 * The scan workflow gates its whole target batch through this single
 * invocation — never one call per dealer in a loop (the per-dealer-call shape
 * is how a 17-dealer batch once burned ~25s on pure overhead).
 */
export function isUsDealerBatch(dealers: readonly IsUsDealerOptions[]): boolean[] {
  return dealers.map((d) => isUsDealer(d));
}

// ---------------------------------------------------------------------------
// truncateRawJson — the raw_listing_json write cap.
// ---------------------------------------------------------------------------

export const RAW_LISTING_JSON_CAP_BYTES = 32 * 1024;

/** Recursively sort object keys so serialized blobs are byte-stable. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortKeysDeep(src[key]);
    return out;
  }
  return value;
}

/**
 * Serialize a provenance blob for the NOT-NULL raw_listing_json column with a
 * hard byte cap — no exceptions at write time.
 *
 *   - null → the JSON "null" literal;
 *   - object → JSON.stringify with sorted keys (stable bytes);
 *   - string → passed through;
 *   - over the cap → `{"_excerpt":"…","_original_bytes":N,"_truncated":true}`
 *     with the excerpt cut at a UTF-8 boundary and sized so the envelope
 *     itself stays under the cap.
 */
export function truncateRawJson(
  blob: string | Record<string, unknown> | null,
  capBytes: number = RAW_LISTING_JSON_CAP_BYTES,
): string {
  let raw: string;
  if (blob === null) {
    raw = "null";
  } else if (typeof blob === "string") {
    raw = blob;
  } else {
    raw = JSON.stringify(sortKeysDeep(blob));
  }

  const encoded = Buffer.from(raw, "utf8");
  if (encoded.byteLength <= capBytes) return raw;

  // Generous fixed headroom for the envelope keys so multi-byte UTF-8 in the
  // excerpt can never push the wrapped output past the cap.
  const envelopeOverhead = 256;
  const budget = Math.max(capBytes - envelopeOverhead, 0);
  let cut = budget;
  // Never cut inside a multi-byte sequence: if the first excluded byte is a
  // continuation byte, back off to (and drop) the straddling lead byte.
  if (cut < encoded.byteLength && (encoded[cut]! & 0xc0) === 0x80) {
    while (cut > 0 && (encoded[cut]! & 0xc0) === 0x80) cut -= 1;
  }
  const excerpt = encoded.subarray(0, cut).toString("utf8");
  return JSON.stringify({
    _excerpt: excerpt,
    _original_bytes: encoded.byteLength,
    _truncated: true,
  });
}
