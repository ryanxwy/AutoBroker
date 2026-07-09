/**
 * visorMap tests — pure, no browser, no LLM. Fixtures are shaped like the
 * captured probe rows (aggregatorAdapters.ts's collectVisor pruning).
 */
import { describe, expect, it } from "vitest";

import { mapVisorStructuredRows, type VisorProfileCoords } from "./visorMap.js";

const PROFILE_COORDS: VisorProfileCoords = { lat: 47.68148, lng: -122.1203 };

const s1 = {
  vin: "2T36CRAV9TC331812",
  year: 2026,
  make: "Toyota",
  model: "RAV4",
  trim: "XLE",
  price: 45799,
  exteriorColor: "Black",
  state: "WA",
  city: "Edmonds",
  latitude: 47.806063,
  longitude: -122.377,
  dealerName: "Swickard Toyota",
  vdpUrl: "https://www.swickardtoyota.com/auto/new-2026-toyota-rav4/123",
  inventoryType: "new",
};

describe("mapVisorStructuredRows", () => {
  it("maps a full row to an AggregatorListing with a computed distance and unknown status", () => {
    const result = mapVisorStructuredRows([s1], PROFILE_COORDS);

    expect(result.invalidDropped).toBe(0);
    expect(result.droppedNoDealer).toBe(0);
    expect(result.listings).toHaveLength(1);
    const listing = result.listings[0]!;
    expect(listing).toMatchObject({
      vin: "2T36CRAV9TC331812",
      year: 2026,
      make: "Toyota",
      model: "RAV4",
      trim: "XLE",
      price: 45799,
      msrp: null,
      exterior_color: "Black",
      dealer_name: "Swickard Toyota",
      dealer_city_state: "Edmonds, WA",
      inventory_status: "unknown",
      listing_url: "https://www.swickardtoyota.com/auto/new-2026-toyota-rav4/123",
    });
    // Real haversine distance between the two fixture coordinates (~14.7 mi) — the
    // exact figure is haversineMiles's own job to get right (geosearch/pure.test.ts);
    // this only asserts a distance was actually computed, in a sane band.
    expect(listing.distance_miles).not.toBeNull();
    expect(listing.distance_miles).toBeGreaterThanOrEqual(14);
    expect(listing.distance_miles).toBeLessThanOrEqual(15);
  });

  it("maps to a null distance when the row has no coordinates", () => {
    const s2 = { ...s1, latitude: undefined, longitude: undefined };
    const result = mapVisorStructuredRows([s2], PROFILE_COORDS);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]!.distance_miles).toBeNull();
  });

  it("maps to a null distance when the profile coords are null", () => {
    const result = mapVisorStructuredRows([s1], { lat: null, lng: null });
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]!.distance_miles).toBeNull();
  });

  it("drops a row with no dealer name and counts it, without emitting a listing", () => {
    const s3 = { ...s1, dealerName: null };
    const result = mapVisorStructuredRows([s3], PROFILE_COORDS);
    expect(result.listings).toHaveLength(0);
    expect(result.droppedNoDealer).toBe(1);
    expect(result.invalidDropped).toBe(0);
  });

  it("drops a row that fails VisorRowSchema and counts it as invalid", () => {
    const s4 = { garbage: "x" };
    const result = mapVisorStructuredRows([s4], PROFILE_COORDS);
    expect(result.listings).toHaveLength(0);
    expect(result.invalidDropped).toBe(1);
    expect(result.droppedNoDealer).toBe(0);
  });

  it("maps a non-http(s) vdpUrl (about:blank / javascript:) to a null listing_url", () => {
    const s5a = { ...s1, vdpUrl: "about:blank" };
    const s5b = { ...s1, vdpUrl: "javascript:alert(1)" };
    const result = mapVisorStructuredRows([s5a, s5b], PROFILE_COORDS);
    expect(result.listings).toHaveLength(2);
    expect(result.listings[0]!.listing_url).toBeNull();
    expect(result.listings[1]!.listing_url).toBeNull();
  });

  it("returns an empty result for an empty row list", () => {
    const result = mapVisorStructuredRows([], PROFILE_COORDS);
    expect(result).toEqual({ listings: [], invalidDropped: 0, droppedNoDealer: 0 });
  });
});
