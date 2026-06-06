/**
 * L1 unit tests — SearchProfileSchema (full 33-column mirror).
 *
 * Pure Zod parse tests; no DB, no framework. Freezes:
 *   (a) a full 33-field sample row (every column present) parses;
 *   (b) the status enum vocabulary + nullable status;
 *   (c) .strict() rejects an unknown key.
 */

import { describe, expect, it } from "vitest";
import {
  SearchProfileSchema,
  SearchProfileStatusSchema,
  type SearchProfile,
} from "./searchProfile.js";

/** A full row: all 33 fields present (the oracle baseline shape). */
const FULL_ROW: SearchProfile = {
  id: "a1b2c3d4e5f60718",
  year: 2026,
  make: "Hyundai",
  model: "Tucson Hybrid",
  trim: "Limited",
  budgetMax: 42000,
  searchRadiusMiles: 25,
  locationQuery: "Irvine, CA 92614",
  resolvedAddress: "Irvine, CA 92614, USA",
  city: "Irvine",
  state: "CA",
  postalCode: "92614",
  country: "US",
  latitude: 33.6846,
  longitude: -117.8265,
  followUpEmail: "buyer@example.com",
  followUpPhone: "9495551234",
  phonePolicy: "fake",
  fakePhone: "9495559876",
  financingPreference: "finance",
  tradeInDescription: "2019 Civic, 40k mi",
  militaryFirstResponder: 0,
  currentBrandOwner: 1,
  preferredExteriorColorsJson: '["white","black"]',
  preferredInteriorColorsJson: '["gray"]',
  acceptableTrimsJson: '["Limited","SEL"]',
  featurePreferencesJson: '["pano roof"]',
  accountId: "acct-1",
  brand: "Hyundai",
  location: "Irvine, CA 92614",
  status: "active",
  supersededBy: null,
  updatedAt: "2026-06-04T00:00:00Z",
};

describe("SearchProfileSchema — full 33-column row", () => {
  it("parses a row with all 33 fields present", () => {
    const parsed = SearchProfileSchema.parse(FULL_ROW);
    expect(Object.keys(parsed)).toHaveLength(33);
    expect(parsed.id).toBe("a1b2c3d4e5f60718");
    expect(parsed.budgetMax).toBe(42000);
    expect(parsed.locationQuery).toBe("Irvine, CA 92614");
    expect(parsed.location).toBe("Irvine, CA 92614");
  });

  it("accepts NULL for every nullable column (legacy oracle row)", () => {
    const parsed = SearchProfileSchema.parse({
      ...FULL_ROW,
      trim: null,
      budgetMax: null,
      searchRadiusMiles: null,
      locationQuery: null,
      resolvedAddress: null,
      city: null,
      state: null,
      postalCode: null,
      country: null,
      latitude: null,
      longitude: null,
      followUpEmail: null,
      followUpPhone: null,
      phonePolicy: null,
      fakePhone: null,
      financingPreference: null,
      tradeInDescription: null,
      militaryFirstResponder: null,
      currentBrandOwner: null,
      preferredExteriorColorsJson: null,
      preferredInteriorColorsJson: null,
      acceptableTrimsJson: null,
      featurePreferencesJson: null,
      accountId: null,
      brand: null,
      location: null,
      status: null,
      supersededBy: null,
      updatedAt: null,
    });
    expect(parsed.status).toBeNull();
    expect(parsed.latitude).toBeNull();
    expect(parsed.budgetMax).toBeNull();
  });

  it("status enum is exactly active|superseded|closed", () => {
    expect(SearchProfileStatusSchema.options).toEqual([
      "active",
      "superseded",
      "closed",
    ]);
  });

  it("rejects an unknown key (.strict)", () => {
    expect(() =>
      SearchProfileSchema.parse({ ...FULL_ROW, bogus: 1 }),
    ).toThrow();
  });

  it("requires year/make/model (the NOT NULL columns)", () => {
    const { make: _make, ...noMake } = FULL_ROW;
    expect(() => SearchProfileSchema.parse(noMake)).toThrow();
  });
});
