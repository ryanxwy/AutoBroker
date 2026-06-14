/**
 * hygiene classify — the PURE, KEEP-biased intent membership test for the
 * CRM-thread cleanup candidate set. Zero LLM, zero DB: a thread's intent string
 * is matched against a small, closed suppressible set.
 *
 * KEEP BIAS (load-bearing): only the four soft, no-quote intents are
 * suppressible. Anything carrying real negotiating value
 * ({quote, pricing, qualification}) is NEVER a candidate, and any intent OUTSIDE
 * the suppressible set (including null/unknown) errs toward KEEP. The detection
 * query and the throwing write guard both lean on this — a thread is only ever
 * cleaned if it is explicitly, conservatively classified as marketing noise.
 *
 * Dependency wall: a pure leaf — imports nothing.
 */

/** The closed set of CRM-noise intents that MAY be suppressed (cleanup). Every
 *  other intent — explicitly the quote/pricing/qualification class, plus any
 *  unknown/null — is KEPT. */
export const SUPPRESSIBLE_INTENTS = new Set<string>([
  "nurture",
  "crm_followup",
  "appointment_request",
  "marketing",
]);

/** The intents that carry real negotiating value and must NEVER be a cleanup
 *  candidate — surfaced for the detection query + the write-time guard so the
 *  "never clean a quote thread" rule is stated once. */
export const VALUE_INTENTS = new Set<string>(["quote", "pricing", "qualification"]);

/**
 * True only when `intent` is one of the four suppressible CRM-noise intents.
 * KEEP-biased: null, unknown, and every value-bearing intent return false.
 */
export function isSuppressibleIntent(intent: string | null): boolean {
  if (intent === null) return false;
  return SUPPRESSIBLE_INTENTS.has(intent.trim().toLowerCase());
}

/** True when `intent` is value-bearing (quote/pricing/qualification) — the
 *  guard predicate the write layer re-asserts before suppressing a thread. */
export function isValueIntent(intent: string | null): boolean {
  if (intent === null) return false;
  return VALUE_INTENTS.has(intent.trim().toLowerCase());
}
