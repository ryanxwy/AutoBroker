/**
 * format.test — the shared canvas label formatters. Proves the dollar/distance/
 * expiry labels round + format as the section tiles and detail modals expect,
 * and that null/empty inputs degrade to null/"" (so the caller omits the field).
 */

import { describe, expect, it } from "vitest";

import { absoluteTimestamp, distanceLabel, dollarLabel, expiryLine, relativeDate } from "./format.js";

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

describe("absoluteTimestamp", () => {
  it("formats a NUMERIC epoch-ms received_at (where relativeDate returns '')", () => {
    const ms = Date.parse("2026-06-12T15:04:00.000Z");
    const expected = new Date(ms).toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    expect(absoluteTimestamp(ms)).toBe(expected);
    expect(absoluteTimestamp(ms)).not.toBe("");
    // relativeDate accepts a string only (it calls .trim()), so it cannot consume
    // a numeric epoch-ms received_at — the contrast that justifies the new helper.
    expect(() => relativeDate(ms as unknown as string)).toThrow();
  });

  it("formats an ISO-string received_at", () => {
    const iso = "2026-06-12T15:04:00.000Z";
    const expected = new Date(Date.parse(iso)).toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    expect(absoluteTimestamp(iso)).toBe(expected);
  });

  it("degrades to '' on null / blank / unparseable", () => {
    expect(absoluteTimestamp(null)).toBe("");
    expect(absoluteTimestamp("")).toBe("");
    expect(absoluteTimestamp("not-a-date")).toBe("");
    expect(absoluteTimestamp(Number.NaN)).toBe("");
  });
});
