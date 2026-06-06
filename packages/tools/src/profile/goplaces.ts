/**
 * goplaces — the ONLY external API call in the intake vertical, and it is
 * READ-ONLY (geocoding a free-text location string into coordinates). Lives in
 * packages/tools because tools is the sole layer permitted to touch an external
 * API (CLAUDE.md SQLite/external-API invariant).
 *
 * IN-PROCESS REST client (the historical "goplaces CLI" wording is Python-era
 * residue; the 2026-06-04 pre-impl ruling makes it an in-process fetch client).
 *
 * API CHOICE — Google Geocoding API (web service), NOT Places Text Search (New):
 *   - The contract is free-text "city / postal code / address" -> {lat,lng,formattedAddress,
 *     postalCode?} with an AMBIGUOUS multi-candidate case. Geocoding is the
 *     canonical free-text-address -> coordinates API: it returns a `results[]`
 *     array and "may return several results when address queries are ambiguous"
 *     (the exact ambiguity signal the contract needs), each result carrying
 *     `formatted_address`, `geometry.location.{lat,lng}`, and `address_components`
 *     (postal_code).
 *   - It is the cheapest adequate fit: Geocoding is an Essentials SKU
 *     (~$2-7 / 1k requests, 10k free events/month, flat per-request price),
 *     whereas Places Text Search (New) is a tiered Pro SKU keyed on a field mask
 *     and oriented at POI/business search — overkill and pricier for plain
 *     address resolution.
 *   - Docs: https://developers.google.com/maps/documentation/geocoding/requests-geocoding
 *
 * COORDINATE-RESOLUTION INVARIANT — geocode failure is NOT a pass:
 *   resolveLocation returns a TYPED three-way taxonomy and NEVER a silent null.
 *   no_result / network_exhausted / api_error are all explicit failures the
 *   workflow layer surfaces (suspend -> re-prompt the form). Coordinates MUST be
 *   resolved before persist; geocode failure suspends, never silently passes.
 *   This client never invents or NULLs coordinates.
 *
 * RETRY POLICY: only TRANSIENT errors (network throw / HTTP 5xx /
 * HTTP 429 / Google transient status UNKNOWN_ERROR | OVER_QUERY_LIMIT) get a
 * bounded retry with backoff. Each retry appends a trace-span record carried on
 * the result. Non-transient errors (4xx auth/quota deny, ZERO_RESULTS, malformed
 * payload) fail immediately — no retry, no fallback.
 */

import { setTimeout as delay } from "node:timers/promises";

/** Resolved geographic point + its canonical address, as the contract needs it. */
export interface GeoLocation {
  readonly lat: number;
  readonly lng: number;
  readonly formattedAddress: string;
  /** Present only when the result carried a postal_code component. */
  readonly postalCode?: string;
}

/** One trace-span entry recorded per retry attempt (every retry is voiced). */
export interface GoplacesTraceSpan {
  /** 1-based attempt index that FAILED transiently and triggered this span. */
  readonly attempt: number;
  /** Human-readable transient error that caused the retry. */
  readonly error: string;
  /** Wall-clock ms (Date.now()) when the failing attempt resolved. */
  readonly atMs: number;
}

/** Why a resolveLocation call failed (never a silent null). */
export type GoplacesFailureReason =
  /** Google returned ZERO_RESULTS — the query matched nothing. */
  | "no_result"
  /** Transient errors exhausted the bounded retry budget. */
  | "network_exhausted"
  /** Non-transient API rejection (REQUEST_DENIED / INVALID_REQUEST / 4xx / bad payload). */
  | "api_error";

/**
 * The three-way result taxonomy. Every branch carries the trace spans
 * accumulated from any transient retries so the workflow layer can voice them.
 */
export type GoplacesResult =
  | { readonly kind: "resolved"; readonly location: GeoLocation; readonly traceSpans: readonly GoplacesTraceSpan[] }
  | { readonly kind: "ambiguous"; readonly candidates: readonly GeoLocation[]; readonly traceSpans: readonly GoplacesTraceSpan[] }
  | {
      readonly kind: "failed";
      readonly reason: GoplacesFailureReason;
      readonly detail: string;
      readonly traceSpans: readonly GoplacesTraceSpan[];
    };

