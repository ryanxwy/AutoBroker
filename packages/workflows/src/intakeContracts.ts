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
 *   - TrimSuggestionSchema  (intake_trim_lookup): parallel name/summary arrays
 *     extracted from web-fetched trim pages (the freeform trim picker).
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
 * Price/superlative/marketing qualifiers that are NEVER real trim names. When the
 * buyer's prose states only a price intent ("the cheapest CR-V") with no real trim,
 * prefill must leave `trim` NULL so the web-grounded trimSuggestion picker can offer
 * real options — never seed a superlative as if it were a trim. A bogus non-null trim
 * also makes the picker's "no trim yet" guard think a trim is present, suppressing it.
 * Conservative BY CONSTRUCTION: only words that are never trim names. Real trims that
 * happen to read like adjectives (Base, Sport, Premium, Limited, Touring, Premier,
 * Select, Preferred) are deliberately ABSENT here, so a legitimately-typed trim is never
 * nulled. Hard constraint in code, not prompt text (inv #9).
 */
const NON_TRIM_QUALIFIERS = new Set<string>([
  "cheapest", "cheap", "cheaper", "lowest", "lowest price", "lowest priced",
  "lowest-priced", "low price", "least expensive", "most affordable", "affordable",
  "best", "best value", "best price", "best deal", "nicest", "top trim",
  "top of the line", "top-of-the-line", "highest", "most expensive", "priciest",
  "loaded", "fully loaded", "fully-loaded", "maxed out",
]);

/** Literal non-value placeholder strings an LLM sometimes emits INSTEAD of JSON null
 *  (live-observed: DeepSeek returned trim:"null" for "the cheapest CR-V"). Treated as
 *  null so a placeholder neither seeds the form nor suppresses the trimSuggestion picker.
 *  None is a real trim, so this is conservative. */
const NON_VALUE_PLACEHOLDERS = new Set<string>([
  "null", "none", "n/a", "na", "nil", "undecided", "unknown", "unspecified", "any", "tbd", "-",
]);

/**
 * Null out a prefilled trim that is not a real trim name — a price/superlative qualifier
 * ("cheapest") or a non-value placeholder string ("null", "none"). Exact normalized match
 * only (no compound-string stripping): "cheapest" → null, but "cheapest LX" is left intact
 * (a real trim token means the buyer named one).
 */
export function sanitizePrefillTrim(trim: string | null): string | null {
  if (trim === null) return null;
  const norm = trim.trim().toLowerCase();
  if (norm === "") return null;
  if (NON_VALUE_PLACEHOLDERS.has(norm) || NON_TRIM_QUALIFIERS.has(norm)) return null;
  return trim;
}

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
// prompt builders (flat strings; wrapped inline as a user message in harness)
// ---------------------------------------------------------------------------

/** Build the freeform-prefill prompt from the user's launch prose. */
export function buildPrefillPrompt(freeformText: string): string {
  return (
    "Extract the car-buying preferences explicitly stated in the buyer's sentence. " +
    "Fill only fields you actually see; leave everything else null. " +
    "Put a real trim NAME (e.g. LX, EX-L, XLE, Limited) in `trim` only; never a price " +
    "or superlative word like 'cheapest', 'best', or 'loaded' — leave `trim` null for those. " +
    "Never guess email, phone, or budget. Return via the emit_result tool.\n" +
    `Input: ${JSON.stringify(freeformText)}`
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
 * intake_confirm suspend payload. The UNCONDITIONAL end-of-intake buyer
 * confirmation card, rendered between resolveLocation and persist on EVERY path.
 * FLAT {year, make, model, trim} — the resolved vehicle the buyer affirms. PII
 * (email/phone) and budget are DELIBERATELY ABSENT (inv #9): the confirmation card
 * shows only the vehicle. The card is DUMB — display + human-affirm only; it NEVER
 * re-validates the trim with an LLM (a prior LLM trim-verify false-rejected valid
 * trims, so there is no "did you mean" canonicalization here).
 */
export const IntakeConfirmSuspendSchema = z
  .object({
    kind: z.literal("intake_confirm"),
    year: z.number().int(),
    make: z.string(),
    model: z.string(),
    trim: z.string(),
  })
  .strict()
  .describe("Buyer-confirmation card payload (resolved vehicle only; no PII/budget).");

export type IntakeConfirmSuspend = z.infer<typeof IntakeConfirmSuspendSchema>;

/**
 * intake_confirm (the new end-of-intake confirmation, suspend) resume contract.
 *   - accept: affirm the resolved vehicle → continue to persist.
 *   - edit: re-open the collect form to fix the vehicle (the ONE editing surface).
 *   - decline: terminal-declined, zero write (cancel the whole search).
 */
export const IntakeConfirmResumeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept") }),
  z.object({ action: z.literal("edit") }),
  z.object({ action: z.literal("decline") }),
]);
export type IntakeConfirmResume = z.infer<typeof IntakeConfirmResumeSchema>;

/**
 * resolveLocation (suspend ②) resume contract — shared by the ambiguous
 * and the geocode-failure branches (same suspend channel). (The buyer-confirmation
 * suspend ③ is confirmVehicle / intake_confirm.)
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
