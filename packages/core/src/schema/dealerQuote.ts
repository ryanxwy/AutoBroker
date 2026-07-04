/**
 * DealerQuote — the structured offer extracted from a dealer reply.
 *
 * Two shapes share one set of cross-field rules:
 *   - `DealerReplyQuoteRowSchema` — the LLM-EMITTED extractable row. It carries
 *     only the fields a model can read off a reply (prices, fees, financing
 *     terms, the discriminant). It EXCLUDES every provenance/identity field the
 *     model cannot know (the quote id, dealer id, message ids, the owning
 *     profile, who/how/when it was extracted, the raw blob). Its
 *     `DealerReplyQuoteRowLooseSchema` variant is the same shape WITHOUT the
 *     cross-field refinement — the emit-boundary schema (JSON-Schema conversion
 *     drops refinements, so the boundary must match what the model was shown).
 *   - `DealerQuoteSchema` — the full PERSISTED row = the extractable shape PLUS
 *     the provenance/identity columns. It maps 1:1 onto the `dealer_quotes`
 *     table by column name.
 *
 * Design rules (structured-output conventions):
 *   - FLAT shape (no nested objects) — lowest common denominator across the
 *     three providers' JSON-Schema subsets.
 *   - Every extractable field is REQUIRED with an EXPLICIT `null` for "not
 *     present" (never `.optional()`); this is what makes DeepSeek emit_result +
 *     Zod post-validation deterministic.
 *   - enums over free strings where the value space is closed.
 *   - `.strict()` (extra keys forbidden) so a hallucinated key fails validation
 *     rather than silently passing.
 *   - MONEY IS FLOAT-DOLLARS (matching the `real` columns of the table); there
 *     is no cents convention.
 *
 * Cross-field rules (enforced as POST-validation via a shared `superRefine`, NOT
 * encoded as JSON-Schema the model sees):
 *   - Rule 1 (no cross-financing-mode field leakage): `cash` rejects any finance
 *     AND any lease field; `finance` rejects lease fields; `lease` rejects
 *     finance fields; `unspecified` rejects both blocks.
 *   - Rule 2 (mode-required fields): `finance` requires apr + term; `lease`
 *     requires term + (money_factor OR residual_pct).
 * A Rule 2 failure can be escaped via `reclassifyRule2Failures` (reclass to
 * `unspecified`, nulling the partial blocks) BEFORE validation; a Rule 1 bleed
 * is a genuine model error and always fails.
 *
 * This file MUST NOT import any framework. Pure types + Zod only.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Which financing world the numbers live in. Drives Rule 1 (no cross-mode field
 * leakage) and Rule 2 (mode-required fields). `unspecified` is the escape hatch
 * for ambiguous extractions and the reclass target when Rule 2 fields are
 * missing — it expects both the finance and lease blocks empty.
 */
export const FinancingModeSchema = z.enum(["cash", "finance", "lease", "unspecified"]);
export type FinancingMode = z.infer<typeof FinancingModeSchema>;

/** The medium the quote arrived in. `mixed` covers a reply spanning several. */
export const QuoteFormatSchema = z.enum(["pdf", "image", "text", "mixed"]);
export type QuoteFormat = z.infer<typeof QuoteFormatSchema>;

/** What the dealer's message is doing — a real number, a counter, a stall, a
 *  come-in nudge, or an automated reply. */
export const IntentSchema = z.enum(["real_quote", "counter", "stall", "come_in", "auto_reply"]);
export type Intent = z.infer<typeof IntentSchema>;

/** Which provider's model produced the extraction (provenance, never the price
 *  medium — orthogonal to ExtractionMethod). */
export const ExtractorProviderSchema = z.enum(["deepseek", "anthropic", "openai"]);
export type ExtractorProvider = z.infer<typeof ExtractorProviderSchema>;

/** How the source text reached the model — native vision, on-device OCR, or a
 *  plain text layer (orthogonal to ExtractorProvider; never collapsed). */
