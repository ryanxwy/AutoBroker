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
      "intake_confirm",
      "ambiguous_location",
      "location_failure",
    ]) {
      expect(gateTrack(kind)).toBe("rail");
    }
  });

  it("routes the batch-review family to the rail (it renders inline in the turn)", () => {
    expect(gateTrack("batch_review")).toBe("rail");
  });

  it("routes an unknown or missing kind to the rail (its fallback card renders)", () => {
    expect(gateTrack("brand_new_kind")).toBe("rail");
    expect(gateTrack(null)).toBe("rail");
  });

  it("routes the reserved banner kinds to the banner", () => {
    for (const kind of ["approval", "confirmation_gate"]) {
      expect(gateTrack(kind)).toBe("banner");
    }
  });
});