/** Injected fetch (the global `fetch` in prod; a stub in unit tests). */
export type FetchLike = typeof fetch;

export interface GoplacesOptions {
  /** Override for tests; defaults to the global `fetch`. */
  readonly fetchImpl?: FetchLike;
  /** Override for tests; defaults to process.env.GOOGLE_PLACES_API_KEY. */
  readonly apiKey?: string;
  /** Extra retries AFTER the first attempt on transient failure (default 2). */
  readonly maxRetries?: number;
  /** Base backoff ms; attempt N waits baseDelayMs * 2^(N-1) (default 250). */
  readonly baseDelayMs?: number;
}

/**
 * Max candidates surfaced on ambiguity (the multi-match cap — see
 * resolveLocation below). With no pinned N or re-ranking rule, we cap at 5 and
 * PRESERVE Google's own relevance order (results[0] is the geocoder's best
 * guess), which is the documented ranking.
 */
export const MAX_AMBIGUOUS_CANDIDATES = 5;

const GEOCODE_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json";

/** Google statuses we treat as TRANSIENT (worth a bounded retry). */
const TRANSIENT_GOOGLE_STATUSES = new Set(["UNKNOWN_ERROR", "OVER_QUERY_LIMIT"]);

/** Raw subset of the Geocoding JSON payload we read. */
interface AddressComponent {
  long_name?: string;
  short_name?: string;
  types?: readonly string[];
}
interface GeocodeResult {
  formatted_address?: string;
  geometry?: { location?: { lat?: number; lng?: number } };
  address_components?: readonly AddressComponent[];
}
interface GeocodePayload {
  status?: string;
  error_message?: string;
  results?: readonly GeocodeResult[];
}

class TransientGeocodeError extends Error {}
class NonTransientGeocodeError extends Error {
  constructor(
    message: string,
    readonly reason: Extract<GoplacesFailureReason, "no_result" | "api_error">,
  ) {
    super(message);
  }
}

function resolveApiKey(opts: GoplacesOptions): string {
  const key = opts.apiKey ?? process.env["GOOGLE_PLACES_API_KEY"];
  if (key === undefined || key.length === 0) {
    // Fail LOUD — a missing key is a configuration fault, not a geocode miss.
    throw new Error("goplaces: GOOGLE_PLACES_API_KEY is not set");
  }
  return key;
}

function extractPostalCode(components: readonly AddressComponent[] | undefined): string | undefined {
  if (components === undefined) return undefined;
  for (const c of components) {
    if (c.types?.includes("postal_code") === true) {
      return c.long_name ?? c.short_name ?? undefined;
    }
  }
  return undefined;
}

/** Map one raw geocode result to a GeoLocation, or null if it is unusable. */
function toGeoLocation(result: GeocodeResult): GeoLocation | null {
  const lat = result.geometry?.location?.lat;
  const lng = result.geometry?.location?.lng;
  const formattedAddress = result.formatted_address;
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    Number.isNaN(lat) ||
    Number.isNaN(lng) ||
    typeof formattedAddress !== "string" ||
    formattedAddress.length === 0
  ) {
    return null;
  }
  const postalCode = extractPostalCode(result.address_components);
  return postalCode === undefined ? { lat, lng, formattedAddress } : { lat, lng, formattedAddress, postalCode };
}

/**
 * Perform ONE geocode HTTP call and parse it into GeoLocations.
 * Throws TransientGeocodeError (retryable) or NonTransientGeocodeError (terminal).
 */
