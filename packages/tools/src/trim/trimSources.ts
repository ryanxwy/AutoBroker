/**
 * trimSources — read-only WEB lookup of the real trim lineup for a
 * make/model/year, used by the intake `trimSuggestion` step to GROUND the trim
 * suggestions in current web data instead of stale LLM training knowledge
 * (the owner ruling behind the conservative trim-verify: a trim list the model
 * invents from memory false-rejects real trims). This tool ONLY fetches + returns
 * text; the LLM extraction of structured trims happens one layer up in the
 * workflow (the external-API wall keeps the fetch here, the model call there).
 *
 * SSRF posture (hardened — the fetched URLs are partly search-derived, i.e.
 * attacker-influenceable via SEO):
 *   1. POSITIVE host allowlist (TRUSTED_TRIM_HOSTS) — only well-known automotive
 *      editorial/spec hosts are ever fetched; everything else is dropped BEFORE
 *      any network call (mirrors classifyOemHost's "hard constraints live in
 *      code" stance for incentive_scrape).
 *   2. Every URL — the fixed seeds, every DuckDuckGo organic result (decoded from
 *      its `uddg` redirect wrapper), AND every redirect hop — passes
 *      validateSourceUrl (https-only, no creds, no private-IP, DNS-checked).
 *   3. redirect:"manual" — redirects are followed by hand so each Location hop is
 *      re-validated + re-allowlisted + re-https-checked (a 30x to an internal IP
 *      can never be auto-followed). Hops are capped.
 *
 * Failure is graceful + typed (resolved | none): the intake step treats
 * none as "proceed to the blank-trim form", so the web lookup NEVER blocks
 * intake. fetchImpl is injectable so every non-live test lane stubs it (no real
 * network in func/vitest); the live serve-live lane uses the real global fetch.
 *
 * Dependency wall: imports only this layer's ssrf validator + node:* + the
 * injected fetch. No model/workflows/app import.
 */

import { validateSourceUrl } from "../ssrf.js";

export type FetchLike = typeof fetch;

export interface TrimSourcesInput {
  readonly make: string;
  readonly model: string;
  readonly year: number;
  /** Optional buyer refinement (e.g. a body style "hatchback") folded into the
   *  discovery search query so a `retry` can narrow the result. */
  readonly refine?: string;
}

export interface TrimSourcesOptions {
  /** Injected for tests (no real network); defaults to the global fetch. */
  readonly fetchImpl?: FetchLike;
  /** Per-fetch timeout (ms); also bounds the overall wall-clock via parallelism. */
  readonly perFetchTimeoutMs?: number;
  /** Max source pages to fetch (seeds + discovered), capped for latency. */
  readonly maxSources?: number;
  /** Injectable DNS resolver passed to validateSourceUrl so tests never touch the
   *  network; defaults to the validator's node:dns lookup. */
  readonly resolveHost?: (host: string) => Promise<string[]>;
}

/**
 * Typed taxonomy — never a silent null. Both non-resolved outcomes degrade the
 * intake step to the blank-trim form, so they collapse to one `none`:
 *   resolved → gathered page text (+ the source URLs it came from)
 *   none     → nothing usable (search and/or every trusted source failed/empty).
 *              Discovery throws and per-source fetch errors are all swallowed to
 *              `none` (the lookup is a non-authoritative helper; it never throws).
 */
export type TrimSourcesResult =
  | { readonly kind: "resolved"; readonly text: string; readonly sources: readonly string[] }
  | { readonly kind: "none" };

/**
 * Positive allowlist of trusted automotive editorial/spec hosts (suffix match on
 * the registrable domain). The ONLY hosts this tool will ever fetch. Adding a host
 * is a deliberate code change — never widened from search results at runtime.
 */
const TRUSTED_TRIM_HOSTS: readonly string[] = [
  "wikipedia.org",
  "caranddriver.com",
  "edmunds.com",
  "kbb.com",
  "motortrend.com",
  "cars.com",
  "carsdirect.com",
  "autoblog.com",
  "jdpower.com",
  "consumerreports.org",
  "truecar.com",
  "usnews.com",
];

