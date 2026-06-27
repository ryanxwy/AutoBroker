/**
 * L1 unit tests — dealer_geosearch deterministic core. The numeric pins here
 * are the source of truth for the viewport/distance math (haversine,
 * dealerId, candidate-registration semantics); the viewport math has no legacy
 * implementation, so these L1 pins (200 mi @ 47.76°N worked checkpoint, zoom
 * breakpoints) ARE the single source of truth for it.
 */

import { describe, expect, it } from "vitest";
import type { DealerCandidate } from "@autobroker/core";
import {
  EARTH_RADIUS_MILES,
  annotateDistance,
  buildMapsSearchUrl,
  dealerId,
  dedupByPlaceId,
  haversineMiles,
  rankByDistance,
  rejectNonCandidate,
  tileViewports,
  zoomForRadius,
} from "./pure.js";

/** A complete 12-field candidate; per-test overrides tune the fields. */
function candidate(overrides: Partial<DealerCandidate> = {}): DealerCandidate {
  return {
    name: "Alpha Hyundai",
    address: "123 Auto Center Dr",
    phone: "(949) 555-0100",
    website: "https://alphahyundai.com",
    google_place_id: "0xdead:0xbeef",
    latitude: 33.68,
    longitude: -117.83,
    rating: 4.5,
    review_count: 1234,
    type_line: "Hyundai dealer",
    sponsored: false,
    service_center: false,
    ...overrides,
  };
}

describe("haversineMiles", () => {
  it("is zero for the same point (half-angle form is stable near zero)", () => {
    expect(
      haversineMiles({ lat1: 47.6, lng1: -122.3, lat2: 47.6, lng2: -122.3 }),
    ).toBe(0);
  });

  it("Seattle → Portland ≈ 145 mi (known-distance pin, abs tol 5)", () => {
    const dist = haversineMiles({
      lat1: 47.6062,
      lng1: -122.3321,
      lat2: 45.5152,
      lng2: -122.6784,
    });
    expect(Math.abs(dist - 145)).toBeLessThanOrEqual(5);
  });

  it("uses the 3958.8-mile earth radius", () => {
    expect(EARTH_RADIUS_MILES).toBe(3958.8);
    // A quarter of the equator: Δlng 90° on the equator.
    const quarter = haversineMiles({ lat1: 0, lng1: 0, lat2: 0, lng2: 90 });
    expect(quarter).toBeCloseTo((EARTH_RADIUS_MILES * Math.PI) / 2, 6);
  });

  it("clamps √a so antipodal points cannot push asin out of domain", () => {
    const half = haversineMiles({ lat1: 0, lng1: 0, lat2: 0, lng2: 180 });
    expect(Number.isFinite(half)).toBe(true);
    expect(half).toBeCloseTo(EARTH_RADIUS_MILES * Math.PI, 6);
  });
});

describe("zoomForRadius", () => {
  it("three closed-boundary segments: ≤10 → 12z, ≤25 → 11z, else 10z", () => {
    expect(zoomForRadius(10)).toBe(12);
    expect(zoomForRadius(25)).toBe(11);
    expect(zoomForRadius(26)).toBe(10);
    expect(zoomForRadius(50)).toBe(10);
    expect(zoomForRadius(200)).toBe(10);
  });
});

describe("buildMapsSearchUrl", () => {
  it("builds the /maps/search/<make>+dealership/@lat,lng,zoomz template", () => {
    expect(
      buildMapsSearchUrl({ make: "Hyundai", lat: 33.68, lng: -117.83, zoom: 11 }),
    ).toBe("https://www.google.com/maps/search/Hyundai+dealership/@33.68,-117.83,11z");
  });

  it("turns spaces in a multi-word make into +", () => {
    const url = buildMapsSearchUrl({ make: "Land Rover", lat: 1, lng: 2, zoom: 10 });
    expect(url).toContain("Land+Rover+dealership");
  });
});

