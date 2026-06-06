/**
 * DealerQuote — the structured offer extracted from a dealer reply.
 *
 * STUB: key fields only; TODO markers flag what the full contract still owes.
 *
 * Design rules (structured-output conventions):
 *   - FLAT shape (no nested objects) — lowest common denominator across the
 *     three providers' JSON-Schema subsets.
 *   - Every field REQUIRED with an EXPLICIT `null` for "not present" (never
 *     `.optional()`); this is what makes DeepSeek emit_result + Zod
 *     post-validation deterministic.
 *   - enums over free strings where the value space is closed.
 *   - `.strict()` (extra keys forbidden) so a hallucinated key fails validation
 *     rather than silently passing.
 *   - Cross-field rules (financing_mode discriminant, Rule 1 cross-mode leakage,
 *     Rule 2 mode-required fields, ±$1 math reconciliation) are enforced in the
 *     `tools`/`calc` layer as POST-validation, NOT encoded as JSON-Schema the
 *     model sees. Populated by the deterministic calc skills (phase 1) and the
 *     dealer-reply extraction skill (phase 3).
 *
 * This file MUST NOT import any framework. Pure types + Zod only.
 */

import { z } from "zod";

/**
 * Which financing world the numbers live in. Drives Rule 1 (no cross-mode
 * field leakage) and Rule 2 (mode-required fields) — both enforced as
 * post-validation in calc, not here.
 */
export const FinancingModeSchema = z.enum(["cash", "finance", "lease"]);
export type FinancingMode = z.infer<typeof FinancingModeSchema>;

export const DealerQuoteSchema = z
  .object({
    // --- identity / provenance ----------------------------------------------
    /** FK to the search profile this quote was extracted under (TEXT PK per
     *  the introspected oracle — lockstep with SearchProfile.id). */
    search_profile_id: z.string().describe("Owning search profile id."),
    /** Gmail message id the figures were extracted from (provenance). */
    gmail_message_id: z.string().nullable(),
    /** Dealer the quote is from (display name as it appeared; untrusted input). */
    dealer_name: z.string(),
    vin: z.string().nullable().describe("17-char VIN if quoted; else null."),

    // --- discriminant --------------------------------------------------------
    financing_mode: FinancingModeSchema,

    // --- money (cents as integers to dodge float drift; ±$1 reconciled in calc)
    /** Out-the-door price in cents; the canonical sort/compare key. */
    otd_price_cents: z.number().int().nonnegative().nullable(),
    /** Quoted selling price before fees/taxes, in cents. */
    selling_price_cents: z.number().int().nonnegative().nullable(),
    /** Doc fee in cents (capped per state — STATE_DOC_FEE_CAP, audited in calc). */
    doc_fee_cents: z.number().int().nonnegative().nullable(),

    // TODO: full money surface — taxes_cents, total_fees_cents, rebates/incentives,
    //       finance: apr_bps + term_months + monthly_payment_cents + down_cents,
    //       lease: monthly_payment_cents + due_at_signing_cents + money_factor +
    //              residual_pct + mileage_allowance. All flat, required, explicit null,
    //       with Rule 1/Rule 2 enforced as post-validation in calc.
    // TODO: currency (assume USD for new-car US market; encode as enum when needed).
  })
  .strict()
  .describe("Flat, required-with-null dealer offer; extra keys forbidden.");

export type DealerQuote = z.infer<typeof DealerQuoteSchema>;
