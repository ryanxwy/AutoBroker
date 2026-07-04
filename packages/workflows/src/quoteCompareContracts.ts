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
 * audit, gate, rank) is deterministic; there is no emit schema, no
 * structured-output surface, no suspend point. The output is a SINGLE object — both finance and
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
/**
 * The cross-state OTD-delta attribution carried on a ranked row — why this row's
 * normalized OTD differs from its bucket's best. Flat, all-required: the five
 * component deltas reconcile to `otd_delta` to the cent (2-dp; `other_delta` is
 * the reconciling residual capturing unnamed fees + penny rounding). Negative =
 * cheaper than the baseline on that component. Tax is the home-state-NORMALIZED
 * tax, so a cross-state dealer's tax-collection difference never shows as a fake
 * "win".
 */
export const OtdAttributionSchema = z
  .object({
    /** The bucket baseline's quote_id (the lowest normalized OTD). */
    baseline_quote_id: z.string(),
    otd_delta: z.number(),
    sale_price_delta: z.number(),
    doc_fee_delta: z.number(),
    tax_delta: z.number(),
    incentive_delta: z.number(),
    other_delta: z.number(),
  })
  .strict();
export type OtdAttribution = z.infer<typeof OtdAttributionSchema>;

export const QuoteRankingSchema = z
  .object({
    rank: z.number().int(),
    /** The source quote's id — the join key the Canvas quote-detail modal uses
     *  to resolve a ranked row back to its full raw-quote breakdown. Never
     *  rendered (id red line); "" when the ranker had no id in scope. */
    quote_id: z.string(),
    dealer_id: z.string(),
    dealer_name: z.string(),
    otd_total: z.number().nullable(),
    apr_or_mf: z.string(),
    down_or_das: z.number().nullable(),
    monthly: z.number().nullable(),
    audit_flag_summary: z.array(z.string()),
    financing_mode: z.string(),
    /** Tax re-computed at the buyer's HOME-state rate (cross-state correctness:
     *  sales/use tax follows the registration state, not the dealer's). null when
     *  un-normalizable (unknown state / missing selling price). */
    normalized_tax: z.number().nullable(),
    /** otd_total with the dealer-stated tax swapped for the home-state tax. null
     *  when un-normalizable. The honest cross-state drive-off cost. */
    normalized_otd: z.number().nullable(),
    /** Why this row's normalized OTD differs from the bucket's best; null for the
     *  baseline row itself and for un-normalizable rows. */
    attribution: OtdAttributionSchema.nullable(),
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
    /** Cash quotes ranked by OTD (populated for a cash-preference buyer; empty
     *  otherwise — cash rides inside finance as an off-mode row there). */
    cash: z.array(QuoteRankingSchema),
    /** finance.length + lease.length + cash.length — the total ranked. */
    totalRanked: z.number().int(),
    /** The deterministic terminal sentence (no budget number anywhere). */
    summary: z.string(),
    /** The buyer's home (registration) state — the source of the tax rate every
     *  quote is normalized to. null when the profile carries no state. */
    homeState: z.string().nullable(),
    /** The home-state sales/use tax rate every quote's tax is normalized to
     *  (fraction, e.g. 0.0725). null when the state is unknown / missing. */
    homeStateTaxRate: z.number().nullable(),
  })
  .strict();
export type QuoteCompareOutput = z.infer<typeof QuoteCompareOutputSchema>;

/**
 * The honest cross-state framing for the comparison surface. Widening the search
 * across state lines wins on PRICE, DOC FEE, and regional INCENTIVES — NOT on tax
 * (the buyer pays their home-state use tax regardless of where they buy), minus
 * travel/shipping. Surfaced as UI copy so a lower out-of-state OTD is never sold
 * as a tax saving it isn't.
 */
export const CROSS_STATE_FRAMING_NOTE =
  "Tax is normalized to your home state — you owe home-state use tax wherever you " +
  "buy. Crossing state lines wins on price, doc fee, and local incentives, not tax " +
  "(minus any travel/shipping).";

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
