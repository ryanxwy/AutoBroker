import { describe, expect, it } from "vitest";

import { classifyTrimAvailability, normalizeTrim, trimSubsetMatch } from "./trimMatch.js";

describe("normalizeTrim", () => {
  it("drops powertrain/transmission/body noise tokens", () => {
    expect(normalizeTrim("LX CVT")).toEqual(["lx"]);
    expect(normalizeTrim("1.5T LX")).toEqual(["lx"]);
    expect(normalizeTrim("Sport-L Sedan")).toEqual(["sport-l"]);
    expect(normalizeTrim("EX-L Hybrid")).toEqual(["ex-l"]);
    expect(normalizeTrim("2.5 S Premium AWD")).toEqual(["s", "premium"]);
  });
  it("keeps hyphens inside a token (EX-L is one token)", () => {
    expect(normalizeTrim("EX-L")).toEqual(["ex-l"]);
    expect(normalizeTrim("EX")).toEqual(["ex"]);
  });
});

describe("trimSubsetMatch", () => {
  it("matches a bare trim against a dealer string with powertrain suffixes", () => {
    expect(trimSubsetMatch("LX", "LX CVT")).toBe(true);
    expect(trimSubsetMatch("LX", "1.5T LX")).toBe(true);
    expect(trimSubsetMatch("SE", "SE CVT")).toBe(true);
    expect(trimSubsetMatch("EX-L", "EX-L Hybrid")).toBe(true);
  });
  it("keeps genuinely distinct trims apart (EX vs EX-L; Sport vs Sport-L)", () => {
    expect(trimSubsetMatch("EX", "EX-L Hybrid")).toBe(false);
    expect(trimSubsetMatch("Sport", "Sport-L Sedan")).toBe(false);
  });
  it("is false for an empty requested trim", () => {
    expect(trimSubsetMatch("", "LX CVT")).toBe(false);
  });
});

describe("classifyTrimAvailability", () => {
  // The exact failing-run inventory shape.
  const accord = ["LX", "SE CVT", "Sport Sedan", "Sport-L Sedan", "LX CVT"];

  it("MATCHES the canonical LX that the old verify false-rejected", () => {
    const r = classifyTrimAvailability("LX", accord);
    expect(r.matched).toBe(true);
    expect(r.suggestions).toContain("LX");
  });

  it("matches SE against 'SE CVT'", () => {
    expect(classifyTrimAvailability("SE", accord).matched).toBe(true);
  });

  it("does NOT match an absent trim and suggests nearest in-stock trims", () => {
    const r = classifyTrimAvailability("Touring", accord);
    expect(r.matched).toBe(false);
    expect(r.suggestions.length).toBeGreaterThan(0);
    // all suggestions are real in-stock trims
    expect(r.suggestions.every((s) => accord.includes(s))).toBe(true);
  });

  it("EX-L (a real hybrid trim) absent from a gas-only lineup → not matched, suggested from inventory", () => {
    const r = classifyTrimAvailability("EX-L", accord);
    expect(r.matched).toBe(false);
    expect(r.suggestions.every((s) => accord.includes(s))).toBe(true);
  });

  it("empty inventory → not matched, no suggestions (caller suspends/asks, never auto-rejects)", () => {
    expect(classifyTrimAvailability("LX", [])).toEqual({ matched: false, suggestions: [] });
  });

  it("null/blank requested trim → not matched, surfaces the in-stock options", () => {
    const r = classifyTrimAvailability(null, accord);
    expect(r.matched).toBe(false);
    expect(r.suggestions.length).toBeGreaterThan(0);
  });
});
