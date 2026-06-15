/**
 * quoteSituation — classify the negotiation tone a follow-up should take, from
 * the current quote's itemization and how it compares to the best competing
 * out-the-door price. The thresholds are exact and live in code, never in a
 * prompt: the tone is a deterministic function of the numbers.
 *
 * Pure function — no I/O, no DB.
 */

import { ASSERTIVE_OTD_DELTA_USD } from "./constants.js";

/** The four tones a follow-up can take. */
export type QuoteTone = "conservative" | "appreciative" | "assertive" | "moderate";

/** The inputs the tone is derived from. */
export interface QuoteSituation {
  /** Whether the current OTD is fully itemized (vs an estimate). */
  isItemized: boolean;
  /** The best competing dealer's OTD, or null when none is known. */
  bestCompetingOtd: number | null;
  /** The current dealer's OTD, or null when not yet quoted. */
  currentOtd: number | null;
}

/**
 * Classification ladder (fixed precedence):
 *   1. conservative — the current OTD is only estimated (not itemized): too
 *      little hard data to push.
 *   2. appreciative — either side's OTD is unknown, OR the current quote is
 *      already at/under the best competing (delta ≤ 0): nothing to push for.
 *   3. assertive — the current quote is more than the threshold above the best
 *      competing (delta STRICTLY greater than the threshold): clear room to ask.
 *   4. moderate — everything else (a small positive delta within the threshold).
 */
export function classifyQuoteSituation(situation: QuoteSituation): QuoteTone {
  if (!situation.isItemized) return "conservative";

  const { bestCompetingOtd: competing, currentOtd: current } = situation;
  if (competing === null || current === null) return "appreciative";

  const delta = current - competing;
  if (delta > ASSERTIVE_OTD_DELTA_USD) return "assertive";
  if (delta <= 0) return "appreciative";
  return "moderate";
}
