/**
 * dealerComm constants — the fixed strings and numeric thresholds every
 * dealer-facing message and submit/retry decision is built from. Pinned once
 * here so a template edit can never drift a value out from under the byte
 * snapshots that guard the rendered output.
 *
 * Pure data only — no I/O, no DB, no network.
 */

/**
 * The phone a dealer ever sees on a lead form or in an email. NEVER the buyer's
 * real number: a real number is only ever surfaced under an explicit opt-in
 * elsewhere; the comm layer always defaults to this synthetic.
 */
export const FAKE_PHONE_DEFAULT = "(555) 010-0000";

/**
 * How many web-form submit attempts may run before an "unknown" outcome falls
 * back to email. The bound is the count of allowed attempts (`attempt < MAX`):
 * attempts 1 and 2 may retry; attempt 3 falls back.
 */
export const MAX_RETRIES = 2;

/**
 * The out-the-door delta (USD) above which a quote situation reads as
 * "assertive". Compared with a STRICT `>` — a delta of exactly this much is not
 * assertive.
 */
export const ASSERTIVE_OTD_DELTA_USD = 500;

/**
 * The BATCH-lane silence window (days): negotiation_followup's batch follow-up
 * drops a dealer whose last inbound is older than this — shorter than the single-
 * target timing-gate default of 14d. The give-up advisory projection reuses THIS
 * (not 14) so it reflects when a dealer is actually dropped from a follow-up run.
 * Shared here so the workflow and the projection can never drift apart.
 */
export const BATCH_SILENCE_WINDOW_DAYS = 7;

/** Subject prefix for the first contact with a dealer (a fresh quote ask). */
export const SUBJECT_PREFIX_FIRST_TOUCH = "[Quote Request]";

/** Subject prefix for any follow-up, including the closeout email (no third
 *  prefix is introduced for closeout — it reuses this one). */
export const SUBJECT_PREFIX_FOLLOWUP = "[Quote Follow-up]";

/**
 * The fixed footer appended to outbound dealer messages. Set once and never
 * edited per message — it frames the reply expectations so a dealer knows the
 * buyer is comparing several quotes.
 */
export const FOOTER_DISCLAIMER =
  "Replies sent to this address reach a buyer who is collecting quotes " +
  "from several dealerships. Please include OTD, fees, and incentives.";

/**
 * Wrap untrusted dealer-originated text in explicit fences before it is ever
 * placed near model instructions. The fence is a data-not-instruction marker:
 * anything between the markers is to be treated as quoted dealer content, never
 * as something to act on.
 */
export function wrapUntrustedDealerInput(text: string): string {
  return `<<<DEALER_UNTRUSTED\n${text}\nDEALER_UNTRUSTED>>>`;
}
