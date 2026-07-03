/**
 * AggregatorListing — the flat 13-field shape for one vehicle listing extracted
 * from a new-car AGGREGATOR shopping-site search page (Cars.com, Edmunds) by
 * `inventory_aggregator_scan`, the read-only sibling of `inventory_site_scan`.
 *
 * This is the LLM extraction emit shape (single `emit_result` tool on DeepSeek —
 * never structured object output mixed with tools; native output_object on
 * Anthropic/OpenAI). Structured-output discipline (mirrors InventoryListing):
 * flat, all-required-with-explicit-null, the closed availability enum, lowest
 * common JSON-Schema subset, `.strict()` post-validation. Notes:
 *   - `vin` / `dealer_name` / `listing_url` are UNTRUSTED until the deterministic
 *     provenance checks in the workflow confirm them verbatim in the page
 *     snapshot; rows that fail are dropped there, never here.
 *   - `price` and `msrp` are the figures shown on the shopping-site tile. The
 *     profile's budget is NEVER part of this shape — budget never reaches the
 *     LLM or any surface.
 *   - `distance_miles` is the tile's own distance-from-you reading; the radius
 *     comparison is deterministic code in the workflow, not the LLM.
 *   - match classification against the profile is deterministic code; the LLM
 *     never judges matches.
 *
 * This file MUST NOT import any framework. Pure types + Zod only.
 */

import { z } from "zod";

import { InventoryStatusSchema } from "./inventoryListing.js";

export const AggregatorListingSchema = z
  .object({
    /** 17-char VIN as printed in the tile/blob, or null — never guessed. */
    vin: z.string().nullable(),
    year: z.number().int().nullable(),
    make: z.string().nullable(),
    model: z.string().nullable(),
    trim: z.string().nullable(),
    exterior_color: z.string().nullable(),
    /** Advertised selling price in USD as shown on the tile. Null when the tile
     *  shows "Call for price"-style copy. */
    price: z.number().nullable(),
    /** Manufacturer's suggested retail price as shown on the tile, or null. */
    msrp: z.number().nullable(),
    dealer_name: z.string().nullable(),
    /** "City, ST" as shown on the tile, or null. */
    dealer_city_state: z.string().nullable(),
    distance_miles: z.number().nullable(),
    /** Closed availability vocabulary reused from InventoryListing; the model
     *  maps tile wording onto it and uses "unknown" when the tile shows nothing. */
    inventory_status: InventoryStatusSchema,
    /** The tile's own vehicle-detail-page href, or null. */
    listing_url: z.string().nullable(),
  })
  .strict();
export type AggregatorListing = z.infer<typeof AggregatorListingSchema>;
