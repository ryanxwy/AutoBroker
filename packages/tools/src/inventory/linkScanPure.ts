/**
 * inventory_link_scan deterministic core — PURE: no SQLite, no network, no LLM.
 *
 * Two pieces:
 *   - `classifySkipUrl` — the junk-link pre-filter (5 closed rules) that runs
 *     BEFORE the review card, so unsubscribe links / CRM trackers / Maps
 *     shares / social pages / bare homepages never even ask for approval.
 *     SINGLE SOURCE OF TRUTH: the rules live in this one helper only — never
 *     mirrored into prompt prose (prose↔code drift is how a skip rule rots).
 *   - `filterForProfile` — the deterministic profile filter over classified
 *     listings: accepted = exact|near match; mismatch/unknown rows are
 *     REJECTED with a typed reason (link_scan persists matching listings
 *     only). Match classification itself is `classifyMatchStatus` (the shared
 *     scan classifier); this is the accept/reject policy over its labels.
 */

import type { MatchStatus } from "./pure.js";

// ---------------------------------------------------------------------------
// classifySkipUrl — the 5 junk rules, first-hit-wins in this exact order.
// ---------------------------------------------------------------------------

/** The closed junk-rule vocabulary (also the review card's per-row reason). */
export const SKIP_URL_REASONS = [
  "unsubscribe",
  "google_services",
  "social_media",
  "crm_tracking",
  "bare_homepage",
] as const;
export type SkipUrlReason = (typeof SKIP_URL_REASONS)[number];

/** Hosts whose every page (own domain or any subdomain) is a social page. */
const SOCIAL_HOSTS = ["facebook.com", "instagram.com", "twitter.com", "youtube.com"] as const;

/** CRM / lead-tracking hosts (own domain or any subdomain). */
const CRM_HOSTS = ["podium.com", "edealerhub.com", "carleadsup.com"] as const;

/** CRM tracking host pattern: vin.<anything>.net (own or as a subdomain tail). */
const CRM_VIN_NET_RE = /(^|\.)vin\.[^.]+\.net$/;

/** True when `host` equals `domain` or is one of its subdomains. */
function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

interface SkipUrlParts {
  host: string;
  path: string;
  query: string;
}

/**
 * Minimal URL split for the skip rules: scheme stripped when present, host
 * only after "//", fragment dropped, query split on the first "?". The host is
 * lowercased, whitespace-trimmed, and a leading "www." is removed. Scheme-less
 * input ("dealer.com/foo") has NO host — only the path rules can match it
 * (best-effort keep, mirroring the empty/unparseable contract).
 */
function splitForSkip(raw: string): SkipUrlParts | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  let rest = trimmed;
  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(rest);
  if (schemeMatch !== null) rest = rest.slice(schemeMatch[0].length);

  let host = "";
  if (rest.startsWith("//")) {
    const after = rest.slice(2);
    const end = after.search(/[/?#]/);
    host = (end === -1 ? after : after.slice(0, end)).toLowerCase().trim();
    rest = end === -1 ? "" : after.slice(end);
  }
  if (host.startsWith("www.")) host = host.slice(4);

  const hashIdx = rest.indexOf("#");
  if (hashIdx !== -1) rest = rest.slice(0, hashIdx);

  let path = rest;
  let query = "";
  const qIdx = rest.indexOf("?");
  if (qIdx !== -1) {
    path = rest.slice(0, qIdx);
    query = rest.slice(qIdx + 1);
  }
  return { host, path, query };
}

/**
 * Classify a candidate inventory link against the 5 junk rules. Returns the
 * FIRST matching rule's reason, or null = keep. Evaluation order (first hit
 * wins — pinned by the L1 ordering tests):
 *
 *   1. unsubscribe      — the lowercased path contains "unsubscribe",
 *                         "opt-out" or "optout";
 *   2. google_services  — google.com (or any subdomain) with a /maps path, or
 *                         the maps.app.goo.gl short-link host;
 *   3. social_media     — facebook/instagram/twitter/youtube, own domain or
 *                         any subdomain;
 *   4. crm_tracking     — podium/edealerhub/carleadsup (own or subdomain), or
 *                         a vin.<anything>.net tracking host;
 *   5. bare_homepage    — empty or "/" path with NO query string (a dealer
 *                         homepage is not an inventory link; a root URL WITH a
 *                         query — e.g. "/?model=cr-v" — is KEPT).
 *
 * Empty / unparseable input → null (keep, best-effort: a weird link is the
 * reviewer's call, never a silent drop).
 */
export function classifySkipUrl(url: string): SkipUrlReason | null {
  const parts = splitForSkip(url);
  if (parts === null) return null;
  const { host, path, query } = parts;
  const pathLc = path.toLowerCase();

  // 1. unsubscribe / opt-out paths.
  if (pathLc.includes("unsubscribe") || pathLc.includes("opt-out") || pathLc.includes("optout")) {
    return "unsubscribe";
  }

  // 2. Google Maps links (place shares ride dealer emails constantly).
  if (
    (hostMatches(host, "google.com") && (pathLc.startsWith("/maps") || pathLc.includes("/maps/"))) ||
    host === "maps.app.goo.gl"
  ) {
    return "google_services";
  }

  // 3. social pages.
  if (SOCIAL_HOSTS.some((d) => hostMatches(host, d))) {
    return "social_media";
  }

  // 4. CRM / lead-tracking hosts.
  if (CRM_HOSTS.some((d) => hostMatches(host, d)) || CRM_VIN_NET_RE.test(host)) {
    return "crm_tracking";
  }

  // 5. bare homepage (no path, no query). Only meaningful when a host parsed —
  // a scheme-less fragment with an empty path is just unparseable, kept.
  if (host !== "" && (path === "" || path === "/") && query === "") {
    return "bare_homepage";
  }

  return null;
}

// ---------------------------------------------------------------------------
// filterForProfile — accept exact|near, reject mismatch/unknown with a reason.
// ---------------------------------------------------------------------------

/** The typed reject vocabulary the confirm summary surfaces. */
export const PROFILE_FILTER_REJECT_REASONS = [
  "trim_or_year_mismatch",
  "identity_missing",
] as const;
export type ProfileFilterRejectReason = (typeof PROFILE_FILTER_REJECT_REASONS)[number];

export interface ProfileFilterResult<T> {
  /** Rows whose matchStatus is exact|near — the only rows persist receives. */
  accepted: T[];
  /** Dropped rows with the typed reason (counted, surfaced, never written). */
  rejected: Array<{ row: T; reason: ProfileFilterRejectReason }>;
}

/**
 * The accept/reject policy over classified listings:
 *   - exact | near → accepted (trim-off-list is still the profile's vehicle);
 *   - mismatch     → rejected "trim_or_year_mismatch" (wrong year/make/model);
 *   - unknown      → rejected "identity_missing" (year/make/model not on the
 *                    card — an unidentifiable row is never written).
 * Pure; order-preserving.
 */
export function filterForProfile<T extends { matchStatus: MatchStatus }>(
  rows: readonly T[],
): ProfileFilterResult<T> {
  const accepted: T[] = [];
  const rejected: Array<{ row: T; reason: ProfileFilterRejectReason }> = [];
  for (const row of rows) {
    switch (row.matchStatus) {
      case "exact":
      case "near":
        accepted.push(row);
        break;
      case "mismatch":
        rejected.push({ row, reason: "trim_or_year_mismatch" });
        break;
      case "unknown":
        rejected.push({ row, reason: "identity_missing" });
        break;
    }
  }
  return { accepted, rejected };
}