describe("tileViewports", () => {
  it("radius ≤ 50 → a single center viewport at the radius-derived zoom", () => {
    const vps = tileViewports({ make: "Hyundai", lat: 33.68, lng: -117.83, radiusMiles: 25 });
    expect(vps).toHaveLength(1);
    expect(vps[0]!.label).toBe("C");
    expect(vps[0]!.zoom).toBe(11);
    expect(vps[0]!.url).toContain("@33.68,-117.83,11z");
  });

  it("200 mi @ 47.76°N → five 10z viewports, E/W lng offset ≈ 2.16° (tol 0.05)", () => {
    const vps = tileViewports({ make: "Hyundai", lat: 47.76, lng: -122.3, radiusMiles: 200 });
    expect(vps).toHaveLength(5);
    expect(vps.map((v) => v.label)).toEqual(["C", "N", "S", "E", "W"]);
    expect(vps.every((v) => v.zoom === 10)).toBe(true);
    const center = vps[0]!;
    const east = vps[3]!;
    const west = vps[4]!;
    expect(Math.abs(east.lng - center.lng - 2.16)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(center.lng - west.lng - 2.16)).toBeLessThanOrEqual(0.05);
    // Latitude offset: (200/2)/69 ≈ 1.449°, N positive / S negative.
    const north = vps[1]!;
    const south = vps[2]!;
    expect(north.lat - center.lat).toBeCloseTo(100 / 69, 6);
    expect(center.lat - south.lat).toBeCloseTo(100 / 69, 6);
  });
});

