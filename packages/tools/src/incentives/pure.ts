/**
 * incentive_scrape deterministic core — the pure decision functions every
 * hard gate of the skill runs through. Hard constraints live HERE in code,
 * never in prompt text: the LLM extraction pass never sees (and can never
 * override) any of these gates.
 *
 *   - classifyOemHost      — the aggregator / non-US-domain rejection table.
 *     Orthogonal to the SSRF validator: SSRF blocks private-IP / non-https /
 *     traversal-shaped URLs; this table blocks by-brand cross-dealer
 *     aggregators and non-US OEM domains.
 *   - cacheGateDecision    — the 7-day freshness gate: the same (make, model,
 *     zip) scraped within 7 days from the SAME source URL is skipped without
 *     a single navigation; a changed URL forces a re-scrape even inside the
 *     window.
 *   - filterCashTypes      — the 5-class cash whitelist. APR / per-model
 *     lease pricing / payment deferral arrive as type "other" and are
 *     dropped + counted here.
 *   - mergeScrapeResults   — program-identity dedupe (type, amount, expires);
 *     the newer scraped_at wins a collision.
 *   - crossVerifyIncentives — the dual-source reconciliation: OEM-site rows
 *     against rooftop-specials rows by (program type, amount, expires);
 *     agreement is a confidence boost, a same-type mismatch is a
 *     source_discrepancy the caller voices.
 *   - substituteOemUrlTemplate — the deterministic {zip}/{model} fill; an
 *     unresolved placeholder throws rather than navigating a literal "{x}".
 *   - OEM_SEED_SOURCES     — the small in-code per-brand candidate table the
 *     first-encounter approval shows when the file registry has no entry.
 *     A seed is a CANDIDATE, never an auto-approval: every brand still
 *     suspends on first encounter; the data-dir registry file is the only
 *     "already approved" memory.
 *
 * Pure functions + frozen data only — no I/O, no DB handle, no browser.
 */

import type { Incentive } from "@autobroker/core";

// ---------------------------------------------------------------------------
// classifyOemHost — the code-level rejection table
// ---------------------------------------------------------------------------

/** Cross-brand listing/pricing aggregators — never an OEM or rooftop source.
 *  Matching is suffix-based on the hostname (subdomains rejected too). */
const AGGREGATOR_HOSTS: readonly string[] = [
  "kbb.com",
  "edmunds.com",
  "cars.com",
  "cargurus.com",
  "truecar.com",
  "autoblog.com",
];

/** TLDs a US OEM/dealer site may carry. Anything else (.ca, .co.uk, .com.mx,
 *  …) is a non-US OEM property — US incentives never live there. */
const US_TLDS: ReadonlySet<string> = new Set(["com", "net", "org", "us", "gov"]);

export type OemHostRejectReason = "aggregator_host" | "non_us_oem_domain" | "malformed_url";

export type OemHostVerdict = { ok: true } | { ok: false; reason: OemHostRejectReason };

/** Classify a candidate incentives-source URL against the rejection table.
 *  Fail-closed: an unparseable / non-http(s) URL is a rejection, never a pass. */
