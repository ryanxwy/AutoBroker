/**
 * intake skill contracts — the Zod schemas + prompt builders the
 * search_profile_intake workflow's LLM steps and suspend/resume points use.
 *
 * PLACEMENT (justify): these are SKILL-LOCAL, single-use contracts whose only
 * consumer is searchProfileIntake.ts (this layer). The LLD §4 sketches the emit
 * schemas and §5.2 sketches the resume schemas under packages/core, but per the
 * five-layer rule core is the *shared* contract surface — widening it for a
 * skill-private schema set that nothing else imports adds cross-layer coupling
 * for no reuse. Co-locating them with the workflow keeps the skill self-contained
 * (CLAUDE.md "no abstractions for single-use code"). The PII-exclusion and
 * all-nullable invariants (D-AI-3) are enforced here by CONSTRUCTION, not derived
 * from core, so the safety property is local and auditable.
 *
 * EMIT SCHEMAS — the two intake useCases (AI_ORCH §4):
 *   - IntakePrefillSchema   (intake_freeform_prefill, §4.1): all-nullable subset
 *     of intake fields, EXCLUDING follow_up_email / follow_up_phone / budget_max
 *     (D-AI-3 — PII/internal-only fields are NEVER LLM-extracted; the human fills
 *     them in the form). Flat, all-required-with-explicit-null, enum where the
 *     field is an enum. Prefill only SEEDS the form; it never persists.
 *   - TrimVerifyResultSchema (intake_trim_verify, §4.2): {valid, attestation,
 *     suggested_trims[]}. Flat, all-required, .strict(). suggested_trims is a
 *     possibly-empty array (the key is never absent). The LLD §4.2 names the
 *     fields valid / attestation / suggested_trims (the task brief's "reason"
 *     maps to `attestation`); the LLD field names are authoritative here.
 *
 * RESUME SCHEMAS — discriminated unions on `action` (task BUILD spec). The LLD
 * §5.2 sketches flat {action, content?} / {forced, chosen_trim?} shapes; the task
 * BUILD spec pins discriminated unions keyed on a literal `action`, which is the
 * implementation contract this workflow honors (delta recorded in api_findings).
 *
 * #1244 / structured-output discipline: both emit schemas are flat, all-required
 * (explicit null over optional), enums where possible — the lowest-common JSON
 * Schema subset DeepSeek tolerates (CLAUDE.md §5). They are handed to
 * harness.generate as the single emit_result contract; never mixed with other
 * tools.
 *
 * Dependency wall: imports @autobroker/core (the intake field enums) + zod only.
 */

import { z } from "zod";
import {
  FinancingPreferenceSchema,
  SearchProfileIntakeInputSchema,
} from "@autobroker/core";

// ---------------------------------------------------------------------------
// emit schemas (AI_ORCH §4)
// ---------------------------------------------------------------------------

/**
 * intake_freeform_prefill emit contract (AI_ORCH §4.1, D-AI-3). The all-nullable
 * subset of intake fields the prefill extraction pass may fill from a user's
 * one-liner. follow_up_email / follow_up_phone / budget_max are DELIBERATELY
 * ABSENT (PII / internal-only): the model never extracts them — the human types
 * them in the form. Every key is required-with-explicit-null (DeepSeek-safe LCD).
 */
export const IntakePrefillSchema = z
  .object({
    make: z.string().nullable(),
    model: z.string().nullable(),
    year: z.number().int().nullable(),
    trim: z.string().nullable(),
    location_query: z.string().nullable(),
    search_radius_miles: z.number().int().nullable(),
    financing_preference: FinancingPreferenceSchema.nullable(),
  })
  .strict()
  .describe(
    "All-nullable intake prefill subset; PII/budget excluded by construction (D-AI-3).",
  );

export type IntakePrefill = z.infer<typeof IntakePrefillSchema>;

/**
 * Compile-time proof of D-AI-3: the prefill schema's key set must NOT contain any
 * of the three excluded sensitive fields. If a future edit adds one, this type
 * fails to compile (never `2` from the conditional). Belt for the runtime test
 * that asserts the same.
 */
type _PrefillExcludesSensitive = "follow_up_email" extends keyof IntakePrefill
  ? 1
  : "follow_up_phone" extends keyof IntakePrefill
    ? 1
    : "budget_max" extends keyof IntakePrefill
      ? 1
      : 2;
const _PREFILL_PII_EXCLUDED: _PrefillExcludesSensitive = 2;
void _PREFILL_PII_EXCLUDED;

