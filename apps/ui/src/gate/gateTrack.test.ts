/**
 * gateTrack.test — the single kind→track routing point. The rail keeps its
 * wire kinds (and the unknown fallback — a gate is never silently hidden);
 * only the reserved banner kinds route to the app-level banner host.
 */

import { describe, expect, it } from "vitest";

import { gateTrack } from "./gateTrack.js";

describe("gateTrack — kind → surface routing", () => {
  it("routes the rail wire kinds (and the client-side split) to the rail", () => {
    for (const kind of [
      "data_collection",
      "force_override",
      "ambiguous_location",
      "location_failure",
      "malformed_tool_call",
    ]) {
      expect(gateTrack(kind)).toBe("rail");
    }
  });

  it("routes an unknown or missing kind to the rail (its fallback card renders)", () => {
    expect(gateTrack("brand_new_kind")).toBe("rail");
    expect(gateTrack(null)).toBe("rail");
  });

  it("routes the reserved banner kinds to the banner", () => {
    for (const kind of ["approval", "batch_review", "typed_yes"]) {
      expect(gateTrack(kind)).toBe("banner");
    }
  });
});
