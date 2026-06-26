/**
 * Unit tests — the pure dealer give-up / switch verdict. A table over the
 * (gate, cap, trajectory, itemization, current/competing OTD) space, asserting
 * the verdict + dominant reason for every branch, including the guards against
 * abandoning a good dealer on noise (small sample, marginal competitor, the
 * anti-pester cap) and the no-sticky-give-up reactivation case.
 */

import { describe, expect, it } from "vitest";
import { dealerGiveUpDecision, type GiveUpInput } from "./giveUp.js";

function input(over: Partial<GiveUpInput> = {}): GiveUpInput {
  return {
    gate: "ready",
    cap: "ok",
    otdTrajectory: [],
    isItemized: true,
    currentOtd: null,
    bestCompetingOtd: null,
    ...over,
  };
}

describe("dealerGiveUpDecision", () => {
  const cases: Array<{
    name: string;
    in: GiveUpInput;
    verdict: "continue" | "hold" | "give_up_switch";
    reason: string;
  }> = [
    {
      name: "actively conceding + cheaper competitor → continue (never abandon a moving dealer)",
      in: input({ otdTrajectory: [44000, 45000, 46000], currentOtd: 44000, bestCompetingOtd: 43000 }),
      verdict: "continue",
      reason: "active",
    },
    {
      name: "cold (gate=skip) + itemized competitor >=$500 lower → give_up_switch (silent)",
      in: input({ gate: "skip", currentOtd: 44000, bestCompetingOtd: 43000 }),
      verdict: "give_up_switch",
      reason: "silent",
    },
    {
      name: "cold but NO competitor → hold (don't abandon your only live quote)",
      in: input({ gate: "skip", currentOtd: 44000, bestCompetingOtd: null }),
      verdict: "hold",
      reason: "silent",
    },
    {
      name: "anti-pester unanswered_cap + cheaper competitor → hold, NOT switch (auto-resumes on reply)",
      in: input({ cap: "unanswered_cap", currentOtd: 44000, bestCompetingOtd: 43000 }),
      verdict: "hold",
      reason: "unanswered_cap",
    },
    {
      name: "wait gate (too soon to follow up) + cheaper competitor → continue (wait is not a give-up signal)",
      in: input({ gate: "wait", currentOtd: 44000, bestCompetingOtd: 43000 }),
      verdict: "continue",
      reason: "active",
    },
    {
      name: "flat trajectory (non_improving) + cheaper itemized competitor → give_up_switch",
      in: input({ otdTrajectory: [46000, 46000, 46000], currentOtd: 46000, bestCompetingOtd: 45000 }),
      verdict: "give_up_switch",
      reason: "non_improving",
    },
    {
      name: "flat trajectory but NO competitor → hold",
      in: input({ otdTrajectory: [46000, 46000, 46000], currentOtd: 46000, bestCompetingOtd: null }),
      verdict: "hold",
      reason: "non_improving",
    },
    {
      name: "re-trade (OTD jumped up >$500) + cheaper competitor → give_up_switch",
      in: input({ otdTrajectory: [46000, 45000], currentOtd: 46000, bestCompetingOtd: 45000 }),
      verdict: "give_up_switch",
      reason: "retrade",
    },
    {
      name: "small sample (1 quote) cheaper competitor but ready+ok → continue (no cold-start abandonment)",
      in: input({ otdTrajectory: [44000], currentOtd: 44000, bestCompetingOtd: 43000 }),
      verdict: "continue",
      reason: "active",
    },
    {
      name: "non-itemized current (monthly-only stonewaller) + cold + itemized competitor → give_up_switch",
      in: input({ gate: "skip", isItemized: false, currentOtd: null, bestCompetingOtd: 43000 }),
      verdict: "give_up_switch",
      reason: "silent",
    },
    {
      name: "cold but competitor only marginally lower (<$500) → hold (gap below the BATNA margin)",
      in: input({ gate: "skip", currentOtd: 44000, bestCompetingOtd: 43800 }),
      verdict: "hold",
      reason: "silent",
    },
    {
      name: "reactivation: a now-conceding trajectory overrides any prior give-up → continue",
      in: input({ otdTrajectory: [43000, 44000, 45000], currentOtd: 43000, bestCompetingOtd: 42000 }),
      verdict: "continue",
      reason: "active",
    },
    {
      name: "total_cap (runaway ceiling) + cheaper competitor → hold, NOT switch",
      in: input({ cap: "total_cap", currentOtd: 44000, bestCompetingOtd: 43000 }),
      verdict: "hold",
      reason: "total_cap",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const d = dealerGiveUpDecision(c.in);
      expect(d.verdict).toBe(c.verdict);
      expect(d.reason).toBe(c.reason);
    });
  }

  it("reports the BATNA gap in dollars when both OTDs are comparable", () => {
    const d = dealerGiveUpDecision(input({ gate: "skip", currentOtd: 44000, bestCompetingOtd: 43000 }));
    expect(d.verdict).toBe("give_up_switch");
    expect(d.batnaGapUsd).toBe(1000);
  });

  it("has no BATNA gap when the current quote is not itemized (no comparable OTD)", () => {
    const d = dealerGiveUpDecision(input({ gate: "skip", isItemized: false, currentOtd: null, bestCompetingOtd: 43000 }));
    expect(d.verdict).toBe("give_up_switch");
    expect(d.batnaGapUsd).toBeNull();
  });

  it("never yields give_up_switch without a competing quote (BATNA guard)", () => {
    for (const gate of ["skip", "ready"] as const) {
      for (const traj of [[46000, 46000, 46000], [46000, 45000], [44000]]) {
        const d = dealerGiveUpDecision(input({ gate, otdTrajectory: traj, currentOtd: 46000, bestCompetingOtd: null }));
        expect(d.verdict).not.toBe("give_up_switch");
      }
    }
  });
});
