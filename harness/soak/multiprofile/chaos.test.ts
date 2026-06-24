/**
 * chaos.test.ts — escalating chaos-schedule + aggressionDirectiveText. TDD.
 *
 * Invariants: reproducible (same seed+round → deep-equal); monotonic non-decrease
 * round-over-round (ghost/badFaith/budgetProbe/profileCount/aggression); round 0 is
 * fully cooperative; dealerGroupCollision flips at round 1; caps hold; directive
 * text grows stronger with level and never contains real-send/browser verbs.
 *
 * Pure module — no DB, no framework.
 */

import { describe, expect, it } from "vitest";

import { aggressionDirectiveText, chaosScheduleForRound, type ChaosDirective } from "./chaos.js";
import { makePrng } from "./prng.js";

// ---------------------------------------------------------------------------
// reproducibility
// ---------------------------------------------------------------------------

describe("chaosScheduleForRound — reproducibility", () => {
  it("same seed + round → deep-equal directive", () => {
    const a = chaosScheduleForRound(3, makePrng(42));
    const b = chaosScheduleForRound(3, makePrng(42));
    expect(a).toEqual(b);
  });

  it("different rounds → generally different directives", () => {
    const d0 = chaosScheduleForRound(0, makePrng(42));
    const d3 = chaosScheduleForRound(3, makePrng(42));
    // At least one field must differ (they shouldn't be identical)
    const differs =
      d0.ghostProbability !== d3.ghostProbability ||
      d0.profileCount !== d3.profileCount ||
      d0.aggressionLevel !== d3.aggressionLevel;
    expect(differs).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// round 0 = cooperative base
// ---------------------------------------------------------------------------

describe("chaosScheduleForRound — round 0 is fully cooperative", () => {
  it("round 0: all probabilities are 0", () => {
    const d = chaosScheduleForRound(0, makePrng(1));
    expect(d.ghostProbability).toBe(0);
    expect(d.badFaithProbability).toBe(0);
    expect(d.budgetProbeProbability).toBe(0);
  });

  it("round 0: dealerGroupCollision is false", () => {
    const d = chaosScheduleForRound(0, makePrng(1));
    expect(d.dealerGroupCollision).toBe(false);
  });

  it("round 0: aggressionLevel is 0", () => {
    const d = chaosScheduleForRound(0, makePrng(1));
    expect(d.aggressionLevel).toBe(0);
  });

  it("round 0: round field is 0", () => {
    const d = chaosScheduleForRound(0, makePrng(1));
    expect(d.round).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// monotonic escalation round-over-round
// ---------------------------------------------------------------------------

describe("chaosScheduleForRound — monotonic escalation", () => {
  // Build directives for rounds 0..6 with the same starting seed each time.
  // NOTE: prng is consumed per call, so we use a fresh one per round
  // (seed is per-round — the design doc says same seed+round → reproducible,
  // meaning the caller passes a prng seeded for that round).
  function roundDirective(round: number): ChaosDirective {
    return chaosScheduleForRound(round, makePrng(42));
  }

  it("ghostProbability is non-decreasing across rounds 0..6", () => {
    let prev = roundDirective(0).ghostProbability;
    for (let r = 1; r <= 6; r++) {
      const cur = roundDirective(r).ghostProbability;
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it("badFaithProbability is non-decreasing across rounds 0..6", () => {
    let prev = roundDirective(0).badFaithProbability;
    for (let r = 1; r <= 6; r++) {
      const cur = roundDirective(r).badFaithProbability;
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it("budgetProbeProbability is non-decreasing across rounds 0..6", () => {
    let prev = roundDirective(0).budgetProbeProbability;
    for (let r = 1; r <= 6; r++) {
      const cur = roundDirective(r).budgetProbeProbability;
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it("profileCount is non-decreasing across rounds 0..6", () => {
    let prev = roundDirective(0).profileCount;
    for (let r = 1; r <= 6; r++) {
      const cur = roundDirective(r).profileCount;
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it("aggressionLevel is non-decreasing across rounds 0..6", () => {
    let prev = roundDirective(0).aggressionLevel;
    for (let r = 1; r <= 6; r++) {
      const cur = roundDirective(r).aggressionLevel;
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });

  it("aggressionLevel = min(round, MAX_AGGRESSION)", () => {
    // The first few rounds should equal round (before cap)
    for (let r = 0; r <= 4; r++) {
      const d = roundDirective(r);
      expect(d.aggressionLevel).toBeGreaterThanOrEqual(0);
      // aggressionLevel is capped at some MAX — must never exceed round for small rounds
      // (it can be less if capped, but must equal round for low rounds)
      // For rounds 0,1,2 we can assert equality directly (MAX is at least 4)
      if (r <= 2) {
        expect(d.aggressionLevel).toBe(r);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// dealerGroupCollision flips at round 1
// ---------------------------------------------------------------------------

describe("chaosScheduleForRound — dealerGroupCollision", () => {
  it("false at round 0", () => {
    const d = chaosScheduleForRound(0, makePrng(42));
    expect(d.dealerGroupCollision).toBe(false);
  });

  it("true at round 1", () => {
    const d = chaosScheduleForRound(1, makePrng(42));
    expect(d.dealerGroupCollision).toBe(true);
  });

  it("true at round 5", () => {
    const d = chaosScheduleForRound(5, makePrng(42));
    expect(d.dealerGroupCollision).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// caps hold at high rounds
// ---------------------------------------------------------------------------

describe("chaosScheduleForRound — caps hold at high rounds", () => {
  it("ghostProbability ≤ 0.8 at round 100", () => {
    const d = chaosScheduleForRound(100, makePrng(1));
    expect(d.ghostProbability).toBeLessThanOrEqual(0.8);
  });

  it("badFaithProbability ≤ 0.8 at round 100", () => {
    const d = chaosScheduleForRound(100, makePrng(1));
    expect(d.badFaithProbability).toBeLessThanOrEqual(0.8);
  });

  it("budgetProbeProbability ≤ 0.8 at round 100", () => {
    const d = chaosScheduleForRound(100, makePrng(1));
    expect(d.budgetProbeProbability).toBeLessThanOrEqual(0.8);
  });

  it("profileCount ≤ 5 (MAX cap) at round 100", () => {
    const d = chaosScheduleForRound(100, makePrng(1));
    expect(d.profileCount).toBeLessThanOrEqual(5);
  });

  it("aggressionLevel is capped at a reasonable MAX", () => {
    const d = chaosScheduleForRound(100, makePrng(1));
    // Must be capped — not unbounded growth
    expect(d.aggressionLevel).toBeLessThanOrEqual(100);
    // And specifically the same for round 50 and round 100 (plateau reached)
    const d50 = chaosScheduleForRound(50, makePrng(1));
    const d100 = chaosScheduleForRound(100, makePrng(1));
    expect(d50.aggressionLevel).toBe(d100.aggressionLevel);
  });
});

// ---------------------------------------------------------------------------
// aggressionDirectiveText
// ---------------------------------------------------------------------------

describe("aggressionDirectiveText", () => {
  it("level 0 produces minimal cooperative text", () => {
    const d0 = chaosScheduleForRound(0, makePrng(1));
    const text = aggressionDirectiveText(d0);
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });

  it("higher aggressionLevel produces text that contains more instructions (strictly longer or richer)", () => {
    const d0 = chaosScheduleForRound(0, makePrng(1));
    const d4 = chaosScheduleForRound(4, makePrng(1));
    const t0 = aggressionDirectiveText(d0);
    const t4 = aggressionDirectiveText(d4);
    // High-level text should reference ghost/bad-faith/budget-probe behavior
    expect(t4.length).toBeGreaterThan(t0.length);
  });

  it("text at level 0 does NOT mention ghost or bad-faith (level-0 is cooperative)", () => {
    const d0 = chaosScheduleForRound(0, makePrng(1));
    const text = aggressionDirectiveText(d0);
    // Level 0 should not instruct adversarial behavior
    expect(text.toLowerCase()).not.toContain("ghost");
    expect(text.toLowerCase()).not.toContain("bad-faith");
  });

  it("text at higher levels mentions ghost probability", () => {
    const d4 = chaosScheduleForRound(4, makePrng(1));
    const text = aggressionDirectiveText(d4);
    // Should reference ghost behavior
    expect(text.toLowerCase()).toContain("ghost");
  });

  it("text NEVER contains real-send/browser action verbs (dealer.md hard rules)", () => {
    const forbiddenPatterns = [
      /\bsubmit\b/i,
      /\bbrowser\b/i,
      /\breal email\b/i,
      /\breal send\b/i,
      /\bgmail\.send\b/i,
      /\bpage\.fill\b/i,
      /\bskill action\b/i,
    ];
    for (let round = 0; round <= 10; round++) {
      const d = chaosScheduleForRound(round, makePrng(42 + round));
      const text = aggressionDirectiveText(d);
      for (const pattern of forbiddenPatterns) {
        expect(text).not.toMatch(pattern);
      }
    }
  });

  it("aggressionDirectiveText is content-realism only: no external-action instruction", () => {
    // The text should be about how to WRITE replies, not how to fire external tools
    const d5 = chaosScheduleForRound(5, makePrng(1));
    const text = aggressionDirectiveText(d5);
    // Must not instruct real world sends or automation
    expect(text).not.toMatch(/\bform submit\b/i);
    expect(text).not.toMatch(/\bplaywright\b/i);
    expect(text).not.toMatch(/\bsend.*email\b/i);
  });
});
