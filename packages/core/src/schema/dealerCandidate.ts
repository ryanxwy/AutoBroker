/**
 * DealerCandidate — the neutral 12-field shape for one dealer discovered on
 * the Google Maps results feed by `dealer_geosearch`.
 *
 * Both extraction sources emit this exact shape:
 *   - the in-page evaluate extractor (the zero-LLM happy path), and
 *   - the snapshot-fallback LLM pass (`geosearch_extract`, single emit_result
 *     tool — never structured object output mixed with tools on DeepSeek).
 *
 * Structured-output discipline: flat, all-required-with-explicit-null, lowest
 * common JSON-Schema subset, `.strict()` post-validation. `type_line` is
 * filter-only and is not persisted; the persisted dealer row additionally
 * carries a deterministic `dealer_id` and an annotated `distance_miles`,
 * both computed in the tools layer (core stays pure).
 *
 * This file MUST NOT import any framework. Pure types + Zod only.
 */

import { z } from "zod";

export const DealerCandidateSchema = z
  .object({
    name: z.string().nullable(),
    address: z.string().nullable(),
    phone: z.string().nullable(),
    /** Ad-click (/aclk) URLs are stripped to null at extraction time. */
    website: z.string().nullable(),
    /** `0x…:0x…` hex pair from the result href — the authoritative dedup key. */
    google_place_id: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    rating: z.number().nullable(),
    review_count: z.number().int().nullable(),
    /** Category line on the card (e.g. "Hyundai dealer") — filter-only. */
    type_line: z.string().nullable(),
    /** Paid placement: /aclk website href or a "Sponsored" card label. */
    sponsored: z.boolean(),
    /** Service/parts/repair-only listing (category names no dealer/dealership). */
    service_center: z.boolean(),
  })
  .strict();
export type DealerCandidate = z.infer<typeof DealerCandidateSchema>;
