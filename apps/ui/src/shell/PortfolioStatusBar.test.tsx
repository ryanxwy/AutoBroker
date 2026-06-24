// @vitest-environment happy-dom
/**
 * PortfolioStatusBar — the multi-profile header strip. Freezes:
 *   - ABSENT with 0/1 active searches (single-active path byte-identical);
 *   - present with 2+ searches, reporting COUNTS (not a blended color);
 *   - NAMES the red profiles (parked gate / fail-closed).
 */

import { describe, expect, it } from "vitest";

import type { ApprovalItem, PortfolioCard } from "../api/wire.js";
import { render } from "../test/render.js";
import { PortfolioStatusBar } from "./PortfolioStatusBar.js";

function card(over: Partial<PortfolioCard>): PortfolioCard {
  return {
    searchProfileId: "p",
    vehicle: "V",
    city: "",
    dealerCount: 0,
    bestOtd: null,
    lastActivityAt: null,
    stage: "intake",
    health: "warm",
    reasons: [],
    ...over,
  };
}

describe("PortfolioStatusBar", () => {
  it("renders nothing with a single active search (byte-identical single path)", () => {
    const r = render(<PortfolioStatusBar cards={[card({ searchProfileId: "a" })]} items={[]} />);
    expect(r.query("portfolio-status-bar")).toBeNull();
  });

  it("renders counts + names red profiles with 2+ active searches", () => {
    const cards = [card({ searchProfileId: "a", vehicle: "A Camry" }), card({ searchProfileId: "b", vehicle: "B Accord" })];
    const items: ApprovalItem[] = [
      { kind: "gate", profileId: "a", runId: "ra", decisionId: "da", skill: "dealer_web_lead_submit", reason: "lead_submit", actionRequired: true, summary: { heading: "A Camry", lines: [] } },
    ];
    const r = render(<PortfolioStatusBar cards={cards} items={items} />);
    expect(r.query("portfolio-status-bar")).not.toBeNull();
    expect(r.get("portfolio-status-link").textContent).toContain("2 searches");
    expect(r.get("portfolio-count-approval").textContent).toContain("1 NEED APPROVAL");
    expect(r.get("portfolio-count-healthy").textContent).toContain("1 healthy");
    expect(r.get("portfolio-status-names").textContent).toContain("A Camry");
  });
});
