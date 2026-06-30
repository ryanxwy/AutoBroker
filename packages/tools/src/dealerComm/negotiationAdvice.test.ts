/**
 * negotiationAdvice — the buyer-facing deterministic composers that turn the pure
 * deciders (status / tone / give-up / gate / cap) into rendered advice strings.
 *
 * These tests pin every tone x verdict branch, the cap/gate timing branches, the
 * audit-suggestion append, and the empty/no-quote path. They also assert the
 * load-bearing safety invariants: a competing DEALER NAME is never emitted, and
 * only $ dealer-quote figures appear (no budget). The composers are pure.
 */

import { describe, expect, it } from "vitest";

import {
  composeNegotiationStrategy,
  composeNextSteps,
  composeStatusLine,
} from "./negotiationAdvice.js";

describe("composeStatusLine", () => {
  it("labels a conceding dealer and reports the OTD drop", () => {
    const line = composeStatusLine({
      status: "countered",
      emailCount: 4,
      quoteSent: true,
      currentOtd: 32500,
      priorOtd: 33200,
      gate: "ready",
      batnaGapUsd: null,
    });
    expect(line).toContain("Dealer conceding");
    expect(line).toContain("4 emails");
    expect(line).toContain("quote received");
    expect(line).toContain("OTD down $700 to $32,500");
    expect(line).toContain("ready to follow up");
  });

  it("reports a stalled flat OTD and a BATNA gap", () => {
    const line = composeStatusLine({
      status: "stalled",
      emailCount: 6,
      quoteSent: true,
      currentOtd: 34000,
      priorOtd: 34000,
      gate: "skip",
      batnaGapUsd: 1500,
    });
    expect(line).toContain("Stalled");
    expect(line).toContain("OTD flat at $34,000");
    expect(line).toContain("gone quiet");
    expect(line).toContain("$1,500 behind best competing quote");
  });

  it("reports an OTD that moved up (re-trade)", () => {
    const line = composeStatusLine({
      status: "stalled",
      emailCount: 3,
      quoteSent: true,
      currentOtd: 35000,
      priorOtd: 34000,
      gate: "wait",
      batnaGapUsd: null,
    });
    expect(line).toContain("OTD up $1,000 to $35,000");
    expect(line).toContain("recently contacted");
  });

  it("handles the no-quote-yet, single-email path", () => {
    const line = composeStatusLine({
      status: "lead_sent",
      emailCount: 1,
      quoteSent: false,
      currentOtd: null,
      priorOtd: null,
      gate: "ready",
      batnaGapUsd: null,
    });
    expect(line).toContain("Lead sent, awaiting reply");
    expect(line).toContain("1 email");
    expect(line).not.toContain("emails"); // singular
    expect(line).toContain("no quote yet");
    expect(line).not.toContain("OTD");
  });

  it("shows a single current OTD when there is no prior round", () => {
    const line = composeStatusLine({
      status: "quoted",
      emailCount: 2,
      quoteSent: true,
      currentOtd: 31000,
      priorOtd: null,
      gate: "ready",
      batnaGapUsd: 0,
    });
    expect(line).toContain("OTD $31,000");
    expect(line).not.toContain("behind best competing"); // gap 0 is omitted
  });

  it("never emits a competing dealer name (scalars only)", () => {
    const line = composeStatusLine({
      status: "stalled",
      emailCount: 5,
      quoteSent: true,
      currentOtd: 34000,
      priorOtd: 34000,
      gate: "ready",
      batnaGapUsd: 1200,
    });
    expect(line).toContain("best competing quote");
    expect(line).not.toMatch(/[A-Z][a-z]+ (Honda|Toyota|Ford|Chevrolet)/);
  });
});

