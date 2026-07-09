/**
 * visorMap — pure, deterministic mapping from visor.vin's react-query-cache rows
 * (collected by `collectVisor` in aggregatorAdapters.ts) to `AggregatorListing`.
 * No browser, no LLM: visor rows are already structured data straight from the
 * site's own API response, so there is no extraction step to fabricate provenance
 * for — the row IS the provenance. Two Zod boundaries: `VisorRowSchema` validates
 * the untrusted page row shape (a page-scrape detail, kept in tools, not core),
 * then `AggregatorListingSchema` (core) validates the final mapped object.
 */
import { AggregatorListingSchema, type AggregatorListing } from "@autobroker/core";
import { z } from "zod";

import { haversineMiles } from "../geosearch/pure.js";

/** The untrusted shape of one visor.vin listing row, as pruned by `collectVisor`.
 *  Only the fields the mapping actually reads are required; the rest are
 *  passthrough-optional (not mapped, never required) so an unrelated field drift
 *  never fails a row that still carries everything the mapping needs. */
export const VisorRowSchema = z
  .object({
    vin: z.string().min(11),
    year: z.number().int(),
    make: z.string().min(1),
    model: z.string().min(1),
    trim: z.string().nullable().optional(),
    price: z.number().nullable().optional(),
    exteriorColor: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    latitude: z.number().nullable().optional(),
    longitude: z.number().nullable().optional(),
    dealerName: z.string().nullable().optional(),
    vdpUrl: z.string().nullable().optional(),
    stockNumber: z.unknown().optional(),
    dealerId: z.unknown().optional(),
    miles: z.unknown().optional(),
    inventoryType: z.unknown().optional(),
  })
  .passthrough();

/** The buyer profile's coordinates, when known — used only to compute
 *  `distance_miles`; null coordinates map to a null distance, never a guess. */
export interface VisorProfileCoords {
  lat: number | null;
  lng: number | null;
}

export interface VisorMapResult {
  listings: AggregatorListing[];
  /** Rows failing `VisorRowSchema` or the final `AggregatorListingSchema` belt. */
  invalidDropped: number;
  /** Rows with a null/empty `dealerName` — dropped, never emitted with a guessed
   *  dealer (a listing without a knowable dealer is not actionable). */
  droppedNoDealer: number;
}

/** True iff `url` parses as an absolute http(s) URL — visor's `vdpUrl` is the
 *  DEALER'S OWN site VDP (the point of this source), so a non-URL value
 *  (e.g. "about:blank", a javascript: pseudo-URL) maps to null rather than being
 *  passed through. */
function absoluteHttpUrl(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Map already-collected visor.vin rows (untyped, from the page's react-query
 * cache) to `AggregatorListing[]`. Deterministic, no LLM: `trim` is carried
 * verbatim from visor's own (coarse — recorded limitation) column;
 * `inventory_status` is always "unknown" by design (visor rows carry no
 * availability column — never guessed from a days-on-site counter); `msrp` is
 * always null (visor does not surface it). Rows with no dealer name are dropped
 * (never emitted with a fabricated dealer); rows failing either Zod boundary are
 * dropped and counted.
 */
export function mapVisorStructuredRows(rows: unknown[], coords: VisorProfileCoords): VisorMapResult {
  const listings: AggregatorListing[] = [];
  let invalidDropped = 0;
  let droppedNoDealer = 0;

  for (const raw of rows) {
    const parsed = VisorRowSchema.safeParse(raw);
    if (!parsed.success) {
      invalidDropped += 1;
      continue;
    }
    const row = parsed.data;

    const dealerName = row.dealerName ?? null;
    if (dealerName === null || dealerName === "") {
      droppedNoDealer += 1;
      continue;
    }

    const city = row.city ?? null;
    const state = row.state ?? null;
    const dealerCityState = city !== null && state !== null ? `${city}, ${state}` : null;

    const rowLat = row.latitude ?? null;
    const rowLng = row.longitude ?? null;
    const distanceMiles =
      coords.lat !== null && coords.lng !== null && rowLat !== null && rowLng !== null
        ? haversineMiles({ lat1: coords.lat, lng1: coords.lng, lat2: rowLat, lng2: rowLng })
        : null;

    const mapped: AggregatorListing = {
      vin: row.vin,
      year: row.year,
      make: row.make,
      model: row.model,
      trim: row.trim ?? null,
      price: row.price ?? null,
      msrp: null,
      exterior_color: row.exteriorColor ?? null,
      dealer_name: dealerName,
      dealer_city_state: dealerCityState,
      distance_miles: distanceMiles,
      inventory_status: "unknown",
      listing_url: absoluteHttpUrl(row.vdpUrl),
    };

    const belt = AggregatorListingSchema.safeParse(mapped);
    if (!belt.success) {
      invalidDropped += 1;
      continue;
    }
    listings.push(belt.data);
  }

  return { listings, invalidDropped, droppedNoDealer };
}
