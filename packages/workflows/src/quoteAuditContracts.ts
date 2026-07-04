/**
 * quote_audit contracts — the typed input/output and the typed STOP vocabulary
 * the quoteAudit workflow and the server descriptor share. Skill-local,
 * single-use (only the workflow file and its tests import them), kept out of the
 * shared core layer like the other skills' contracts; core owns only ROW shapes.
 *
 * PROFILE RESOLUTION — read-only / infer-ok. quote_audit is a re-runnable read:
 * a single active profile is INFERRED (the resolver's exactly-1 branch), a
 * supplied pin wins, zero active STOPs pointing at intake, and 2+ active STOPs
 * asking by car name. There is NO pick-suspend — a STOP is terminal.
 *
 * ZERO-LLM: the whole audit (resolve, read quotes/peers/incentives, run the
 * deterministic 10 checks, persist) is deterministic; there is no emit schema,
 * no structured-output surface, no suspend point. The only writes are quote_audits rows
 * (idempotent on (dealer_quote_id, audit_pass_version)).
 *
 * Dependency wall: imports @autobroker/core (the AuditFinding shape) + zod only.
 */

import { AuditFindingSchema } from "@autobroker/core";
import { z } from "zod";

/** The stable workflow id (registration + the server descriptor). */
export const QUOTE_AUDIT_WORKFLOW_ID = "quote_audit" as const;

// ---------------------------------------------------------------------------
// workflow input / output
// ---------------------------------------------------------------------------

/**
 * The workflow input. `search_profile_id` is the profile pin (null → three-branch
 * resolution over active rows). `quote_id` selects single-quote mode (audit just
 * that one quote, still against the profile's peer set + incentive slice); null →
 * the recent/unaudited batch over the profile.
 */
export const QuoteAuditInputSchema = z.object({
  /** Explicit profile pin, or null → three-branch resolution over active rows. */
  search_profile_id: z.string().nullable(),
  /** Single-quote target, or null → the recent batch. */
  quote_id: z.string().nullable(),
});
export type QuoteAuditInput = z.infer<typeof QuoteAuditInputSchema>;

/**
 * One audited quote's row in the output — the quote id, its dealer display name,
 * its OTD total (null when the quote carries none), and the firing findings
 * (each already carries its surfaced severity). An empty `flags` array is a
 * CLEAN quote (a valid success — not flagged).
 */
export const QuoteAuditRowSchema = z
  .object({
    quote_id: z.string(),
    dealer_name: z.string(),
    otd_total: z.number().nullable(),
    flags: z.array(AuditFindingSchema),
  })
  .strict();
export type QuoteAuditRow = z.infer<typeof QuoteAuditRowSchema>;

/** The lowest-OTD quote across the audited set (dealer + total), or null when no
 *  audited quote carries an otd_total. */
export const BestOtdSchema = z
  .object({
    dealerName: z.string(),
    otdTotal: z.number(),
  })
  .strict();
export type BestOtd = z.infer<typeof BestOtdSchema>;

/** The severity tally across all audited quotes' findings. */
export const FlagCountsSchema = z
  .object({
    info: z.number().int(),
    warn: z.number().int(),
    block: z.number().int(),
  })
  .strict();
export type FlagCounts = z.infer<typeof FlagCountsSchema>;

/**
 * The workflow output — a SINGLE object (no union, no suspend): the per-quote
 * audit rows plus the header tallies, the profile-resolution provenance, and the
 * deterministic terminal summary. Zero audited quotes is a VALID success
 * (audited: 0) — never an error. NO budget number anywhere.
 */
export const QuoteAuditOutputSchema = z
  .object({
    outcome: z.literal("audited"),
    /** Profile-resolution provenance (pinned vs inferred-newest). */
    resolution: z.enum(["pinned", "inferred_newest"]),
    search_profile_id: z.string(),
    /** Quotes audited this run (the recent batch, or 1 in single-quote mode). */
    audited: z.number().int(),
    /** Quotes with at least one finding. */
    flagged: z.number().int(),
    /** Severity tally across every audited quote's findings. */
    flagCounts: FlagCountsSchema,
    /** The lowest-OTD audited quote, or null. */
    bestOtd: BestOtdSchema.nullable(),
    /** Per-quote audit rows (one per audited quote). */
    perQuote: z.array(QuoteAuditRowSchema),
    /** The deterministic terminal sentence (no budget number anywhere). */
    summary: z.string(),
  })
  .strict();
export type QuoteAuditOutput = z.infer<typeof QuoteAuditOutputSchema>;

// ---------------------------------------------------------------------------
// typed STOP codes (read-only three-branch: 0 active / 2+ active)
// ---------------------------------------------------------------------------

/** The three-branch STOP codes (members of the UI PROFILE_STOP_CODES set). */
export type QuoteAuditStopCode = "no_active_profile" | "multiple_active_profiles";

/** Typed STOP from the resolve step. The message is the user-facing wording —
 *  the server surfaces it verbatim on the run's error frame. */
export class QuoteAuditStopError extends Error {
  readonly code: QuoteAuditStopCode;
  constructor(code: QuoteAuditStopCode, message: string) {
    super(message);
    this.name = "QuoteAuditStopError";
    this.code = code;
  }
}
