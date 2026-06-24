/**
 * portfolioSummary — the header-by-counts derivation. Freezes: searches count,
 * NEED APPROVAL from non-fail-closed inbox items, fail-closed split out, ghosted
 * from health reasons, healthy = unflagged, and red NAMES from the inbox.
 */

import { describe, expect, it } from "vitest";

import type { ApprovalInboxItem, PortfolioCard } from "../api/wire.js";
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

function item(over: Partial<ApprovalInboxItem>): ApprovalInboxItem {
  return {
    profileId: "p",
    runId: "r",
    decisionId: "d",
    reason: "batch_review",
    vehicle: "2026 Honda Accord LX",
    summary: "needs approval",
    ...over,
  };
}

describe("summarizePortfolio", () => {
  it("counts searches, need-approval, fail-closed, ghosted, healthy and names red", () => {
    const cards = [
      card({ searchProfileId: "a", vehicle: "A Camry" }),
      card({ searchProfileId: "b", vehicle: "B Accord" }),
      card({ searchProfileId: "c", vehicle: "C RAV4", reasons: ["ghosted"] }),
      card({ searchProfileId: "d", vehicle: "D Civic" }),
    ];
    const items = [
      item({ profileId: "a", runId: "ra", reason: "batch_review", vehicle: "A Camry" }),
      item({ profileId: "b", runId: "rb", reason: "fail_closed", vehicle: "B Accord" }),
    ];
    const s = summarizePortfolio(cards, items);
    expect(s.searches).toBe(4);
    expect(s.needApproval).toBe(1); // only the batch_review item
    expect(s.failClosed).toBe(1); // the fail_closed item
    expect(s.ghosted).toBe(1); // card c
    // healthy = not flagged (a,b are inbox-flagged; c is ghosted) ⇒ only d
    expect(s.healthy).toBe(1);
    expect(s.redNames).toEqual(["A Camry", "B Accord"]);
  });

  it("is all-healthy with no inbox items and no ghosting", () => {
    const cards = [card({ searchProfileId: "a" }), card({ searchProfileId: "b" })];
    const s = summarizePortfolio(cards, []);
    expect(s).toMatchObject({ searches: 2, needApproval: 0, failClosed: 0, ghosted: 0, healthy: 2, redNames: [] });
  });
});
