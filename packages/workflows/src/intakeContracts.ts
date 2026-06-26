/**
 * intake skill contracts — the Zod schemas + prompt builders the
 * search_profile_intake workflow's LLM steps and suspend/resume points use.
 * These are skill-local, single-use contracts (only searchProfileIntake.ts
 * imports them) deliberately kept out of the shared core layer. The PII-exclusion
 * and all-nullable invariants are enforced here by CONSTRUCTION so the safety
 * property is local and auditable.
 *
 * EMIT SCHEMAS — the two intake useCases:
 *   - IntakePrefillSchema   (intake_freeform_prefill): all-nullable subset
 *     of intake fields, EXCLUDING follow_up_email / follow_up_phone / budget_max
 *     (PII/internal-only fields are NEVER LLM-extracted; the human fills
 *     them in the form). Flat, all-required-with-explicit-null, enum where the
 *     field is an enum. Prefill only SEEDS the form; it never persists.
 *   - TrimVerifyResultSchema (intake_trim_verify): {valid, attestation,
 *     suggested_trims[]}. Flat, all-required, .strict(). suggested_trims is a
 *     possibly-empty array (the key is never absent).
 *
 * RESUME SCHEMAS — discriminated unions keyed on a literal `action`.
 *
 * #1244 / structured-output discipline: both emit schemas are flat, all-required
 * (explicit null over optional), enums where possible — the lowest-common JSON
 * Schema subset DeepSeek tolerates. They are handed to
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
// emit schemas
// ---------------------------------------------------------------------------

/**
 * intake_freeform_prefill emit contract. The all-nullable
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
    "All-nullable intake prefill subset; PII/budget excluded by construction.",
  );

export type IntakePrefill = z.infer<typeof IntakePrefillSchema>;

/**
 * Compile-time proof of PII exclusion: the prefill schema's key set must NOT
 * contain any of the three excluded sensitive fields. If a future edit adds one, this type
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
 * intake_trim_verify emit contract. The trim-verifier's structured
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
  .describe("Trim-verify verdict driving the force-override branch.");

export type TrimVerifyResult = z.infer<typeof TrimVerifyResultSchema>;

/**
 * intake_trim_lookup emit contract. The trim-SUGGESTION extraction over
 * web-fetched trim pages: two PARALLEL string arrays (the i-th name pairs with the
 * i-th summary). Two flat string arrays — not an array of objects — keeps the
 * schema at the DeepSeek-safe lowest common JSON subset (same shape class as
 * suggested_trims), avoiding the nested-object #1244 surface. The summary carries
 * the option-difference one-liner shown in the picker. A length mismatch is
 * tolerated by the caller (zipped to the shorter length).
 */
export const TrimSuggestionSchema = z
  .object({
    trim_names: z.array(z.string()),
    trim_summaries: z.array(z.string()),
  })
  .strict()
  .describe("Web-grounded trim suggestions (parallel name/summary arrays).");

export type TrimSuggestion = z.infer<typeof TrimSuggestionSchema>;

// ---------------------------------------------------------------------------
// prompt builders (flat strings; routed via toModelMessages in harness)
// ---------------------------------------------------------------------------

/** Build the freeform-prefill prompt from the user's launch prose. */
export function buildPrefillPrompt(freeformText: string): string {
  return (
    "Extract the car-buying preferences explicitly stated in the buyer's sentence. " +
    "Fill only fields you actually see; leave everything else null. " +
    "Never guess email, phone, or budget. Return via the emit_result tool.\n" +
    `Input: ${JSON.stringify(freeformText)}`
  );
}

/** Build the trim-verify prompt from the vehicle identity.
 *
 *  This is a best-effort PRE-FILTER, not the authority — the real trim check is
 *  the dealer-inventory cross-check that runs AFTER the search (inventory_compare
 *  grounds the requested trim against trims dealers actually stock). So the prompt
 *  is deliberately CONSERVATIVE: default valid:true and only flag a trim invalid
 *  when highly confident it does not exist for that vehicle. An LLM second-guessing
 *  a current/recent model year from stale training knowledge used to false-reject
 *  real trims (LX, SE, EX-L, XLE…), forcing a needless force-override gate; deferring
 *  to the post-scan ground truth avoids that while still catching an obviously wrong
 *  trim (one from a different make, or one the model never offered). */
