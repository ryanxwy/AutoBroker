/**
 * AuditFlag — a single deterministic finding from the quote audit.
 *
 * STUB: the flag envelope + a starter set of codes; TODO for the full
 * 10-check catalog ported from the legacy `audit_quote` (Phase 1, quote_audit★).
 *
 * Critical property: audit flags are produced by PURE FUNCTIONS in the calc
 * layer (validate_offer_math ±$1, STATE_DOC_FEE_CAP, etc.), NOT by the LLM.
 * The model only renders a headline from already-computed flags. So this schema
 * is the L1 (zero-LLM) contract the unit tests assert against case-by-case.
 *
 * This file MUST NOT import any framework. Pure types + Zod only.
 */

import { z } from "zod";

/**
 * Stable machine codes for audit findings. The harness `table_min_rows` /
 * narrative anchors and the L1 unit tests key off these exact strings.
 */
export const AuditFlagCodeSchema = z.enum([
  /** Out-the-door total does not reconcile with components within ±$1. */
  "math_mismatch",
  /** Doc fee exceeds the state cap (STATE_DOC_FEE_CAP). */
  "doc_fee_over_cap",
  /** A field belonging to another financing_mode leaked in (Rule 1). */
  "cross_mode_leakage",
  /** A field required for the declared financing_mode is missing (Rule 2). */
  "missing_required_field",
  // TODO: complete the 10-check catalog — e.g. add-on padding, phantom fees,
  //       below-invoice sanity, incentive double-count, OTD-vs-selling delta,
  //       tax-rate plausibility. Each gets a pure check + an L1 test case.
]);
export type AuditFlagCode = z.infer<typeof AuditFlagCodeSchema>;

/** Severity drives surfacing/ordering, not gating; gating is structural. */
export const AuditSeveritySchema = z.enum(["info", "warn", "error"]);
export type AuditSeverity = z.infer<typeof AuditSeveritySchema>;

export const AuditFlagSchema = z
  .object({
    code: AuditFlagCodeSchema,
    severity: AuditSeveritySchema,
    /** Human-readable explanation (deterministically composed, not LLM prose). */
    message: z.string(),
    /** The DealerQuote field this flag is about, or null if cross-field. */
    field: z.string().nullable(),
    /** Expected value in cents (or null when not a numeric check). */
    expected_cents: z.number().int().nullable(),
    /** Observed value in cents (or null when not a numeric check). */
    observed_cents: z.number().int().nullable(),
    // TODO: add `state` (for doc-fee cap context) and `check_version` so a flag
    //       can be reproduced against the exact rule table that produced it.
  })
  .strict()
  .describe("One deterministic, code-stable audit finding (computed in calc).");

export type AuditFlag = z.infer<typeof AuditFlagSchema>;