export const ExtractionMethodSchema = z.enum(["vision", "ocr", "text"]);
export type ExtractionMethod = z.infer<typeof ExtractionMethodSchema>;

// ---------------------------------------------------------------------------
// JSON-array element shapes (kept shallow per the structured-output discipline)
// ---------------------------------------------------------------------------

/**
 * One named-money line. The four JSON-array fields (`rebates_json`,
 * `other_fees_json`, `add_ons_json`, `taxable_rebates_json`) emit as arrays of
 * this flat 2-field object — the persist layer JSON.stringify's them into the
 * TEXT columns. Arrays are chosen over a free string so the model emits
 * structured, machine-readable line items (each a label + a float-dollar
 * amount) while the nesting stays exactly one level deep — well inside the
 * lowest-common JSON-Schema subset.
 */
export const MoneyLineSchema = z
  .object({
    label: z.string(),
    amount: z.number().nullable(),
  })
  .strict();
export type MoneyLine = z.infer<typeof MoneyLineSchema>;

// ---------------------------------------------------------------------------
// The shared field group (the extractable fields, sans identity/provenance)
// ---------------------------------------------------------------------------

/** The finance-block field names (Rule 1 forbids them outside `finance`). */
const FINANCE_FIELDS = [
  "finance_apr",
  "finance_term_months",
  "finance_down_payment",
  "finance_monthly_payment",
  "finance_amount_financed",
] as const;

/** The lease-block field names (Rule 1 forbids them outside `lease`). */
const LEASE_FIELDS = [
  "lease_term_months",
  "lease_money_factor",
  "lease_residual_pct",
  "lease_residual_value",
  "lease_due_at_signing",
  "lease_monthly_payment",
  "lease_miles_per_year",
  "lease_acquisition_fee",
  "lease_disposition_fee",
  "lease_cap_cost_gross",
  "lease_cap_cost_adjusted",
  "lease_rent_charge",
] as const;

/** Float-dollar money field (the table's `real` columns). */
const money = () => z.number().nullable();

/**
 * The extractable shape — the fields the LLM emits. Identity/provenance columns
 * are intentionally absent (the model cannot know them). The discriminant is
 * non-null; everything else is required-with-explicit-null.
 */
const replyQuoteRowShape = {
  // --- discriminant --------------------------------------------------------
  financing_mode: FinancingModeSchema,

  // --- vehicle / listing ---------------------------------------------------
  vin: z.string().nullable(),
  inventory_status: z.string().nullable(),
  source_listing_id: z.string().nullable(),

  // --- meta ----------------------------------------------------------------
  quote_format: QuoteFormatSchema.nullable(),
  intent: IntentSchema.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  quote_received_at: z.string().nullable(),
  quote_expires_at: z.string().nullable(),

  // --- common money (float dollars) ----------------------------------------
  msrp: money(),
  selling_price: money(),
  dealer_discount: money(),
  doc_fee: money(),
  dealer_fee: money(),
  sales_tax: money(),
  dmv_fees: money(),
  title_fee: money(),
  registration_fee: money(),
  license_fee: money(),
  otd_total: money(),

  // --- JSON-array money lines ----------------------------------------------
  rebates_json: z.array(MoneyLineSchema).nullable(),
  other_fees_json: z.array(MoneyLineSchema).nullable(),
  add_ons_json: z.array(MoneyLineSchema).nullable(),
  taxable_rebates_json: z.array(MoneyLineSchema).nullable(),

  // --- finance block (Rule 1: forbidden unless mode=finance) ---------------
  finance_apr: z.number().nullable(),
  finance_term_months: z.number().int().nullable(),
  finance_down_payment: money(),
  finance_monthly_payment: money(),
  finance_amount_financed: money(),

  // --- lease block (Rule 1: forbidden unless mode=lease) -------------------
  lease_term_months: z.number().int().nullable(),
  lease_money_factor: z.number().nullable(),
  lease_residual_pct: z.number().nullable(),
  lease_residual_value: money(),
  lease_due_at_signing: money(),
  lease_monthly_payment: money(),
  lease_miles_per_year: z.number().int().nullable(),
  lease_acquisition_fee: money(),
  lease_disposition_fee: money(),
  lease_cap_cost_gross: money(),
  lease_cap_cost_adjusted: money(),
  lease_rent_charge: money(),
} as const;

