/**
 * Incentive — the flat 4-field shape for one manufacturer incentive row
 * extracted from a rendered OEM/dealer offers page by `incentive_scrape`.
 *
 * This is the LLM extraction emit shape (`incentive_extract`, single
 * emit_result tool on DeepSeek — never structured object output mixed with
 * tools; native output_object on providers that support both).
 *
 * Structured-output discipline (mirrors InventoryListing): flat,
 * all-required-with-explicit-null, enums where possible, lowest common
 * JSON-Schema subset, `.strict()` post-validation. Notes:
 *   - `type` includes "other" so the model has an honest bucket for offers
 *     that are not one of the five cash classes; the CASH-TYPE WHITELIST that
 *     drops non-cash rows is deterministic tools-layer code — the LLM never
 *     sees or enforces that gate, and "other" rows are dropped + counted
 *     there, never here.
 *   - `expires` carries an explicit date ONLY when the offer card shows one
 *     inline. A card with no inline expiration leaves expires null rather
 *     than inferring one from page footer / legal copy.
 *   - `amount` is the offer's dollar amount (>= 0). The buyer's budget is
 *     NEVER part of this shape — budget never reaches the LLM or any
 *     dealer-facing surface.
 *   - `scraped_at` / `scrape_source_url` are NOT here: the persist layer adds
 *     them — they are run provenance, never an LLM product.
 *
 * This file MUST NOT import any framework. Pure types + Zod only.
 */

import { z } from "zod";

/** Closed incentive-type vocabulary. The five cash classes plus "other" (the
 *  model's honest bucket for APR / lease-pricing / deferral offers — dropped
 *  by the deterministic tools-layer whitelist, never persisted). */
export const INCENTIVE_TYPES = [
  "customer_cash",
  "loyalty",
  "military",
  "conquest",
  "lease_cash",
  "other",
] as const;
export const IncentiveTypeSchema = z.enum(INCENTIVE_TYPES);
export type IncentiveType = z.infer<typeof IncentiveTypeSchema>;

/** Closed eligibility vocabulary — aligned with the downstream quote-audit
 *  missing-rebate matcher's profile eligibility kinds. */
export const INCENTIVE_ELIGIBILITIES = [
  "all",
  "current_brand_owner",
  "military_first_responder",
  "lease_only",
  "other",
] as const;
export const IncentiveEligibilitySchema = z.enum(INCENTIVE_ELIGIBILITIES);
export type IncentiveEligibility = z.infer<typeof IncentiveEligibilitySchema>;

export const IncentiveSchema = z
  .object({
    type: IncentiveTypeSchema,
    /** Offer dollar amount; never negative. */
    amount: z.number().min(0),
    /** "YYYY-MM-DD" copied from an INLINE expiration on the offer card, or
     *  null. Never inferred from page footer / legal copy. */
    expires: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "expires must be YYYY-MM-DD")
      .nullable(),
    eligibility: IncentiveEligibilitySchema,
  })
  .strict();
export type Incentive = z.infer<typeof IncentiveSchema>;

/**
 * One brand's row in the cross-run "already approved" OEM source registry
 * file (`<data dir>/incentive_sources.toml`, brand-keyed). The registry is
 * the durable memory behind the first-encounter approval: a brand with an
 * entry never re-asks. The file lives in the data directory (NOT the product
 * DB — the product schema is frozen); the tools layer owns reading/writing
 * it, this schema is the row contract both sides validate against.
 */
export const IncentiveSourceRegistryEntrySchema = z
  .object({
    /** Offers-page URL template; may carry {zip} / {model} placeholders that
     *  are substituted per scrape target (the substituted URL is re-validated
     *  before any navigation). */
    url_template: z.string().min(1),
    /** ISO timestamp of the approval that created the entry. */
    added_at: z.string().min(1),
    /** The search_profile_id whose run first approved this brand's source. */
    added_for_profile: z.string().min(1),
  })
  .strict();
export type IncentiveSourceRegistryEntry = z.infer<
  typeof IncentiveSourceRegistryEntrySchema
>;