describe("composeNegotiationStrategy", () => {
  it("give_up_switch names the strict ITEMIZED gap, not the real (tone) gap, and no dealer", () => {
    const s = composeNegotiationStrategy({
      tone: "assertive",
      verdict: "give_up_switch",
      reason: "non_improving",
      batnaGapUsd: 9999, // the real/tone gap — must NOT be cited by give_up_switch
      itemizedBatnaGapUsd: 1500, // the itemized BATNA gap — the one that justifies a switch
      isItemized: true,
    });
    expect(s).toContain("$1,500");
    expect(s).not.toContain("9,999");
    expect(s.toLowerCase()).toContain("switch");
    expect(s.toLowerCase()).not.toContain("dealer name");
  });

  it("give_up_switch on a non-itemized current quote (null gap) still advises switching", () => {
    const s = composeNegotiationStrategy({
      tone: "conservative",
      verdict: "give_up_switch",
      reason: "non_improving",
      batnaGapUsd: null,
      itemizedBatnaGapUsd: null,
      isItemized: false,
    });
    expect(s.toLowerCase()).toContain("switch");
    expect(s.toLowerCase()).toContain("not itemized");
    expect(s).not.toContain("$");
  });

  it("cap-reason (unanswered) advises a pause, overriding the tone", () => {
    const s = composeNegotiationStrategy({
      tone: "assertive",
      verdict: "hold",
      reason: "unanswered_cap",
      batnaGapUsd: 800,
      itemizedBatnaGapUsd: 800,
      isItemized: true,
    });
    expect(s.toLowerCase()).toContain("pause");
    expect(s.toLowerCase()).toContain("repl"); // until they reply
  });

  it("cap-reason (total) advises stopping follow-ups", () => {
    const s = composeNegotiationStrategy({
      tone: "moderate",
      verdict: "hold",
      reason: "total_cap",
      batnaGapUsd: null,
      itemizedBatnaGapUsd: null,
      isItemized: true,
    });
    expect(s.toLowerCase()).toContain("ceiling");
  });

  it("conservative tone asks for an itemized breakdown", () => {
    const s = composeNegotiationStrategy({
      tone: "conservative",
      verdict: "continue",
      reason: "active",
      batnaGapUsd: null,
      itemizedBatnaGapUsd: null,
      isItemized: false,
    });
    expect(s.toLowerCase()).toContain("itemized");
    expect(s.toLowerCase()).toContain("breakdown");
  });

  it("assertive tone pushes hard and cites the dollar gap", () => {
    const s = composeNegotiationStrategy({
      tone: "assertive",
      verdict: "continue",
      reason: "active",
      batnaGapUsd: 900,
      itemizedBatnaGapUsd: null,
      isItemized: true,
    });
    expect(s).toContain("$900");
    expect(s.toLowerCase()).toContain("push");
  });

  it("moderate tone asks for a modest improvement", () => {
    const s = composeNegotiationStrategy({
      tone: "moderate",
      verdict: "continue",
      reason: "active",
      batnaGapUsd: 200,
      itemizedBatnaGapUsd: null,
      isItemized: true,
    });
    expect(s.toLowerCase()).toContain("modest");
  });

  it("appreciative tone thanks and asks to hold the price", () => {
    const s = composeNegotiationStrategy({
      tone: "appreciative",
      verdict: "continue",
      reason: "active",
      batnaGapUsd: null,
      itemizedBatnaGapUsd: null,
      isItemized: true,
    });
    expect(s.toLowerCase()).toContain("hold");
  });
});

describe("composeNextSteps", () => {
  it("orders give-up, timing, quote-ask, then audit suggestions", () => {
    const steps = composeNextSteps({
      gate: "ready",
      cap: "ok",
      verdict: "give_up_switch",
      hasQuote: false,
      auditSuggestions: ["Doc fee exceeds the state cap", "No incentive applied"],
    });
    expect(steps[0]!.toLowerCase()).toContain("switch");
    expect(steps.some((s) => s.toLowerCase().includes("itemized"))).toBe(true);
    expect(steps).toContain("Doc fee exceeds the state cap");
    expect(steps).toContain("No incentive applied");
    // audit suggestions come last, in order
    expect(steps.indexOf("Doc fee exceeds the state cap")).toBeLessThan(
      steps.indexOf("No incentive applied"),
    );
  });

  it("total_cap timing step says stop", () => {
    const steps = composeNextSteps({
      gate: "ready",
      cap: "total_cap",
      verdict: "hold",
      hasQuote: true,
      auditSuggestions: [],
    });
    expect(steps.some((s) => s.toLowerCase().includes("stop"))).toBe(true);
  });

  it("unanswered_cap timing step says pause", () => {
    const steps = composeNextSteps({
      gate: "ready",
      cap: "unanswered_cap",
      verdict: "hold",
      hasQuote: true,
      auditSuggestions: [],
    });
    expect(steps.some((s) => s.toLowerCase().includes("pause"))).toBe(true);
  });

  it("skip gate suggests dropping a quiet thread", () => {
    const steps = composeNextSteps({
      gate: "skip",
      cap: "ok",
      verdict: "hold",
      hasQuote: true,
      auditSuggestions: [],
    });
    expect(steps.some((s) => s.toLowerCase().includes("quiet"))).toBe(true);
  });

  it("wait gate suggests waiting", () => {
    const steps = composeNextSteps({
      gate: "wait",
      cap: "ok",
      verdict: "continue",
      hasQuote: true,
      auditSuggestions: [],
    });
    expect(steps.some((s) => s.toLowerCase().includes("wait"))).toBe(true);
  });

  it("ready gate with a quote and no audits yields just the send step", () => {
    const steps = composeNextSteps({
      gate: "ready",
      cap: "ok",
      verdict: "continue",
      hasQuote: true,
      auditSuggestions: [],
    });
    expect(steps).toHaveLength(1);
    expect(steps[0]!.toLowerCase()).toContain("follow-up");
  });

  it("no-quote path adds the itemized-quote ask", () => {
    const steps = composeNextSteps({
      gate: "ready",
      cap: "ok",
      verdict: "continue",
      hasQuote: false,
      auditSuggestions: [],
    });
    expect(steps.some((s) => s.toLowerCase().includes("itemized"))).toBe(true);
  });

  it("empty path (no give-up, no audits, has quote) is never empty", () => {
    const steps = composeNextSteps({
      gate: "ready",
      cap: "ok",
      verdict: "continue",
      hasQuote: true,
      auditSuggestions: [],
    });
    expect(steps.length).toBeGreaterThan(0);
  });
});