// ---------------------------------------------------------------------------
// Rule 1 + Rule 2 — the shared superRefine (operates on the fields above)
// ---------------------------------------------------------------------------

/** The subset of a row the cross-field rules read (finance/lease + mode). Both
 *  schemas extend this, so one refiner serves both. */
type RuleFields = {
  financing_mode: FinancingMode;
  finance_apr: number | null;
  finance_term_months: number | null;
  finance_down_payment: number | null;
  finance_monthly_payment: number | null;
  finance_amount_financed: number | null;
  lease_term_months: number | null;
  lease_money_factor: number | null;
  lease_residual_pct: number | null;
  lease_residual_value: number | null;
  lease_due_at_signing: number | null;
  lease_monthly_payment: number | null;
  lease_miles_per_year: number | null;
  lease_acquisition_fee: number | null;
  lease_disposition_fee: number | null;
  lease_cap_cost_gross: number | null;
  lease_cap_cost_adjusted: number | null;
  lease_rent_charge: number | null;
};

/**
 * The shared Rule 1 + Rule 2 enforcement, applied to both schemas.
 *
 * Rule 1 — no cross-mode field leakage:
 *   cash → both blocks null; finance → lease null; lease → finance null;
 *   unspecified → both blocks null.
 * Rule 2 — mode-required fields:
 *   finance requires finance_apr AND finance_term_months;
 *   lease requires lease_term_months AND (lease_money_factor OR
 *   lease_residual_pct).
 * A violation is a Zod issue (reject). Rule 2 has a deterministic escape hatch
 * — `reclassifyRule2Failures` — applied BEFORE validation, not here.
 */
