import { describe, expect, it } from "vitest";

import {
  INCENTIVE_ELIGIBILITIES,
  INCENTIVE_TYPES,
  IncentiveSchema,
  IncentiveSourceRegistryEntrySchema,
} from "./incentive.js";

const validRow = {
  type: "customer_cash",
  amount: 1500,
  expires: "2026-07-06",
  eligibility: "all",
};

describe("IncentiveSchema", () => {
  it("accepts a complete cash row", () => {
    expect(IncentiveSchema.parse(validRow)).toEqual(validRow);
  });

  it("accepts the no-inline-expiration shape (expires null, never inferred)", () => {
    const row = { ...validRow, expires: null };
    expect(IncentiveSchema.parse(row).expires).toBeNull();
  });

  it("rejects a negative amount", () => {
    expect(IncentiveSchema.safeParse({ ...validRow, amount: -1 }).success).toBe(false);
  });

  it("accepts a zero amount (an offer with no dollar figure)", () => {
    expect(IncentiveSchema.parse({ ...validRow, amount: 0 }).amount).toBe(0);
  });

  it("rejects a non-ISO expires string (prose dates never pass)", () => {
    expect(IncentiveSchema.safeParse({ ...validRow, expires: "July 6" }).success).toBe(false);
    expect(IncentiveSchema.safeParse({ ...validRow, expires: "07/06/2026" }).success).toBe(false);
  });

  it("rejects an unknown type / eligibility (closed enums)", () => {
    expect(IncentiveSchema.safeParse({ ...validRow, type: "apr" }).success).toBe(false);
    expect(IncentiveSchema.safeParse({ ...validRow, eligibility: "vip" }).success).toBe(false);
  });

  it("is .strict() — an extra key is rejected, never silently dropped", () => {
    expect(IncentiveSchema.safeParse({ ...validRow, note: "x" }).success).toBe(false);
  });

  it("requires every field explicitly (all-required-with-explicit-null)", () => {
    const { expires: _expires, ...missingExpires } = validRow;
    expect(IncentiveSchema.safeParse(missingExpires).success).toBe(false);
  });

  it("the type enum carries exactly the 5 cash classes + other", () => {
    expect(INCENTIVE_TYPES).toEqual([
      "customer_cash",
      "loyalty",
      "military",
      "conquest",
      "lease_cash",
      "other",
    ]);
    expect(INCENTIVE_ELIGIBILITIES).toContain("all");
  });
});

describe("IncentiveSourceRegistryEntrySchema", () => {
  const entry = {
    url_template: "https://www.hyundaiusa.com/us/en/offers?zip={zip}&model={model}",
    added_at: "2026-06-12T00:00:00Z",
    added_for_profile: "sp_abc",
  };

  it("accepts a registry row (template placeholders allowed)", () => {
    expect(IncentiveSourceRegistryEntrySchema.parse(entry)).toEqual(entry);
  });

  it("rejects empty members and extra keys", () => {
    expect(
      IncentiveSourceRegistryEntrySchema.safeParse({ ...entry, url_template: "" }).success,
    ).toBe(false);
    expect(
      IncentiveSourceRegistryEntrySchema.safeParse({ ...entry, extra: 1 }).success,
    ).toBe(false);
  });
});
