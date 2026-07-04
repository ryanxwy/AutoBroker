import { describe, expect, it } from "vitest";

import {
  classifyTrimAvailability,
  normalizeTrim,
  resegmentModelTrim,
  trimSubsetMatch,
} from "./trimMatch.js";

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

describe("resegmentModelTrim", () => {
  it("re-splits when the model/trim boundary drifted into the trim", () => {
    expect(resegmentModelTrim("Tucson Hybrid", "Tucson", "Hybrid Limited")).toEqual({
      model: "Tucson Hybrid",
      trim: "Limited",
    });
  });

  it("re-splits a trim-less compound model", () => {
    expect(resegmentModelTrim("Tucson Hybrid", "TUCSON Hybrid Limited", null)).toEqual({
      model: "TUCSON Hybrid",
      trim: "Limited",
    });
  });

  it("is a no-op when the extracted model already equals the profile model", () => {
    expect(resegmentModelTrim("Tucson Hybrid", "TUCSON Hybrid", "Limited")).toEqual({
      model: "TUCSON Hybrid",
      trim: "Limited",
    });
  });

  it("passes through when the token stream does NOT start with the profile model", () => {
    expect(resegmentModelTrim("Tucson Hybrid", "Santa Fe", "Limited")).toEqual({
      model: "Santa Fe",
      trim: "Limited",
    });
    // Prefix present but too short to cover all profile tokens → unchanged.
    expect(resegmentModelTrim("Tucson Hybrid", "Tucson", null)).toEqual({
      model: "Tucson",
      trim: null,
    });
  });

  it("null trim is preserved on the pass-through / no-op paths", () => {
    expect(resegmentModelTrim("Tucson Hybrid", null, null)).toEqual({
      model: null,
      trim: null,
    });
    // Re-split yields a null trim when nothing remains after the model boundary.
    expect(resegmentModelTrim("Tucson Hybrid", "Tucson", "Hybrid")).toEqual({
      model: "Tucson Hybrid",
      trim: null,
    });
  });

  it("REFUSES to move a powertrain word OUT of the model (different model, not a trim)", () => {
    // A real "Tucson Hybrid" against a plain "Tucson" profile must stay a
    // model mismatch — shortening it would upgrade it to near (and "hybrid"
    // is a trimSubsetMatch noise token, so the mis-split could even pass a
    // trim-subset keep).
    expect(resegmentModelTrim("Tucson", "Tucson Hybrid", "Limited")).toEqual({
      model: "Tucson Hybrid",
      trim: "Limited",
    });
    expect(resegmentModelTrim("Kona", "Kona Electric", null)).toEqual({
      model: "Kona Electric",
      trim: null,
    });
    // Whole-string variant with no trim at all: same refusal.
    expect(resegmentModelTrim("Tucson", "Tucson Hybrid Limited", null)).toEqual({
      model: "Tucson Hybrid Limited",
      trim: null,
    });
    // The guard is asymmetric: pulling the powertrain word INTO the model
    // (the shipped drift rescue) still works…
    expect(resegmentModelTrim("Tucson Hybrid", "Tucson", "Hybrid Limited")).toEqual({
      model: "Tucson Hybrid",
      trim: "Limited",
    });
    // …and moving a NON-powertrain token out (over-run model) still works.
    expect(resegmentModelTrim("Tucson Hybrid", "Tucson Hybrid Limited", null)).toEqual({
      model: "Tucson Hybrid",
      trim: "Limited",
    });
  });
});