/**
 * intake_trim_verify emit contract (AI_ORCH §4.2). The trim-verifier's structured
 * verdict. `valid` = trim truly exists for the make/model/year; `attestation` =
 * one-line plain-speak reason shown to the user; `suggested_trims` = real-ish
 * alternatives when invalid (possibly empty, never an absent key).
 */
export const TrimVerifyResultSchema = z
  .object({
    valid: z.boolean(),
    attestation: z.string(),
    suggested_trims: z.array(z.string()),
  })
  .strict()
  .describe("Trim-verify verdict driving the force-override branch (AI_ORCH §4.2).");

export type TrimVerifyResult = z.infer<typeof TrimVerifyResultSchema>;

// ---------------------------------------------------------------------------
// prompt builders (flat strings at M0/M1; routed via toModelMessages in harness)
// ---------------------------------------------------------------------------

/** Build the freeform-prefill prompt from the user's launch prose (AI_ORCH §4.1). */
export function buildPrefillPrompt(freeformText: string): string {
  return (
    "Extract the car-buying preferences explicitly stated in the buyer's sentence. " +
    "Fill only fields you actually see; leave everything else null. " +
    "Never guess email, phone, or budget. Return via the emit_result tool.\n" +
    `Input: ${JSON.stringify(freeformText)}`
  );
}

/** Build the trim-verify prompt from the vehicle identity (AI_ORCH §4.2). */
export function buildTrimVerifyPrompt(args: {
  year: number;
  make: string;
  model: string;
  trim: string;
}): string {
  return (
    `Verify whether the ${args.year} ${args.make} ${args.model} truly offers the ` +
    `"${args.trim}" trim. ` +
    "If it does -> valid:true, suggested_trims:[]. " +
    "If it does not -> valid:false, attestation explains why, suggested_trims gives " +
    "1-3 real nearby trims. Return via the emit_result tool."
  );
}

// ---------------------------------------------------------------------------
// resume payload schemas (suspend/resume points; task BUILD spec shapes)
// ---------------------------------------------------------------------------

/** A partial intake input — the prefill seed and the collect submission share
 *  this shape (every field optional; the form fills the rest). */
export const PartialIntakeSchema = SearchProfileIntakeInputSchema.partial();
export type PartialIntake = z.infer<typeof PartialIntakeSchema>;

/**
 * collect (step 1, suspend ①) resume contract. `submit` carries the full
 * form-shaped fields; decline/cancel are terminal-declined, zero-write (D-AI-4).
 */
export const CollectResumeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit"), fields: PartialIntakeSchema }),
  z.object({ action: z.literal("decline") }),
  z.object({ action: z.literal("cancel") }),
]);
export type CollectResume = z.infer<typeof CollectResumeSchema>;

/**
 * forceOverrideGate (step 4, suspend ②) resume contract. The gate can suspend two
 * ways — the force_override approval card OR a malformed_tool_call (when the
 * `revise` re-verify itself trips #1244) — so this union folds both resume paths
 * into one schema (single `decline` member keeps the discriminated union valid).
 *   - force_override: keep the invalid trim; `reason` is REQUIRED (audited).
 *   - revise: change the trim (or clear it) and re-verify once.
 *   - retry_step: re-run after a malformed-tool-call suspend on the revise path.
 *   - decline: terminal-declined, zero write.
 */
export const ForceOverrideResumeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("force_override"), reason: z.string().min(1) }),
  z.object({ action: z.literal("revise"), trim: z.string().nullable() }),
  z.object({ action: z.literal("retry_step") }),
  z.object({ action: z.literal("decline") }),
]);
export type ForceOverrideResume = z.infer<typeof ForceOverrideResumeSchema>;

/**
 * resolveLocation (step 5, suspend ③) resume contract — shared by the ambiguous
 * and the 裁定⑨ geocode-failure branches (same suspend channel).
 *   - pick: the chosen candidate index (ambiguous branch).
 *   - retry: a better query string → re-resolve (bounded by the human round-trip).
 *   - decline: terminal-declined, zero write.
 */
export const AmbiguousLocationResumeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pick"), picked_index: z.number().int() }),
  z.object({ action: z.literal("retry"), retry_query: z.string().min(1) }),
  z.object({ action: z.literal("decline") }),
]);
export type AmbiguousLocationResume = z.infer<typeof AmbiguousLocationResumeSchema>;

/**
 * malformed_tool_call (any LLM step, suspend from #1244, D-AI-5) resume contract.
 *   - retry_step: re-run the failed LLM step.
 *   - decline: terminal-declined, zero write.
 */
export const MalformedRetryResumeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("retry_step") }),
  z.object({ action: z.literal("decline") }),
]);
export type MalformedRetryResume = z.infer<typeof MalformedRetryResumeSchema>;