function refineModeContract(row: RuleFields, ctx: z.RefinementCtx): void {
  const mode = row.financing_mode;

  // Rule 1.
  if (mode === "cash" || mode === "unspecified") {
    for (const f of FINANCE_FIELDS) {
      if (row[f] != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [f],
          message: `${f} must be null when financing_mode is ${mode}`,
        });
      }
    }
    for (const f of LEASE_FIELDS) {
      if (row[f] != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [f],
          message: `${f} must be null when financing_mode is ${mode}`,
        });
      }
    }
  } else if (mode === "finance") {
    for (const f of LEASE_FIELDS) {
      if (row[f] != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [f],
          message: `${f} must be null when financing_mode is finance`,
        });
      }
    }
    // Rule 2 (finance).
    if (row.finance_apr == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finance_apr"],
        message: "finance_apr is required when financing_mode is finance",
      });
    }
    if (row.finance_term_months == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finance_term_months"],
        message: "finance_term_months is required when financing_mode is finance",
      });
    }
  } else {
    // mode === "lease".
    for (const f of FINANCE_FIELDS) {
      if (row[f] != null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [f],
          message: `${f} must be null when financing_mode is lease`,
        });
      }
    }
    // Rule 2 (lease).
    if (row.lease_term_months == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lease_term_months"],
        message: "lease_term_months is required when financing_mode is lease",
      });
    }
    if (row.lease_money_factor == null && row.lease_residual_pct == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lease_money_factor"],
        message:
          "lease requires lease_money_factor OR lease_residual_pct when financing_mode is lease",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// The two schemas
// ---------------------------------------------------------------------------

/**
 * The STRUCTURAL extractable row — flat, required-with-explicit-null, strict,
 * WITHOUT the Rule 1/Rule 2 refinement. This is the shape the model-facing
 * boundary validates against: JSON-Schema conversion drops refinements, so a
 * refined emit boundary would reject faithful emits the model was never told
 * were invalid. Rule 2 gaps are demoted deterministically by
 * `reclassifyRule2Failures` AFTER emit; the refined schemas below re-enforce
 * both rules before persist.
 */
export const DealerReplyQuoteRowLooseSchema = z
  .object(replyQuoteRowShape)
  .strict()
  .describe("Flat extractable dealer-quote row (no provenance); structural only.");

/**
 * The LLM-emitted extractable row — the loose shape plus Rule 1/Rule 2 enforced
 * post-validation. Identity/provenance is NOT here: the model never sees nor
 * invents it.
 */
export const DealerReplyQuoteRowSchema = DealerReplyQuoteRowLooseSchema
  .superRefine(refineModeContract)
  .describe("Flat extractable dealer-quote row (no provenance); Rule1/Rule2 enforced.");
export type DealerReplyQuoteRow = z.infer<typeof DealerReplyQuoteRowSchema>;

/**
 * The full persisted row = the extractable shape EXTENDED with the NOT-NULL
 * identity/provenance columns + the nullable extraction-provenance columns.
 * Maps 1:1 onto the `dealer_quotes` table by column name.
 */
export const DealerQuoteSchema = z
  .object({
    // --- identity (NOT NULL) -------------------------------------------------
    quote_id: z.string(),
    dealer_id: z.string(),
    message_id: z.string(),
    source_gmail_message_id: z.string(),
    search_profile_id: z.string(),

    // --- the extractable fields ---------------------------------------------
    ...replyQuoteRowShape,

    // --- extraction provenance (nullable) -----------------------------------
    extractor_provider: ExtractorProviderSchema.nullable(),
    extraction_method: ExtractionMethodSchema.nullable(),
    extracted_at: z.string().nullable(),
    raw_source_blob: z.string().nullable(),
  })
  .strict()
  .superRefine(refineModeContract)
  .describe("Full persisted dealer quote (identity + provenance + extractable).");
export type DealerQuote = z.infer<typeof DealerQuoteSchema>;

// ---------------------------------------------------------------------------
// Rule 2 escape hatch
// ---------------------------------------------------------------------------

/**
 * Reclass a Rule-2-failing `finance`/`lease` row to `unspecified`, BEFORE
 * validation. A finance row missing apr or term, or a lease row missing term or
 * both of (money_factor, residual_pct), cannot satisfy Rule 2 — rather than
 * hard-rejecting an ambiguous extraction, demote it to `unspecified` and NULL
 * both the finance and lease blocks (so the reclassed row then satisfies Rule
 * 1's "unspecified → both blocks empty"). Pure: returns a NEW object, never
 * mutates the input.
 *
 * Rows that already satisfy Rule 2 (or are `cash`/`unspecified`) pass through
 * unchanged. Rule 1 cross-mode BLEED is NOT reclassed here — it is a genuine
 * model error that must fail validation.
 *
 * Accepts the loose extractable shape (pre-validation, so partial/raw) and
 * returns it with the same field set.
 */
export function reclassifyRule2Failures<T extends RuleFields>(row: T): T {
  const mode = row.financing_mode;

  const financeFails =
    mode === "finance" && (row.finance_apr == null || row.finance_term_months == null);
  const leaseFails =
    mode === "lease" &&
    (row.lease_term_months == null ||
      (row.lease_money_factor == null && row.lease_residual_pct == null));

  if (!financeFails && !leaseFails) return row;

  const nulled = { ...row, financing_mode: "unspecified" } as T;
  for (const f of FINANCE_FIELDS) (nulled as Record<string, unknown>)[f] = null;
  for (const f of LEASE_FIELDS) (nulled as Record<string, unknown>)[f] = null;
  return nulled;
}
