/**
 * gateModel.test — the suspend-payload classifier. Each
 * spec_inline.kind maps to the right gate variant, and the location-failure split
 * (empty candidates + failure_reason → location_failure) is exercised.
 */

import { describe, expect, it } from "vitest";

import { classifyGate } from "./gateModel.js";

describe("gateModel — classification", () => {
  it("data_collection → seed fields", () => {
    const g = classifyGate({
      kind: "data_collection",
      form_kind: "intake",
      seed_fields: { make: "Hyundai" },
    });
    expect(g.kind).toBe("data_collection");
    if (g.kind === "data_collection") expect(g.seedFields).toEqual({ make: "Hyundai" });
  });

  it("intake_confirm → year/make/model/trim", () => {
    const g = classifyGate({ kind: "intake_confirm", year: 2026, make: "Hyundai", model: "Tucson", trim: "SEL" });
    expect(g.kind).toBe("intake_confirm");
    if (g.kind === "intake_confirm") {
      expect(g.year).toBe(2026);
      expect(g.make).toBe("Hyundai");
      expect(g.model).toBe("Tucson");
      expect(g.trim).toBe("SEL");
    }
  });

  it("ambiguous_location with candidates → picker", () => {
    const g = classifyGate({
      kind: "ambiguous_location",
      candidates: [
        { index: 0, label: "Irvine, CA, USA" },
        { index: 1, label: "Irvine, KY, USA" },
      ],
      failure_reason: null,
      effective_query: "Irvine",
    });
    expect(g.kind).toBe("ambiguous_location");
    if (g.kind === "ambiguous_location") {
      expect(g.candidates).toHaveLength(2);
      expect(g.candidates[1]!.label).toContain("KY");
    }
  });

  it("location-failure: empty candidates + failure_reason → location_failure", () => {
    const g = classifyGate({
      kind: "ambiguous_location",
      candidates: [],
      failure_reason: "no_result",
      effective_query: "asdfghjkl",
    });
    expect(g.kind).toBe("location_failure");
    if (g.kind === "location_failure") {
      expect(g.failureReason).toBe("no_result");
      expect(g.effectiveQuery).toBe("asdfghjkl");
    }
  });

  it("null / unknown spec → unknown (never throws)", () => {
    expect(classifyGate(null).kind).toBe("unknown");
    expect(classifyGate({ kind: "weird" }).kind).toBe("unknown");
  });
});
