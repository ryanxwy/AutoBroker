/**
 * InventoryListing — the flat 11-field shape for one vehicle row extracted
 * from a dealer's search-results page (SRP) by `inventory_site_scan` /
 * `inventory_link_scan`.
 *
 * This is the LLM extraction emit shape (`inventory_extract`, single
 * emit_result tool on DeepSeek — never structured object output mixed with
 * tools; native output_object on Anthropic/OpenAI).
 *
 * Structured-output discipline (mirrors DealerCandidate): flat,
 * all-required-with-explicit-null, enums where possible, lowest common
 * JSON-Schema subset, `.strict()` post-validation. Notes:
 *   - `vin` is UNTRUSTED until the deterministic provenance check in the
 *     tools layer confirms it appears verbatim in the page snapshot; rows
 *     that fail are dropped there, never here.
 *   - `price` is the advertised/listed price on the card. The profile's
 *     budget is NEVER part of this shape — budget never reaches the LLM or
 *     any dealer-facing surface.
 *   - match classification against the profile is deterministic code in the
 *     tools layer; the LLM never judges matches.
 *
 * This file MUST NOT import any framework. Pure types + Zod only.
 */

import { z } from "zod";

/** Closed availability vocabulary; the model maps page wording onto these and
 *  uses "unknown" when the card does not say. */
export const INVENTORY_STATUSES = [
  "in_stock",
  "in_transit",
  "ordered",
  "unknown",
] as const;
export const InventoryStatusSchema = z.enum(INVENTORY_STATUSES);
export type InventoryStatus = z.infer<typeof InventoryStatusSchema>;

export const InventoryListingSchema = z
  .object({
    year: z.number().int().nullable(),
    make: z.string().nullable(),
    model: z.string().nullable(),
    trim: z.string().nullable(),
    /** 17-char VIN as printed on the card, or null — never guessed. */
    vin: z.string().nullable(),
    stock_number: z.string().nullable(),
    /** Advertised price in USD as listed (MSRP or sale price, whichever the
     *  card shows as the price). Null when "Call for price"-style. */
    price: z.number().nullable(),
    exterior_color: z.string().nullable(),
    interior_color: z.string().nullable(),
    inventory_status: InventoryStatusSchema,
    /** The card's own vehicle-detail-page href, or null. */
    listing_url: z.string().nullable(),
  })
  .strict();
export type InventoryListing = z.infer<typeof InventoryListingSchema>;
