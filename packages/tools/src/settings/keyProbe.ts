/**
 * keyProbe — a CHEAP, real "test this key before I save it" check for the five
 * managed credentials, using the CANDIDATE value the owner just typed (so the
 * test validates the key that is about to be stored, not whatever is currently
 * in the env).
 *
 * WHAT IT DOES:
 *   - google_places: one trial geocode of a fixed string via the existing
 *     resolveLocation, passing opts.apiKey = the candidate (it already supports
 *     the override). A resolved/ambiguous result = the key works; an api_error =
 *     a bad key/quota.
 *   - deepseek / anthropic / openai: a single cheap, NON-MUTATING authenticated
 *     GET to the provider's model-list endpoint, bound to the candidate key. A
 *     2xx = the key authenticates; a 401/403 = an invalid/forbidden key. We do
 *     NOT construct an AI-SDK provider here — the AI SDK is the model layer's
 *     framework and is invisible to tools — so the LLM probe is a direct fetch,
 *     exactly the kind of read-only external call tools is allowed to make.
 *   - claude_oauth: PRESENCE-ONLY — no network call. It is an OAuth subscription
 *     token, not an x-api-key, so probing Anthropic's model-list with it would
 *     false-negative a valid token; a non-empty candidate is reported ok.
 *
 * NEVER a mutation. NEVER logs the candidate key. The candidate is used ONLY for
 * this one request — process.env is NOT touched (a test must not change the
 * saved/live key).
 *
 * TEST SEAM: the real network probe is injected. Functional/unit tests call
 * __setSecretsProbeForTests({...}) to stub it so they make ZERO real external
 * calls; production uses the real implementation. A real probe fires only on a
 * real owner click.
 */

import { resolveLocation, type GoplacesResult } from "../profile/goplaces.js";
import { SECRET_KEY_IDS, type SecretKeyId } from "./secretsStore.js";

/** The probe verdict: ok = the key authenticated; detail is a short, readable
 *  reason (never the key itself). A failed probe is still a normal result — the
 *  caller surfaces ok:false, it is not an exception. */
export interface KeyProbeResult {
  readonly ok: boolean;
  readonly detail: string;
}

/** LLM provider ids that use a network probe (excludes google_places and
 *  claude_oauth, which have their own non-network paths). */
type LlmProbeId = Exclude<SecretKeyId, "google_places" | "claude_oauth">;

/** The two real probes, behind an injectable seam. */
export interface SecretsProbeDeps {
  /** Validate an LLM provider key with a cheap authenticated read. */
  probeLlm: (id: LlmProbeId, candidateKey: string) => Promise<KeyProbeResult>;
  /** Validate the geocoding key with one trial geocode. */
  probeGeocode: (candidateKey: string) => Promise<KeyProbeResult>;
}

/** The model-list endpoint + auth shape per LLM provider (a GET, no body, no
 *  mutation). Base URLs match the AI-SDK provider defaults. */
const LLM_PROBE_ENDPOINTS: Readonly<
  Record<LlmProbeId, { url: string; headers: (key: string) => Record<string, string> }>
> = {
  deepseek: {
    // OpenAI-compatible API — Bearer auth, GET /models.
    url: "https://api.deepseek.com/models",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
  },
  openai: {
    url: "https://api.openai.com/v1/models",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
  },
  anthropic: {
    // Anthropic uses x-api-key + a required anthropic-version header.
    url: "https://api.anthropic.com/v1/models?limit=1",
    headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
  },
};

/** A fixed, unambiguous geocode query for the trial. */
const GEOCODE_PROBE_QUERY = "1600 Amphitheatre Parkway, Mountain View, CA";

/** Real LLM probe: one authenticated GET to the model-list endpoint. */
async function realProbeLlm(
  id: LlmProbeId,
  candidateKey: string,
): Promise<KeyProbeResult> {
  const ep = LLM_PROBE_ENDPOINTS[id];
  let res: Response;
  try {
    res = await fetch(ep.url, { method: "GET", headers: ep.headers(candidateKey) });
  } catch (e) {
    return { ok: false, detail: `no network: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (res.ok) {
    return { ok: true, detail: `${id} key accepted (HTTP ${res.status})` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, detail: `${res.status} invalid key` };
  }
  return { ok: false, detail: `HTTP ${res.status}` };
}

/** Real geocode probe: one trial geocode bound to the candidate key. */
async function realProbeGeocode(candidateKey: string): Promise<KeyProbeResult> {
  let result: GoplacesResult;
  try {
    result = await resolveLocation(GEOCODE_PROBE_QUERY, { apiKey: candidateKey });
  } catch (e) {
    // resolveLocation throws only on a missing key (a config fault) — surface it.
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  if (result.kind === "resolved" || result.kind === "ambiguous") {
    return { ok: true, detail: "google_places key accepted (geocode OK)" };
  }
  // kind === "failed": no_result is unexpected for the fixed query, but treat
  // api_error / network_exhausted / no_result as a failed probe with the detail.
  return { ok: false, detail: `geocode ${result.reason}: ${result.detail}` };
}

const realDeps: SecretsProbeDeps = {
  probeLlm: realProbeLlm,
  probeGeocode: realProbeGeocode,
};

let injectedDeps: SecretsProbeDeps | undefined;

function deps(): SecretsProbeDeps {
  return injectedDeps ?? realDeps;
}

/**
 * TEST-ONLY seam. Refused outside a test runner — a production caller must never
 * redirect the real network probe. Pass a partial; unspecified probes keep their
 * real implementation.
 */
export function __setSecretsProbeForTests(partial: Partial<SecretsProbeDeps>): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error("__setSecretsProbeForTests is a test-only seam (refused outside a test runner)");
  }
  injectedDeps = { ...realDeps, ...partial };
}

/** Restore the real probe wiring between test cases. */
export function __resetSecretsProbeForTests(): void {
  injectedDeps = undefined;
}

/**
 * Test a candidate key. Routes each id to its check: google_places → geocode,
 * the three LLM keys → network probe, claude_oauth → presence-only (no network).
 * An unknown id is a failed probe (ok:false) rather than a throw — the route
 * validates the id shape upstream, this stays defensive. NEVER logs/returns the
 * candidate value.
 */
export async function testKey(id: string, candidateKey: string): Promise<KeyProbeResult> {
  if (!(SECRET_KEY_IDS as readonly string[]).includes(id)) {
    return { ok: false, detail: `unknown secret key id '${id}'` };
  }
  if (candidateKey.length === 0) {
    return { ok: false, detail: "empty candidate key" };
  }
  if (id === "google_places") {
    return deps().probeGeocode(candidateKey);
  }
  if (id === "claude_oauth") {
    // OAuth token: presence-only — probing Anthropic /v1/models with an OAuth
    // token (not an x-api-key) would false-negative a valid token.
    return { ok: true, detail: "claude_oauth present (OAuth token; not network-probed)" };
  }
  return deps().probeLlm(id as LlmProbeId, candidateKey);
}
