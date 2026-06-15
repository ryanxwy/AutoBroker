/**
 * AuditFinding — a single deterministic finding from the quote audit.
 *
 * Critical property: audit findings are produced by PURE FUNCTIONS in the calc
 * layer (validate_offer_math ±$1, STATE_DOC_FEE_CAP, etc.), NOT by the LLM.
 * The model only renders a headline from already-computed findings. So this
 * schema is the L1 (zero-LLM) contract the unit tests assert against case-by-case.
 *
 * This file MUST NOT import any framework. Pure types + Zod only.
 */

import { z } from "zod";

/**
 * AuditFinding — the deterministic finding shape emitted by the 10-check quote
 * audit. One firing check → one finding.
 *
 * `code` is a PLAIN STRING, not a closed enum: most codes are a fixed UPPERCASE
 * set (MATH_SANITY, DOC_FEE_CAP, …) but add-on findings carry a dynamic
 * `ADD_ON_<NAME>` suffix, so the code space is open. Severity is the surfaced
 * bucket ("info" | "warn" | "block"). `suggestion` is always a concrete,
 * non-empty next step.
 */
export const AuditFindingSchema = z.object({
  /** Stable identifier — UPPERCASE fixed set or dynamic `ADD_ON_<NAME>`. */
  code: z.string(),
  /** Surfaced severity bucket. */
  severity: z.enum(["info", "warn", "block"]),
  /** What fired, user-facing. No trailing period convention from the checks. */
  text: z.string(),
  /** Concrete next step — always non-empty. */
  suggestion: z.string(),
});
export type AuditFinding = z.infer<typeof AuditFindingSchema>;