/** The keyless DuckDuckGo HTML endpoint (a fixed first-party host; still validated). */
const DDG_HTML = "https://html.duckduckgo.com/html/";

const DEFAULT_PER_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_SOURCES = 4;
const MAX_REDIRECT_HOPS = 3;
const PER_SOURCE_TEXT_CAP = 6_000;
const TOTAL_TEXT_CAP = 14_000;

/** Lowercase URL slug (Car and Driver-style path segment). */
function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Wikipedia article title for a make+model: Title_Case words joined by `_`
 *  (e.g. "Honda Civic" → "Honda_Civic", "Toyota RAV4" → "Toyota_Rav4"). Wikipedia
 *  is the most reliable seed — its trim lineup is in server-rendered VISIBLE text
 *  (editorial sites JS-render the trim tables; a static fetch misses them). */
function wikiTitle(make: string, model: string): string {
  return `${make} ${model}`
    .trim()
    .split(/\s+/)
    .map((w) => (w === "" ? "" : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
    .join("_");
}

/** Suffix-match a URL's host against the trusted allowlist. Returns false on any
 *  parse failure (fail-closed). */
function isTrustedTrimHost(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return TRUSTED_TRIM_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Harvest `"name":"…"` string values from a page's structured-data / JSON data
 *  layer. Editorial trim pages (Car and Driver, Edmunds, …) JS-render the trim
 *  table, so the trim names live in a `__NEXT_DATA__`/JSON-LD blob the visible-text
 *  strip below misses — but they appear as `{"name":"LX",…}` there. Deduped,
 *  length-bounded; the grounded LLM prompt filters the trims out of the noise. */
function harvestStructuredNames(html: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const re = /"name"\s*:\s*"([^"\\]{1,40})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && names.length < 60) {
    const v = (m[1] ?? "").trim();
    if (v === "" || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    names.push(v);
  }
  return names;
}

/** Strip an HTML document to readable text (drop script/style, tags, entities,
 *  collapse whitespace) PLUS a harvested structured-data name list, capped. Good-
 *  enough grounding text for the downstream LLM extraction — not a parser. */
function htmlToText(html: string, cap: number): string {
  const visible = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const names = harvestStructuredNames(html);
  const namesBlock = names.length > 0 ? `\nSTRUCTURED-DATA NAMES: ${names.join(", ")}` : "";
  return (visible + namesBlock).slice(0, cap);
}

/**
 * Fetch one trusted URL, following redirects BY HAND so every hop is re-validated
 * + re-allowlisted (redirect:"manual"). Returns the body text, or null on any
 * non-200 / disallowed-hop / timeout / error (caller tolerates null).
 */
async function fetchTrusted(
  startUrl: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  resolveHost: ((host: string) => Promise<string[]>) | undefined,
): Promise<string | null> {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    if (!isTrustedTrimHost(url)) return null;
    try {
      // https-only, no creds, DNS-checked, no private IP — re-run on every hop.
      await validateSourceUrl(url, resolveHost ? { resolveHost } : undefined);
    } catch {
      return null; // fail-closed on any SSRF-rule violation
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    // The timer stays armed across the BODY read too (cleared in finally only
    // after the body resolves) so a stalled body download aborts at timeoutMs —
    // not at undici's ~300s default. A redirect `continue` still runs finally.
    try {
      const res = await fetchImpl(url, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          accept: "text/html",
        },
      });

      // Manual redirect: re-loop on the Location target (re-validated next iteration).
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (loc === null) return null;
        url = new URL(loc, url).toString(); // resolve relative redirects (throws → caught)
        continue;
      }

      if (res.status !== 200) return null;
      const body = await res.text();
      const text = htmlToText(body, PER_SOURCE_TEXT_CAP);
      return text.length > 200 ? text : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null; // hop budget exhausted
}

