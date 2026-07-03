import { describe, expect, it } from "vitest";

import { AggregatorListingSchema } from "./aggregatorListing.js";

const validRow = {
  vin: "1HGRW2H85RA000123",
  year: 2026,
  make: "Honda",
  model: "CR-V",
  trim: "EX-L 2WD",
  exterior_color: "Crystal Black Pearl",
  price: 35262,
  msrp: 35262,
  dealer_name: "AutoNation Honda Costa Mesa",
  dealer_city_state: "Costa Mesa, CA",
  distance_miles: 8,
  inventory_status: "in_stock",
  listing_url: "https://www.cars.com/vehicledetail/abc123/",
};

describe("AggregatorListingSchema", () => {
  it("accepts a complete listing row", () => {
    expect(AggregatorListingSchema.parse(validRow)).toEqual(validRow);
  });

  it("accepts nulls in every nullable field", () => {
    const row = {
      ...validRow,
      vin: null,
      year: null,
      make: null,
      model: null,
      trim: null,
      exterior_color: null,
      price: null,
      msrp: null,
      dealer_name: null,
      dealer_city_state: null,
      distance_miles: null,
      listing_url: null,
    };
    expect(AggregatorListingSchema.parse(row)).toEqual(row);
  });

  it("uses 'unknown' when the tile shows no availability signal", () => {
    const row = { ...validRow, inventory_status: "unknown" };
    expect(AggregatorListingSchema.parse(row).inventory_status).toBe("unknown");
  });

  it("rejects a junk inventory_status (closed enum, never nullable)", () => {
    expect(AggregatorListingSchema.safeParse({ ...validRow, inventory_status: "maybe" }).success).toBe(
      false,
    );
    expect(AggregatorListingSchema.safeParse({ ...validRow, inventory_status: null }).success).toBe(
      false,
    );
  });

  it("rejects a missing field (all-required-with-explicit-null)", () => {
    const { msrp: _msrp, ...missingMsrp } = validRow;
    expect(AggregatorListingSchema.safeParse(missingMsrp).success).toBe(false);
  });

  it("is .strict() — an extra key is rejected, never silently dropped", () => {
    expect(AggregatorListingSchema.safeParse({ ...validRow, budget: 40000 }).success).toBe(false);
  });

  it("rejects wrong-typed numeric fields (year/price/msrp/distance are numbers-or-null)", () => {
    expect(AggregatorListingSchema.safeParse({ ...validRow, year: "2026" }).success).toBe(false);
    expect(AggregatorListingSchema.safeParse({ ...validRow, price: "$35,262" }).success).toBe(false);
    expect(AggregatorListingSchema.safeParse({ ...validRow, distance_miles: "8" }).success).toBe(
      false,
    );
  });
});
