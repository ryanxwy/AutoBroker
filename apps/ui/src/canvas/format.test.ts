/**
 * format.test — the shared canvas label formatters. Proves the dollar/distance/
 * expiry labels round + format as the section tiles and detail modals expect,
 * and that null/empty inputs degrade to null/"" (so the caller omits the field).
 */

import { describe, expect, it } from "vitest";

import { distanceLabel, dollarLabel, expiryLine } from "./format.js";

describe("dollarLabel", () => {
  it("formats with thousands separators and no cents", () => {
    expect(dollarLabel(43210)).toBe("$43,210");
    expect(dollarLabel(0)).toBe("$0");
  });
  it("rounds to the nearest dollar", () => {
    expect(dollarLabel(43210.49)).toBe("$43,210");
    expect(dollarLabel(43210.5)).toBe("$43,211");
  });
  it("returns null for a missing value", () => {
    expect(dollarLabel(null)).toBeNull();
  });
});

describe("distanceLabel", () => {
  it("formats one decimal place with a mi suffix", () => {
    expect(distanceLabel(5.234)).toBe("5.2 mi");
    expect(distanceLabel(0)).toBe("0.0 mi");
  });
  it("returns null when unknown", () => {
    expect(distanceLabel(null)).toBeNull();
  });
});

describe("expiryLine", () => {
  it("prefixes a present expiry with 'expires '", () => {
    expect(expiryLine("2026-07-31")).toBe("expires 2026-07-31");
  });
  it("returns an empty string for a missing/blank expiry", () => {
    expect(expiryLine(null)).toBe("");
    expect(expiryLine("")).toBe("");
  });
});