async function geocodeOnce(query: string, apiKey: string, fetchImpl: FetchLike): Promise<GeoLocation[]> {
  const url = `${GEOCODE_ENDPOINT}?address=${encodeURIComponent(query)}&key=${encodeURIComponent(apiKey)}`;

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(url);
  } catch (e) {
    // Network-layer throw (DNS, connreset, timeout) — transient.
    throw new TransientGeocodeError(`network error: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (response.status === 429 || response.status >= 500) {
    throw new TransientGeocodeError(`HTTP ${response.status}`);
  }
  if (response.status >= 400) {
    // 4xx auth/quota/bad-request — terminal.
    throw new NonTransientGeocodeError(`HTTP ${response.status}`, "api_error");
  }

  let payload: GeocodePayload;
  try {
    payload = (await response.json()) as GeocodePayload;
  } catch (e) {
    throw new NonTransientGeocodeError(
      `malformed JSON: ${e instanceof Error ? e.message : String(e)}`,
      "api_error",
    );
  }

  const status = payload.status;
  if (status === "ZERO_RESULTS") {
    throw new NonTransientGeocodeError("ZERO_RESULTS", "no_result");
  }
  if (status !== "OK") {
    const detail = payload.error_message ? `${status}: ${payload.error_message}` : String(status);
    if (status !== undefined && TRANSIENT_GOOGLE_STATUSES.has(status)) {
      throw new TransientGeocodeError(detail);
    }
    // REQUEST_DENIED / INVALID_REQUEST / OVER_DAILY_LIMIT / unknown — terminal.
    throw new NonTransientGeocodeError(detail, "api_error");
  }

  const rawResults = payload.results ?? [];
  const locations: GeoLocation[] = [];
  for (const r of rawResults) {
    const loc = toGeoLocation(r);
    if (loc !== null) locations.push(loc);
  }
  if (locations.length === 0) {
    // status OK but nothing usable parsed out — treat as no result, terminal.
    throw new NonTransientGeocodeError("OK status with no usable results", "no_result");
  }
  return locations;
}

/**
 * Resolve a free-text location into coordinates with the three-way taxonomy.
 *
 *   single usable result  -> { kind: "resolved", location }
 *   2+ usable results      -> { kind: "ambiguous", candidates }  (suspend ask-pick)
 *   zero results           -> { kind: "failed", reason: "no_result" }
 *   transient, retries out -> { kind: "failed", reason: "network_exhausted" }
 *   terminal API rejection -> { kind: "failed", reason: "api_error" }
 *
 * Never returns null; never invents coordinates.
 */
export async function resolveLocation(query: string, opts: GoplacesOptions = {}): Promise<GoplacesResult> {
  const apiKey = resolveApiKey(opts);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 250;

  const traceSpans: GoplacesTraceSpan[] = [];
  let lastTransientDetail = "";

  // attempt 1 + maxRetries follow-ups; only transient failures consume a retry.
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    try {
      const locations = await geocodeOnce(query, apiKey, fetchImpl);
      if (locations.length === 1) {
        return { kind: "resolved", location: locations[0]!, traceSpans };
      }
      return {
        kind: "ambiguous",
        candidates: locations.slice(0, MAX_AMBIGUOUS_CANDIDATES),
        traceSpans,
      };
    } catch (e) {
      if (e instanceof NonTransientGeocodeError) {
        return { kind: "failed", reason: e.reason, detail: e.message, traceSpans };
      }
      if (e instanceof TransientGeocodeError) {
        lastTransientDetail = e.message;
        // Record the failed attempt as a trace span (every retry is voiced).
        traceSpans.push({ attempt, error: e.message, atMs: Date.now() });
        if (attempt <= maxRetries) {
          await delay(baseDelayMs * 2 ** (attempt - 1));
          continue;
        }
        // Budget exhausted.
        return {
          kind: "failed",
          reason: "network_exhausted",
          detail: `retries exhausted (${maxRetries + 1} attempts); last error: ${lastTransientDetail}`,
          traceSpans,
        };
      }
      throw e; // unexpected — fail LOUD, never swallow.
    }
  }

  // Unreachable: the loop always returns. Fail LOUD if control ever falls here.
  throw new Error("goplaces: retry loop exited without a result");
}
