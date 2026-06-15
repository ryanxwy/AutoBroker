/**
 * L1 unit tests — flagCodesFromJson, the shared flags_json → code[] decoder.
 *
 * Defensive by contract: null / "" / non-JSON / non-list / non-dict entries /
 * missing-or-empty code all degrade to [] or are skipped; valid string codes
 * are extracted in order.
 */

import { describe, expect, it } from "vitest";

import { flagCodesFromJson } from "./flags.js";

describe("flagCodesFromJson", () => {
  it("returns [] for null / undefined / empty string", () => {
    expect(flagCodesFromJson(null)).toEqual([]);
    expect(flagCodesFromJson(undefined)).toEqual([]);
    expect(flagCodesFromJson("")).toEqual([]);
  });

  it("returns [] for non-JSON text", () => {
    expect(flagCodesFromJson("{not json")).toEqual([]);
  });

  it("returns [] for a JSON value that is not a list", () => {
    expect(flagCodesFromJson('{"code":"X"}')).toEqual([]);
    expect(flagCodesFromJson("42")).toEqual([]);
  });

  it("extracts non-empty string codes in order, skipping bad entries", () => {
    const blob = JSON.stringify([
      { code: "APR_MARKUP", severity: "warn" },
      "not-a-dict",
      { code: "" },
      { severity: "warn" },
      { code: 123 },
      { code: "DEALER_FEE_OUTLIER", severity: "warn", text: "x", suggestion: "y" },
    ]);
    expect(flagCodesFromJson(blob)).toEqual(["APR_MARKUP", "DEALER_FEE_OUTLIER"]);
  });

  it("accepts an already-parsed array value (not just a JSON string)", () => {
    expect(flagCodesFromJson([{ code: "MATH_SANITY" }])).toEqual(["MATH_SANITY"]);
  });

  it("returns [] for an empty array", () => {
    expect(flagCodesFromJson("[]")).toEqual([]);
  });
});
