/**
 * portfolioSummary — the header-by-counts derivation. Freezes: searches count,
 * NEED APPROVAL from the queue length, ghosted from the profileHealth
 * all_threads_capped reason, healthy = unflagged, and red NAMES from the
 * action-required queue items.
 */

import { describe, expect, it } from "vitest";

import type { ApprovalItem, PortfolioCard } from "../api/wire.js";
import { summarizePortfolio } from "./portfolioSummary.js";

function card(over: Partial<PortfolioCard>): PortfolioCard {
  return {
    searchProfileId: "p",
    vehicle: "2026 Honda Accord LX",
    city: "Seattle, WA",
    dealerCount: 1,
    bestOtd: null,
    lastActivityAt: null,
    stage: "scan",
    health: "warm",
    reasons: [],
    ...over,
  };
}

function item(over: Partial<ApprovalItem>): ApprovalItem {
  return {
    kind: "gate",
    profileId: "p",
    runId: "r",
    decisionId: "d",
    skill: "dealer_web_lead_submit",
    reason: "lead_submit",
    actionRequired: true,
    summary: { heading: "2026 Honda Accord LX", lines: [] },
    ...over,
  };
}

describe("summarizePortfolio", () => {
  it("counts searches, need-approval, ghosted, healthy and names red", () => {
    const cards = [
      card({ searchProfileId: "a", vehicle: "A Camry" }),
      card({ searchProfileId: "b", vehicle: "B Accord" }),
      card({ searchProfileId: "c", vehicle: "C RAV4", health: "cold", reasons: ["all_threads_capped"] }),
      card({ searchProfileId: "d", vehicle: "D Civic" }),
    ];
    const items = [
      item({ profileId: "a", runId: "ra", reason: "lead_submit", actionRequired: true, summary: { heading: "A Camry", lines: [] } }),
      // a reviewable (non-action-required) read gate on b
      item({ profileId: "b", runId: "rb", skill: "dealer_inbox_check", reason: "inbox", actionRequired: false, summary: { heading: "B Accord", lines: [] } }),
    ];
    const s = summarizePortfolio(cards, items);
    expect(s.searches).toBe(4);
    expect(s.needApproval).toBe(2); // both queue items
    expect(s.ghosted).toBe(1); // card c (all_threads_capped)
    // healthy = not flagged (a,b have queue items; c is ghosted) ⇒ only d
    expect(s.healthy).toBe(1);
    // only the action-required item (a) is named red
    expect(s.redNames).toEqual(["A Camry"]);
  });

  it("is all-healthy with no queue items and no ghosting", () => {
    const cards = [card({ searchProfileId: "a" }), card({ searchProfileId: "b" })];
    const s = summarizePortfolio(cards, []);
    expect(s).toMatchObject({ searches: 2, needApproval: 0, ghosted: 0, healthy: 2, redNames: [] });
  });
});