export function classifyOemHost(url: string): OemHostVerdict {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: "malformed_url" };
    }
    host = parsed.hostname.toLowerCase();
  } catch {
    return { ok: false, reason: "malformed_url" };
  }
  if (AGGREGATOR_HOSTS.some((a) => host === a || host.endsWith(`.${a}`))) {
    return { ok: false, reason: "aggregator_host" };
  }
  const tld = host.split(".").at(-1) ?? "";
  if (!US_TLDS.has(tld)) {
    return { ok: false, reason: "non_us_oem_domain" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// the 7-day cache gate
// ---------------------------------------------------------------------------

export const INCENTIVE_CACHE_TTL_DAYS = 7;
const CACHE_TTL_MS = INCENTIVE_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

/** The latest persisted scrape marker for one (make, model, zip) slice —
 *  read by the tools persist module, decided on here. */
export interface IncentiveCacheState {
  /** ISO timestamp of the newest persisted row, or null (never scraped /
   *  slice currently empty). */
  latestScrapedAt: string | null;
  /** The scrape_source_url of that newest row, or null. */
  latestSourceUrl: string | null;
}

/**
 * The 7-day cache gate: skip exactly when BOTH hold —
 *   (a) the slice was scraped within the last 7 days (boundary inclusive:
 *       exactly-7-days-old is still fresh), and
 *   (b) the stored source URL equals the URL this run resolved — a changed
 *       URL forces a re-scrape even inside the window.
 * Unparseable stored timestamps fail open to "scrape" (a corrupt marker must
 * never suppress a refresh).
 */
export function cacheGateDecision(
  cache: IncentiveCacheState,
  resolvedUrl: string,
  nowIso: string,
): "skip" | "scrape" {
  if (cache.latestScrapedAt === null || cache.latestSourceUrl === null) return "scrape";
  const scrapedAtMs = Date.parse(cache.latestScrapedAt);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(scrapedAtMs) || Number.isNaN(nowMs)) return "scrape";
  if (nowMs - scrapedAtMs > CACHE_TTL_MS) return "scrape";
  if (cache.latestSourceUrl !== resolvedUrl) return "scrape";
  return "skip";
}

// ---------------------------------------------------------------------------
// the cash-type whitelist
// ---------------------------------------------------------------------------

/** The five persistable cash classes. Everything else ("other" — APR, lease
 *  pricing, deferral) is dropped + counted; the LLM never sees this gate. */
export const CASH_INCENTIVE_TYPES: ReadonlySet<string> = new Set([
  "customer_cash",
  "loyalty",
  "military",
  "conquest",
  "lease_cash",
]);

/** Apply the whitelist: keep cash rows, count the rest. Order-preserving. */
export function filterCashTypes(rows: readonly Incentive[]): {
  kept: Incentive[];
  dropped: number;
} {
  const kept = rows.filter((r) => CASH_INCENTIVE_TYPES.has(r.type));
  return { kept, dropped: rows.length - kept.length };
}

// ---------------------------------------------------------------------------
// program identity, merge, cross-verify
// ---------------------------------------------------------------------------

/** The program-identity key: (type, amount, expires). Two rows with this key
 *  equal describe the same program observation. */
function programKey(r: Incentive): string {
  return JSON.stringify([r.type, r.amount, r.expires]);
}

/** One extracted row with its observation time (merge input). */
export interface ScrapedIncentiveRow {
  incentive: Incentive;
  /** ISO observation timestamp (the capture's scraped_at). */
  scrapedAt: string;
}

/**
 * Dedupe rows by program identity; on a collision the row with the NEWER
 * scrapedAt wins (its eligibility is kept). First-seen order of the surviving
 * keys is preserved.
 */
export function mergeScrapeResults(rows: readonly ScrapedIncentiveRow[]): Incentive[] {
  const byKey = new Map<string, ScrapedIncentiveRow>();
  for (const row of rows) {
    const key = programKey(row.incentive);
    const existing = byKey.get(key);
    if (existing === undefined || row.scrapedAt > existing.scrapedAt) {
      byKey.set(key, existing === undefined ? row : { ...row });
    }
  }
  return [...byKey.values()].map((r) => r.incentive);
}

/** One same-type amount/expiry disagreement between the two sources. */
export interface SourceDiscrepancy {
  type: string;
  primaryAmount: number;
  primaryExpires: string | null;
  secondaryAmount: number;
  secondaryExpires: string | null;
}

export interface CrossVerifyResult {
  /** Program observations present in BOTH sources (identity match). */
  matched: number;
  /** Same program TYPE on both sides but no (amount, expires) agreement. */
  discrepancies: SourceDiscrepancy[];
  /** ≥1 identity match and zero discrepancies — the confidence boost. */
  consistent: boolean;
}

/**
 * Reconcile the primary (OEM) rows against the secondary (rooftop) rows by
 * (program type, amount, expires):
 *   - identity present in both → matched;
 *   - a TYPE present in both sides where NO identity matches → one
 *     discrepancy per such type (first row of each side reported);
 *   - types only one side carries are neither (rooftops legitimately show a
 *     subset/superset of the OEM programs).
 */
export function crossVerifyIncentives(
  primary: readonly Incentive[],
  secondary: readonly Incentive[],
): CrossVerifyResult {
  const secondaryKeys = new Set(secondary.map(programKey));
  const matched = primary.filter((p) => secondaryKeys.has(programKey(p))).length;

  const discrepancies: SourceDiscrepancy[] = [];
  const typesSeen = new Set<string>();
  for (const p of primary) {
    if (typesSeen.has(p.type)) continue;
    typesSeen.add(p.type);
    const sameTypeSecondary = secondary.filter((s) => s.type === p.type);
    if (sameTypeSecondary.length === 0) continue;
    const anyIdentityMatch =
      primary.some((pp) => pp.type === p.type && secondaryKeys.has(programKey(pp)));
    if (!anyIdentityMatch) {
      const s = sameTypeSecondary[0]!;
      discrepancies.push({
        type: p.type,
        primaryAmount: p.amount,
        primaryExpires: p.expires,
        secondaryAmount: s.amount,
        secondaryExpires: s.expires,
      });
    }
  }

  return { matched, discrepancies, consistent: matched >= 1 && discrepancies.length === 0 };
}

// ---------------------------------------------------------------------------
// URL template substitution + the US-zip shape gate
// ---------------------------------------------------------------------------

/**
 * Fill a registry/seed URL template's {zip} / {model} placeholders (every
 * occurrence, values URI-encoded). An unresolved placeholder AFTER
 * substitution throws — a literal "{x}" must never be navigated, and the
 * SSRF validator deliberately admits braces for exactly these templates.
 */
export function substituteOemUrlTemplate(
  template: string,
  args: { zip: string; model: string },
): string {
  const filled = template
    .replaceAll("{zip}", encodeURIComponent(args.zip))
    .replaceAll("{model}", encodeURIComponent(args.model));
  const leftover = /\{[a-zA-Z0-9_]+\}/.exec(filled);
  if (leftover !== null) {
    throw new Error(
      `substituteOemUrlTemplate: unresolved placeholder ${leftover[0]} in template`,
    );
  }
  return filled;
}

/** The scrape key needs a US zip; this is the shape gate (5 digits, optional
 *  +4). Null/empty/foreign postal shapes fail. */
export function isLikelyUsZip(zip: string | null): boolean {
  return zip !== null && /^\d{5}(-\d{4})?$/.test(zip.trim());
}

// ---------------------------------------------------------------------------
// the per-brand OEM seed candidate table
// ---------------------------------------------------------------------------

/** Colloquial make → canonical OEM brand key. Buyers commonly type "Chevy"
 *  for Chevrolet; without this the seed/registry lookup misses entirely. */
const BRAND_ALIASES: Readonly<Record<string, string>> = { chevy: "chevrolet" };

/** Brand key normalization for BOTH the seed table and the file registry:
 *  lowercased, trimmed, internal whitespace collapsed to one space, then
 *  aliased to the canonical OEM brand (e.g. "chevy" -> "chevrolet"). */
export function normalizeIncentiveBrand(make: string): string {
  const base = make.trim().toLowerCase().replace(/\s+/g, " ");
  return BRAND_ALIASES[base] ?? base;
}

/**
 * The in-code per-brand OEM offers-page candidates, keyed by normalized
 * brand. Deliberately SMALL and verified-by-hand: an entry here only feeds
 * the first-encounter approval as the candidate URL — nothing is scraped
 * until a human approves it, and the approval lands in the data-dir registry
 * file. A brand absent here AND absent from the registry is an honest
 * no_oem_source failure (this build runs web-search-free).
 */
export const OEM_SEED_SOURCES: Readonly<Record<string, { urlTemplate: string }>> = {
  // National brand current-offers page (verified live 2026-06-12: 200). This
  // bare path renders a model MSRP grid the cold isolated capture reads
  // reliably. The brand's whitelist-class cash (e.g. Tucson Hybrid "featured
  // cash") is NOT reachable from here by design of the source site: it is
  // served only through a brand-AND-zip data feed (a two-parameter request the
  // single-parameter SSRF rule rejects — "&" is a shell metacharacter) and a
  // personalization-gated rendered module that a headless, cold, read-only
  // browser never warms. A {zip}-localized URL was tried and rejected: it
  // still does not surface that cash to the cold capture AND it destabilizes
  // the render (intermittent capture timeout). So the param-free page is the
  // stable, honest source — an all-MSRP page is a valid empty result.
  hyundai: {
    urlTemplate: "https://www.hyundaiusa.com/us/en/offers",
  },
  // Toyota + Honda national current-offers hubs. Param-free (the stable kind the
  // cold isolated capture reads without destabilizing), US .com (classifyOemHost
  // passes), and live-verified by the nightly 巡检's own incentive_scrape cold
  // capture — the real headless browser reaches these even where a plain fetch is
  // 403'd. Like Hyundai, the capture may surface mostly an MSRP/offers grid (a
  // valid empty result is honest); the point is the brand is now a recognized
  // source instead of an immediate no_oem_source for two of the most-shopped makes.
  toyota: {
    urlTemplate: "https://www.toyota.com/deals-incentives/",
  },
  honda: {
    urlTemplate: "https://automobiles.honda.com/offers",
  },
  // Chevrolet national current-offers hub. Same pattern as Toyota/Honda:
  // param-free, US .com (classifyOemHost passes), trusted host the repo already
  // recognizes (inventory_site_scan treats chevrolet.com as the Chevrolet OEM
  // site). Keyed "chevrolet" with a "chevy"->"chevrolet" alias above so the
  // common colloquial make resolves. Live cold-capture verified by the nightly
  // 巡检; an all-MSRP grid is a valid empty result.
  chevrolet: {
    urlTemplate: "https://www.chevrolet.com/deals",
  },
};
