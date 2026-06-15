/**
 * submitOutcome — the deterministic classification + retry state machine for a
 * dealer web-form submit. These gates live in code, never in a prompt: whether a
 * response page counts as accepted / captcha-blocked / email-only / unknown, and
 * what to do next, is decided here from the raw HTML + status alone.
 *
 * Pure functions — no I/O, no DB, no browser.
 */

import { MAX_RETRIES } from "./constants.js";

/** The four buckets a submit response page falls into. */
export type SubmitOutcome = "captcha" | "accepted" | "email_only" | "unknown";

/** What to do after a submit attempt, given its outcome + attempt count. */
export type RetryAction = "retry" | "stop" | "email_fallback";

/** Captcha / human-verification markers, checked WITHOUT regard to HTTP status. */
const CAPTCHA_MARKERS = ["g-recaptcha", "h-captcha", "verify you are human"];

/**
 * True iff a captcha widget / human-verification prompt is present in the HTML.
 * Shared by the POST-submit classifier and the SCOUT-time form check: a captcha
 * on a contact form means the form can never be auto-submitted, so the dealer is
 * routed to email fallback and the captcha is NEVER submitted or retried. Pure.
 */
export function hasCaptcha(html: string): boolean {
  const lowered = html.toLowerCase();
  return CAPTCHA_MARKERS.some((m) => lowered.includes(m));
}

/**
 * Classify a submit response. Precedence is fixed (first match wins):
 *   1. captcha — a captcha widget / human-verification prompt is present,
 *      checked WITHOUT regard to HTTP status (a captcha at any status blocks).
 *   2. accepted — a 2xx/3xx status AND a thank-you confirmation marker.
 *   3. email_only — a `mailto:` link is present and there is NO form on the page
 *      (the dealer wants email contact, not a form submit).
 *   4. unknown — anything else.
 */
export function classifySubmitOutcome(html: string, status: number): SubmitOutcome {
  const lowered = html.toLowerCase();

  if (hasCaptcha(html)) {
    return "captcha";
  }

  const okStatus = status >= 200 && status <= 399;
  if (
    okStatus &&
    (lowered.includes("thank you") ||
      lowered.includes("thank-you") ||
      lowered.includes("thankyou") ||
      lowered.includes("thanks for"))
  ) {
    return "accepted";
  }

  if (lowered.includes("mailto:") && !lowered.includes("<form")) {
    return "email_only";
  }

  return "unknown";
}

/**
 * Decide the next move after a submit attempt:
 *   - accepted → stop (the lead landed).
 *   - captcha / email_only → email_fallback immediately, NEVER retried (a retry
 *     of either would just hit the same wall).
 *   - unknown → retry while `attempt < MAX_RETRIES`, otherwise email_fallback.
 *   - any unexpected outcome → stop (defensive catch-all).
 */
export function retryStrategy(attempt: number, outcome: SubmitOutcome): RetryAction {
  if (outcome === "accepted") return "stop";
  if (outcome === "captcha" || outcome === "email_only") return "email_fallback";
  if (outcome === "unknown") {
    return attempt < MAX_RETRIES ? "retry" : "email_fallback";
  }
  return "stop";
}

/** Strip a raw form-field label down to a canonical snake_case key: lowercased,
 *  every run of non-alphanumeric characters collapsed to a single underscore,
 *  with leading/trailing underscores trimmed. */
export function normalizeFormFieldName(raw: string): string {
  if (raw === "") return "";
  const lowered = raw.trim().toLowerCase();
  return lowered.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** One field of a discovered form spec. */
export interface FormFieldSpec {
  name: string;
  required: boolean;
}

/** The set of normalized names of the required fields in a form spec. */
export function requiredFieldSet(spec: readonly FormFieldSpec[]): Set<string> {
  const out = new Set<string>();
  for (const field of spec) {
    if (field.required) out.add(normalizeFormFieldName(field.name));
  }
  return out;
}