describe("dealerId", () => {
  it("is a stable 16-char hex id (same input → same id)", () => {
    const c = { google_place_id: "ChIJplaceAlpha", name: "Alpha Toyota", address: null };
    const id = dealerId(c);
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(dealerId({ ...c })).toBe(id);
  });

  it("falls back to name|address|city when the place id is missing", () => {
    const a = dealerId({
      google_place_id: null,
      name: "No ID Motors",
      address: "123 Main St",
      city: "Seattle",
    });
    const b = dealerId({
      google_place_id: null,
      name: "No ID Motors",
      address: "123 Main St",
      city: "Seattle",
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it("the place id takes priority over the name fallback", () => {
    const withPlace = dealerId({ google_place_id: "p-1", name: "Same", address: "Same" });
    const without = dealerId({ google_place_id: null, name: "Same", address: "Same" });
    expect(withPlace).not.toBe(without);
  });

  it("an empty-string place id falls back like null (truthy check)", () => {
    expect(dealerId({ google_place_id: "", name: "X", address: "Y" })).toBe(
      dealerId({ google_place_id: null, name: "X", address: "Y" }),
    );
  });
});

describe("dedupByPlaceId", () => {
  it("collapses cross-viewport duplicates, first-seen wins", () => {
    const first = candidate({ google_place_id: "0xa:0x1", name: "First Seen" });
    const dupe = candidate({ google_place_id: "0xa:0x1", name: "Second Seen" });
    const other = candidate({ google_place_id: "0xb:0x2", name: "Other" });
    const out = dedupByPlaceId([first, dupe, other]);
    expect(out).toHaveLength(2);
    expect(out[0]!.name).toBe("First Seen");
    expect(out[1]!.name).toBe("Other");
  });

  it("always keeps rows with a null place id (no authoritative key)", () => {
    const a = candidate({ google_place_id: null, name: "A" });
    const b = candidate({ google_place_id: null, name: "B" });
    expect(dedupByPlaceId([a, b])).toHaveLength(2);
  });
});

describe("rejectNonCandidate", () => {
  it("drops non-US (cross-border) rows so they never enter the ranked set", () => {
    const canadian = candidate({ website: "https://example.ca", google_place_id: "0xc:0x1" });
    // The live San Diego/Tijuana case: a Mexican border dealer with a .com site
    // — caught by the name token, dropped before ranking.
    const tijuana = candidate({
      website: "https://hyundaipremiertijuana.com",
      name: "Hyundai Premier Tijuana",
      google_place_id: "0xc:0x3",
    });
    const us = candidate({ google_place_id: "0xc:0x2" });
    const result = rejectNonCandidate([canadian, tijuana, us]);
    expect(result.nonUsDropped).toBe(2);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.google_place_id).toBe("0xc:0x2");
  });

  it("drops sponsored rows", () => {
    const ad = candidate({ sponsored: true, google_place_id: "0xd:0x1" });
    const organic = candidate({ google_place_id: "0xd:0x2" });
    const result = rejectNonCandidate([ad, organic]);
    expect(result.sponsoredDropped).toBe(1);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.google_place_id).toBe("0xd:0x2");
  });

  it("nulls a surviving /aclk website but keeps the row", () => {
    const adUrl = candidate({
      sponsored: false,
      website: "https://www.google.com/aclk?sa=L&ai=xyz",
      google_place_id: "0xe:0x1",
    });
    const result = rejectNonCandidate([adUrl]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.website).toBeNull();
  });

  it("drops service-only rows", () => {
    const service = candidate({
      service_center: true,
      type_line: "Auto repair shop",
      google_place_id: "0xf:0x1",
    });
    const result = rejectNonCandidate([service, candidate({ google_place_id: "0xf:0x2" })]);
    expect(result.serviceOnlyDropped).toBe(1);
    expect(result.kept).toHaveLength(1);
  });

  it("drops place-id collisions and counts them", () => {
    const a = candidate({ google_place_id: "0x1:0x1", name: "Keep" });
    const b = candidate({ google_place_id: "0x1:0x1", name: "Drop" });
    const result = rejectNonCandidate([a, b]);
    expect(result.placeIdCollisionsDropped).toBe(1);
    expect(result.kept.map((c) => c.name)).toEqual(["Keep"]);
  });

  it("KEEPS a row with no website (never a silent drop)", () => {
    const noSite = candidate({ website: null, google_place_id: "0x2:0x1" });
    const result = rejectNonCandidate([noSite]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.website).toBeNull();
  });
});

describe("annotateDistance / rankByDistance", () => {
  const origin = { lat: 47.6062, lng: -122.3321 }; // Seattle

  it("annotates a 2-dp distance from the origin", () => {
    const portland = candidate({ latitude: 45.5152, longitude: -122.6784 });
    const ranked = annotateDistance(portland, origin);
    expect(ranked.distance_miles).not.toBeNull();
    expect(Math.abs(ranked.distance_miles! - 145)).toBeLessThanOrEqual(5);
    // 2-dp rounding.
    expect(ranked.distance_miles).toBe(Math.round(ranked.distance_miles! * 100) / 100);
  });

  it("is a no-op (null distance) when the row has no coordinates", () => {
    const noCoords = candidate({ latitude: null, longitude: null });
    expect(annotateDistance(noCoords, origin).distance_miles).toBeNull();
  });

  it("drops rows beyond the radius and sorts ascending", () => {
    const near = candidate({ name: "Near", latitude: 47.61, longitude: -122.33, google_place_id: "0x3:0x1" });
    const mid = candidate({ name: "Mid", latitude: 47.8, longitude: -122.3, google_place_id: "0x3:0x2" });
    const far = candidate({ name: "Portland", latitude: 45.5152, longitude: -122.6784, google_place_id: "0x3:0x3" });
    const ranked = rankByDistance([far, mid, near], origin, 50);
    expect(ranked.map((c) => c.name)).toEqual(["Near", "Mid"]);
    expect(ranked[0]!.distance_miles!).toBeLessThan(ranked[1]!.distance_miles!);
  });

  it("keeps unknown-distance rows (no coords) and sorts them last", () => {
    const near = candidate({ name: "Near", latitude: 47.61, longitude: -122.33, google_place_id: "0x4:0x1" });
    const unknown = candidate({ name: "Unknown", latitude: null, longitude: null, google_place_id: "0x4:0x2" });
    const ranked = rankByDistance([unknown, near], origin, 50);
    expect(ranked.map((c) => c.name)).toEqual(["Near", "Unknown"]);
    expect(ranked[1]!.distance_miles).toBeNull();
  });
});
