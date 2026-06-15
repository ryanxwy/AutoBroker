/**
 * The quote-situation tone ladder. Pins each rung's exact threshold, especially
 * the assertive boundary (STRICTLY greater than the delta), so a quote sitting
 * exactly at the threshold reads as moderate, not assertive.
 */

import { describe, expect, it } from "vitest";

import { classifyQuoteSituation } from "./quoteSituation.js";

describe("classifyQuoteSituation", () => {
  it("conservative when the OTD is not itemized", () => {
    expect(
      classifyQuoteSituation({ isItemized: false, bestCompetingOtd: 30000, currentOtd: 40000 }),
    ).toBe("conservative");
  });

  it("appreciative when either side's OTD is unknown", () => {
    expect(
      classifyQuoteSituation({ isItemized: true, bestCompetingOtd: null, currentOtd: 40000 }),
    ).toBe("appreciative");
    expect(
      classifyQuoteSituation({ isItemized: true, bestCompetingOtd: 30000, currentOtd: null }),
    ).toBe("appreciative");
  });

  it("appreciative when the current quote is at or under the best competing", () => {
    expect(
      classifyQuoteSituation({ isItemized: true, bestCompetingOtd: 30000, currentOtd: 30000 }),
    ).toBe("appreciative");
    expect(
      classifyQuoteSituation({ isItemized: true, bestCompetingOtd: 30000, currentOtd: 29000 }),
    ).toBe("appreciative");
  });

  it("assertive only when the delta is STRICTLY greater than the threshold", () => {
    expect(
      classifyQuoteSituation({ isItemized: true, bestCompetingOtd: 30000, currentOtd: 30501 }),
    ).toBe("assertive");
    // exactly the threshold is NOT assertive.
    expect(
      classifyQuoteSituation({ isItemized: true, bestCompetingOtd: 30000, currentOtd: 30500 }),
    ).toBe("moderate");
  });

  it("moderate for a small positive delta within the threshold", () => {
    expect(
      classifyQuoteSituation({ isItemized: true, bestCompetingOtd: 30000, currentOtd: 30100 }),
    ).toBe("moderate");
  });
});
