import { describe, expect, it } from "vitest";

import { assertRoutingInvariance } from "./metamorphic.js";

describe("assertRoutingInvariance (T4-U4 metamorphic)", () => {
  it("PASS when every perturbation routes to the same skill", () => {
    const r = assertRoutingInvariance({
      expectedSkillId: "dealer_geosearch",
      routedTurns: [
        { nlText: "find dealers near me", routedSkillId: "dealer_geosearch" },
        { nlText: "dealrs near me pls", routedSkillId: "dealer_geosearch" },
        { nlText: "who sells these around here", routedSkillId: "dealer_geosearch" },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.assertionId).toBe("routing_invariance");
    expect(r.severity).toBe("red");
  });

  it("FAIL (RED) when a perturbation routes elsewhere or clarifies", () => {
    const r = assertRoutingInvariance({
      expectedSkillId: "dealer_geosearch",
      routedTurns: [
        { nlText: "find dealers near me", routedSkillId: "dealer_geosearch" },
        { nlText: "whats in stock", routedSkillId: "inventory_site_scan" },
        { nlText: "do the thing", routedSkillId: null },
      ],
    });
    expect(r.ok).toBe(false);
    expect(String(r.observed)).toContain("inventory_site_scan");
    expect(String(r.observed)).toContain("clarify");
  });

  it("FAIL on zero captured turns (a vacuous pass is not a pass)", () => {
    const r = assertRoutingInvariance({ expectedSkillId: "dealer_geosearch", routedTurns: [] });
    expect(r.ok).toBe(false);
  });
});
