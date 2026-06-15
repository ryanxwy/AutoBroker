/**
 * quote_compare contracts — the typed input/output and the typed STOP
 * vocabulary the quoteCompare workflow and the server descriptor share.
 * Skill-local, single-use (only the workflow file and its tests import them),
 * kept out of the shared core layer like the other skills' contracts; core owns
 * only ROW shapes.
 *
 * PROFILE RESOLUTION — read-only / infer-ok. quote_compare is a re-runnable
 * read: a single active profile is INFERRED (the resolver's exactly-1 branch),
 * a supplied pin wins, zero active STOPs pointing at intake, and 2+ active STOPs
 * asking by car name. There is NO pick-suspend — a STOP is terminal.
 *
 * ZERO-LLM: the whole compare (read preference, read quotes joined to the latest
 * audit, gate, rank) is deterministic; there is no emit schema, no #1244
 * surface, no suspend point. The output is a SINGLE object — both finance and
 * lease buckets are always present (the empty off-mode side is the contract).
 *
 * No budget anywhere: the ranked rows carry OTD totals + rate + payment + audit
 * flag codes, NEVER a budget number.
 *
 * Dependency wall: imports zod only (the ranked shape is flat primitives).
 */

import { z } from "zod";

/** The stable workflow id (registration + the server descriptor). */
export const QUOTE_COMPARE_WORKFLOW_ID = "quote_compare" as const;

// ---------------------------------------------------------------------------
// workflow input / output
// ---------------------------------------------------------------------------

/** The workflow input (the server descriptor builds this from the start body).
 *  The profile pin is the ONLY input; null → 1/0/2+ three-branch resolution. */
export const QuoteCompareInputSchema = z.object({
  /** Explicit profile pin, or null → three-branch resolution over active rows. */
  search_profile_id: z.string().nullable(),
});
export type QuoteCompareInput = z.infer<typeof QuoteCompareInputSchema>;

/**
 * One ranked compare row — flat, all-required-with-explicit-null. `rank` is
 * 1-indexed within its mode bucket; `dealer_name` is COALESCE(dealers.name,
 * dealer_id); `otd_total` null sorts last (rendered "incomplete"); `apr_or_mf`
 * is the preformatted display string (`"7.9%"` / `"MF 0.00125"` / `""`);
 * `audit_flag_summary` is ALWAYS a list (the decoded latest-audit codes, empty
 * when none).
 */
export const QuoteRankingSchema = z
  .object({
    rank: z.number().int(),
    dealer_id: z.string(),
    dealer_name: z.string(),
    otd_total: z.number().nullable(),
    apr_or_mf: z.string(),
    down_or_das: z.number().nullable(),
    monthly: z.number().nullable(),
    audit_flag_summary: z.array(z.string()),
    financing_mode: z.string(),
  })
  .strict();
export type QuoteRankingRow = z.infer<typeof QuoteRankingSchema>;

/**
 * The workflow output — a SINGLE object (no union, no suspend): the finance +
 * lease buckets (BOTH always present), the loaded financing preference, the
 * total ranked count, the profile-resolution provenance, and the deterministic
 * terminal summary. Empty buckets (cash / no quotes) are a VALID success.
 */
export const QuoteCompareOutputSchema = z
  .object({
    outcome: z.literal("compared"),
    /** Profile-resolution provenance (pinned vs inferred-newest). */
    resolution: z.enum(["pinned", "inferred_newest"]),
    search_profile_id: z.string(),
    /** The loaded financing_preference (null when the profile is missing / the
     *  column is NULL — both gate to empty buckets). */
    financingPreference: z.string().nullable(),
    finance: z.array(QuoteRankingSchema),
    lease: z.array(QuoteRankingSchema),
    /** finance.length + lease.length — the total ranked across both buckets. */
    totalRanked: z.number().int(),
    /** The deterministic terminal sentence (no budget number anywhere). */
    summary: z.string(),
  })
  .strict();
export type QuoteCompareOutput = z.infer<typeof QuoteCompareOutputSchema>;

// ---------------------------------------------------------------------------
// typed STOP codes (read-only three-branch: 0 active / 2+ active)
// ---------------------------------------------------------------------------

/** The three-branch STOP codes (members of the UI PROFILE_STOP_CODES set). */
export type QuoteCompareStopCode = "no_active_profile" | "multiple_active_profiles";

/** Typed STOP from the resolve step. The message is the user-facing wording —
 *  the server surfaces it verbatim on the run's error frame. */
export class QuoteCompareStopError extends Error {
  readonly code: QuoteCompareStopCode;
  constructor(code: QuoteCompareStopCode, message: string) {
    super(message);
    this.name = "QuoteCompareStopError";
    this.code = code;
  }
}
