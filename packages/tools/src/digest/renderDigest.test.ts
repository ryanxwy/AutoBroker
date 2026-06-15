/**
 * L1 unit tests — the digest renderer + headline + the SEMANTIC budget
 * red-line. Freezes:
 *   - the 7-slot template fill (profile / dealers / quotes / freshness /
 *     next-actions all present for a populated payload);
 *   - the exact `_NO_ACTIVE_SEARCHES` text on an empty payload;
 *   - the headline carries counts + best OTD, no budget;
 *   - rendered text + headline pass assertNoBudget (the digest is "technically
 *     outbound" → budget deliberately not surfaced);
 *   - assertNoBudget catches a LITERAL dollar budget AND a PARAPHRASED leak
 *     ("around three thousand dollars" / "your max is 35k") — NOT a bare '$'.
 */

import { describe, expect, it } from "vitest";

import { assertNoBudget, BudgetLeakError } from "../validators.js";
import type { DigestPayload } from "./generateDigest.js";
import { digestHeadline, renderDigestText, NO_ACTIVE_SEARCHES_TEXT } from "./renderDigest.js";

function emptyPayload(): DigestPayload {
  return {
    state: "_NO_ACTIVE_SEARCHES",
    generatedAtMs: 1_750_000_000_000,
    sinceHours: null,
    profiles: [],
    nextActions: [],
    overallBestOtd: null,
  };
}

function populatedPayload(): DigestPayload {
  return {
    state: "ok",
    generatedAtMs: 1_750_000_000_000,
    sinceHours: null,
    profiles: [
      {
        searchProfileId: "p1",
        vehicle: "2026 Hyundai Tucson SEL",
        dealerCount: 3,
        boundDealerCount: 1,
        threadCount: 4,
        needsResponseCount: 2,
        unansweredQuestionCount: 1,
        offers: [
          {
            quoteId: "q1",
            dealerId: "d1",
            dealerName: "Alpha Hyundai",
            otdTotal: 38000,
            financingMode: "cash",
            freshness: "fresh",
          },
          {
            quoteId: "q2",
            dealerId: "d2",
            dealerName: "Beta Hyundai",
            otdTotal: 41000,
            financingMode: "finance",
            freshness: "stale",
          },
        ],
        totalQuotes: 2,
        bestOtd: 38000,
        freshnessMix: { fresh: 5, stale: 2, missing: 1 },
      },
    ],
    nextActions: [
      {
        kind: "needs_response",
        profileId: "p1",
        vehicle: "2026 Hyundai Tucson SEL",
        count: 2,
        label: "2026 Hyundai Tucson SEL: 2 dealer reply(ies) need a response.",
      },
      {
        kind: "unanswered_question",
        profileId: "p1",
        vehicle: "2026 Hyundai Tucson SEL",
        count: 1,
        label: "2026 Hyundai Tucson SEL: 1 dealer question(s) await your input.",
      },
    ],
    overallBestOtd: 38000,
  };
}

describe("renderDigestText — empty state", () => {
  it("renders the exact _NO_ACTIVE_SEARCHES text", () => {
    const text = renderDigestText(emptyPayload());
    expect(text).toContain(NO_ACTIVE_SEARCHES_TEXT);
    expect(NO_ACTIVE_SEARCHES_TEXT).toBe("No active searches to summarize.");
  });
});

describe("renderDigestText — 7-slot fill", () => {
  it("fills profile, dealers, quotes, freshness and next-actions slots", () => {
    const text = renderDigestText(populatedPayload());
    expect(text).toContain("2026 Hyundai Tucson SEL"); // slot 1 profile
    expect(text).toContain("Today's progress");
    expect(text).toContain("**Dealers**"); // slot 2
    expect(text).toContain("1 bound");
    expect(text).toContain("**Quotes**"); // slot 3
    expect(text).toContain("Alpha Hyundai");
    expect(text).toContain("$38,000"); // best OTD rendered (dealer price, not budget)
    expect(text).toContain("listing fresh");
    expect(text).toContain("**Inventory freshness**"); // slot 6
    expect(text).toContain("5 fresh, 2 stale, 1 missing");
    expect(text).toContain("## Next actions"); // slot 7
    expect(text).toContain("need a response");
    expect(text).toContain("await your input");
  });

  it("no-offers profile renders the status-only quotes line", () => {
    const payload = populatedPayload();
    payload.profiles[0]!.offers = [];
    payload.profiles[0]!.totalQuotes = 0;
    payload.profiles[0]!.bestOtd = null;
    const text = renderDigestText(payload);
    expect(text).toContain("no captured quotes yet");
  });
});

describe("digestHeadline", () => {
  it("carries counts + best OTD, no budget", () => {
    const headline = digestHeadline(populatedPayload());
    expect(headline).toContain("1 active search");
    expect(headline).toContain("2 quote");
    expect(headline).toContain("$38,000");
    expect(headline).toContain("2 awaiting your response");
    expect(() => assertNoBudget(headline)).not.toThrow();
  });

  it("empty payload → intake pointer headline", () => {
    expect(digestHeadline(emptyPayload())).toContain("intake");
  });
});

describe("budget red-line — rendered digest passes assertNoBudget", () => {
  it("the rendered text + headline are budget-clean (OTD prices are not budget)", () => {
    const payload = populatedPayload();
    expect(() => assertNoBudget(renderDigestText(payload))).not.toThrow();
    expect(() => assertNoBudget(digestHeadline(payload))).not.toThrow();
  });
});

describe("budget red-line — semantic detection (positive + paraphrased)", () => {
  it("POSITIVE: a literal dollar budget figure trips assertNoBudget", () => {
    expect(() => assertNoBudget("My budget is $35,000 for this Tucson.")).toThrow(BudgetLeakError);
    expect(() => assertNoBudget("your max is 35k")).toThrow(BudgetLeakError);
  });

  it("PARAPHRASED: a spelled-out dollar leak is ALSO caught (not a bare $ match)", () => {
    // No digit, no $ — the digit-anchored patterns alone would miss these.
    expect(() => assertNoBudget("I can spend around three thousand dollars.")).toThrow(
      BudgetLeakError,
    );
    expect(() => assertNoBudget("My budget is about thirty thousand dollars.")).toThrow(
      BudgetLeakError,
    );
    expect(() => assertNoBudget("max around twenty grand")).toThrow(BudgetLeakError);
  });

  it("NEGATIVE: a plain dealer price ask is NOT flagged (no budget framing)", () => {
    expect(() =>
      assertNoBudget("Please send your best out-the-door price on this Tucson."),
    ).not.toThrow();
    // A spelled number with no money tag is not a budget leak.
    expect(() => assertNoBudget("The dealer is three miles away.")).not.toThrow();
  });
});
