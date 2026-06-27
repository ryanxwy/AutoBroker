import { describe, expect, it } from "vitest";

import { classifyColorAvailability, colorTokenMatch, normalizeColor } from "./colorMatch.js";

describe("normalizeColor", () => {
  it("lower-cases, trims, and collapses internal whitespace", () => {
    expect(normalizeColor("  Radiant   RED  ")).toBe("radiant red");
    expect(normalizeColor("Phantom Black Pearl")).toBe("phantom black pearl");
  });
  it("strips nothing semantic — every word is kept", () => {
    expect(normalizeColor("Metallic Red II")).toBe("metallic red ii");
  });
});

describe("colorTokenMatch (whole-token, not substring)", () => {
  it("matches a loose color against the canonical name that contains it as a token", () => {
    expect(colorTokenMatch("red", "Radiant Red Metallic II")).toBe(true);
    expect(colorTokenMatch("black", "Phantom Black Pearl")).toBe(true);
    expect(colorTokenMatch("radiant red", "Radiant Red Metallic II")).toBe(true);
  });
  it("does NOT match a substring that is not a whole token", () => {
    // 'blue' is a substring of 'Bluestone' but not a token of it.
    expect(colorTokenMatch("blue", "Bluestone")).toBe(false);
    // 'red' is a substring of 'Predator' but not a token of it.
    expect(colorTokenMatch("red", "Predator Edition")).toBe(false);
  });
  it("is false for an empty requested color", () => {
    expect(colorTokenMatch("", "Radiant Red Metallic II")).toBe(false);
  });
});

describe("classifyColorAvailability", () => {
  const colors = ["Radiant Red Metallic II", "Bluestone", "Phantom Black Pearl"];

  it("suggests the canonical descriptor name for a loose color (red → Radiant Red Metallic II)", () => {
    const [r] = classifyColorAvailability(["red"], colors);
    expect(r!.requested).toBe("red");
    expect(r!.matched).toBe(true);
    expect(r!.suggestions).toEqual(["Radiant Red Metallic II"]);
  });

  it("does NOT match a substring-only overlap (blue ⊄ Bluestone)", () => {
    const [r] = classifyColorAvailability(["blue"], colors);
    expect(r!.matched).toBe(false);
    expect(r!.suggestions).toEqual([]);
  });

  it("classifies multiple requested colors independently", () => {
    const res = classifyColorAvailability(["red", "blue"], colors);
    expect(res).toHaveLength(2);
    expect(res[0]!.matched).toBe(true);
    expect(res[0]!.suggestions).toEqual(["Radiant Red Metallic II"]);
    expect(res[1]!.matched).toBe(false);
    expect(res[1]!.suggestions).toEqual([]);
  });

  it("returns matched:false with no suggestions when nothing overlaps", () => {
    const [r] = classifyColorAvailability(["chartreuse"], colors);
    expect(r!.matched).toBe(false);
    expect(r!.suggestions).toEqual([]);
  });

  it("skips blank requested colors and is empty for empty inputs", () => {
    expect(classifyColorAvailability([], [])).toEqual([]);
    expect(classifyColorAvailability(["", "   "], colors)).toEqual([]);
    expect(classifyColorAvailability([], colors)).toEqual([]);
    // No inventory → a row with no suggestions (caller drops it as non-actionable).
    expect(classifyColorAvailability(["red"], [])).toEqual([
      { requested: "red", matched: false, suggestions: [] },
    ]);
  });
});