export function buildTrimVerifyPrompt(args: {
  year: number;
  make: string;
  model: string;
  trim: string;
}): string {
  return (
    `A buyer is searching for the "${args.trim}" trim of the ${args.year} ${args.make} ` +
    `${args.model}. The authority on which trims exist is the dealer inventory, ` +
    "cross-checked AFTER this search — your job is only to catch an OBVIOUSLY wrong trim " +
    "(e.g. one from a different make, or one this model never offered). " +
    "Default to valid:true, suggested_trims:[]. Return valid:false ONLY if you are highly " +
    "confident the trim does not exist for this vehicle; when unsure (a current or recent " +
    "model year you may not fully know), return valid:true and defer to the post-search " +
    "inventory check. When invalid: attestation explains why, suggested_trims gives 1-3 " +
    "real nearby trims. Return via the emit_result tool."
  );
}

/**
 * Build the trim-suggestion EXTRACTION prompt. GROUNDING is load-bearing (the
 * owner ruling behind the conservative trim-verify): the model must extract ONLY
 * trims that literally appear in the supplied SOURCE TEXT, never invent trims from
 * its own training knowledge — an empty list is the correct answer when the text
 * has none (the step then falls back to manual entry). Multi-body-style models
 * (e.g. Civic sedan vs hatchback) get the body style folded into the trim name so
 * the buyer's pick is unambiguous downstream.
 */
export function buildTrimSuggestionPrompt(args: {
  year: number;
  make: string;
  model: string;
  sourceText: string;
}): string {
  return (
    `Below is SOURCE TEXT gathered from automotive web pages about the ${args.year} ` +
    `${args.make} ${args.model}. Extract the list of TRIM levels it offers.\n` +
    "RULES:\n" +
    "- Extract ONLY trim names that literally appear in the SOURCE TEXT. Do NOT add " +
    "trims from your own knowledge. If the text lists none, return empty arrays.\n" +
    "- Prefer the trims for the requested model year. If the SOURCE TEXT spans " +
    "multiple generations/years (e.g. an encyclopedia history), use the CURRENT " +
    "generation's lineup and ignore discontinued older-generation trims.\n" +
    "- trim_names[i] pairs with trim_summaries[i] (same length, same order).\n" +
    "- Each summary is ONE short line of what distinguishes that trim (engine, key " +
    "features, what you get over the trim below it).\n" +
    "- If the model spans multiple body styles (e.g. Sedan and Hatchback), qualify " +
    'each trim name with its body style (e.g. "Sport (Hatchback)").\n' +
    "- Return at most 8 trims. Return via the emit_result tool.\n\n" +
    `SOURCE TEXT:\n${args.sourceText}`
  );
}

// ---------------------------------------------------------------------------
// resume payload schemas (suspend/resume points)
// ---------------------------------------------------------------------------

/** A partial intake input — the prefill seed and the collect submission share
 *  this shape (every field optional; the form fills the rest). */
export const PartialIntakeSchema = SearchProfileIntakeInputSchema.partial();
export type PartialIntake = z.infer<typeof PartialIntakeSchema>;

/**
 * collect (step 1, suspend ①) resume contract. `submit` carries the full
 * form-shaped fields; decline/cancel are terminal-declined, zero-write.
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
 * and the geocode-failure branches (same suspend channel).
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
 * trimSuggestion (the new pre-collect step, suspend) resume contract.
 *   - pick: the chosen trim index → seeds the form's trim field (web-grounded).
 *   - skip: "enter it myself" → proceed to the form with trim still blank (the
 *     existing manual-entry path; an ACCEPT-style action, NOT decline — decline is
 *     reserved as the terminal-cancel that every suspend step honors zero-write).
 *   - retry: re-run the web lookup, optionally with a refined query.
 *   - decline: terminal-declined, zero write (cancel the whole search).
 */
export const TrimSuggestionResumeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pick"), picked_index: z.number().int() }),
  z.object({ action: z.literal("skip") }),
  z.object({ action: z.literal("retry"), refine_query: z.string().nullable() }),
  z.object({ action: z.literal("decline") }),
]);
export type TrimSuggestionResume = z.infer<typeof TrimSuggestionResumeSchema>;

/**
 * malformed_tool_call (any LLM step, suspend from #1244) resume contract.
 *   - retry_step: re-run the failed LLM step.
 *   - decline: terminal-declined, zero write.
 */
export const MalformedRetryResumeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("retry_step") }),
  z.object({ action: z.literal("decline") }),
]);
export type MalformedRetryResume = z.infer<typeof MalformedRetryResumeSchema>;
