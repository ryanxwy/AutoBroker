/**
 * gateModel.test — the suspend-payload classifier (FRONTEND_LAYOUT §8.2). Each
 * spec_inline.kind maps to the right gate variant, and the 裁定⑨ split (empty
 * candidates + failure_reason → location_failure) is exercised.
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

  it("force_override → question/trim/reason", () => {
    const g = classifyGate({ kind: "force_override", question: "Keep it?", trim: "GT-X", reason: "unverified" });
    expect(g.kind).toBe("force_override");
    if (g.kind === "force_override") {
      expect(g.trim).toBe("GT-X");
      expect(g.reason).toBe("unverified");
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

  it("裁定⑨: empty candidates + failure_reason → location_failure", () => {
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

  it("malformed_tool_call → signals", () => {
    const g = classifyGate({ kind: "malformed_tool_call", signals: ["finish_reason!=tool_calls"] });
    expect(g.kind).toBe("malformed_tool_call");
    if (g.kind === "malformed_tool_call") expect(g.signals).toEqual(["finish_reason!=tool_calls"]);
  });

  it("null / unknown spec → unknown (never throws)", () => {
    expect(classifyGate(null).kind).toBe("unknown");
    expect(classifyGate({ kind: "weird" }).kind).toBe("unknown");
  });
});