/**
 * DuckDuckGo HTML search → trusted-host organic URLs. Decodes each result's
 * `uddg` redirect wrapper to the REAL target before allowlisting, so the wrapper
 * host is never what we end up fetching (the SSRF-by-redirect door, closed).
 */
async function discoverTrustedUrls(
  query: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  resolveHost: ((host: string) => Promise<string[]>) | undefined,
): Promise<string[]> {
  const searchUrl = `${DDG_HTML}?q=${encodeURIComponent(query)}`;
  await validateSourceUrl(searchUrl, resolveHost ? { resolveHost } : undefined);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let html: string;
  try {
    const res = await fetchImpl(searchUrl, {
      signal: ctrl.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    });
    if (res.status !== 200) return [];
    html = await res.text();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < 8) {
    let target = m[1] ?? "";
    // DDG wraps organic links: //duckduckgo.com/l/?uddg=<encoded>&...
    const uddg = /[?&]uddg=([^&]+)/.exec(target);
    if (uddg) {
      try {
        target = decodeURIComponent(uddg[1] ?? "");
      } catch {
        continue;
      }
    } else if (target.startsWith("//")) {
      target = `https:${target}`;
    }
    if (!isTrustedTrimHost(target)) continue; // allowlist the DECODED target
    if (seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

/**
 * Gather web text describing the trims of a make/model/year. Seeds with a fixed
 * trusted URL (Car and Driver's stable /{make}/{model}/trims pattern) and AUGMENTS
 * via a keyless DuckDuckGo search (the user-facing "web search firstly"),
 * allowlist-filtered. All fetches run in parallel under a per-fetch timeout.
 */
export async function fetchTrimSources(
  input: TrimSourcesInput,
  opts: TrimSourcesOptions = {},
): Promise<TrimSourcesResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.perFetchTimeoutMs ?? DEFAULT_PER_FETCH_TIMEOUT_MS;
  const maxSources = opts.maxSources ?? DEFAULT_MAX_SOURCES;

  const makeSlug = slug(input.make);
  const modelSlug = slug(input.model);

  // Fixed trusted seeds (no search needed): Wikipedia FIRST (server-rendered trim
  // text, the reliable source), then Car and Driver (a generally-good fallback).
  const wikiUrl = `https://en.wikipedia.org/wiki/${wikiTitle(input.make, input.model)}`;
  const carAndDriverUrl = `https://www.caranddriver.com/${makeSlug}/${modelSlug}/trims`;

  const refineSuffix = input.refine ? ` ${input.refine}` : "";
  let discovered: string[] = [];
  try {
    discovered = await discoverTrustedUrls(
      `${input.year} ${input.make} ${input.model}${refineSuffix} trim levels features`,
      fetchImpl,
      timeoutMs,
      opts.resolveHost,
    );
  } catch {
    // Discovery failure is non-fatal — fall back to the fixed seed alone.
    discovered = [];
  }

  const candidates: string[] = [];
  const seenCand = new Set<string>();
  for (const u of [wikiUrl, carAndDriverUrl, ...discovered]) {
    if (seenCand.has(u)) continue;
    seenCand.add(u);
    candidates.push(u);
    if (candidates.length >= maxSources) break;
  }

  const fetched = await Promise.allSettled(
    candidates.map((u) => fetchTrusted(u, fetchImpl, timeoutMs, opts.resolveHost)),
  );

  const sources: string[] = [];
  const parts: string[] = [];
  let total = 0;
  for (let i = 0; i < fetched.length; i++) {
    const r = fetched[i];
    if (r === undefined || r.status !== "fulfilled" || r.value === null) continue;
    const remaining = TOTAL_TEXT_CAP - total;
    if (remaining <= 0) break;
    const chunk = r.value.slice(0, remaining);
    parts.push(`SOURCE (${candidates[i]}):\n${chunk}`);
    sources.push(candidates[i] ?? "");
    total += chunk.length;
  }

  if (parts.length === 0) return { kind: "none" };
  return { kind: "resolved", text: parts.join("\n\n"), sources };
}
