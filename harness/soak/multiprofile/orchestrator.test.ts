/**
 * orchestrator.test.ts — `planMultiProfileRun` purity / reproducibility /
 * escalation / hot-set-cap tests. TDD: written BEFORE the implementation.
 *
 * `planMultiProfileRun` is PURE — it touches no DB, no provider, no spawn. It
 * folds a single numeric seed + a round count into a fully deterministic plan:
 * per round a ChaosDirective (fresh prng per round, derived from seed+round), a
 * scheduled hot set (the stub scheduler, capped at maxConcurrent), and the
 * dealer reply/ghost ordering (the round prng). These tests freeze:
 *   - reproducibility: same opts → deep-equal plan;
 *   - escalation: the per-round chaos directives are monotone (reusing the chaos
 *     module's monotonicity guarantee);
 *   - hot-set cap: each round's hot set respects maxConcurrent.
 *
 * The LIVE driver (runMultiProfileLane) boots a server child + spawns a Sonnet
 * dealer + drives Playwright — it is integration-tested later, NOT here (same
 * posture as harness/soak/orchestrator.ts). So no unit test exercises its
 * spawn/HTTP glue; we only assert its existence + signature shape compiles.
 */

import { describe, expect, it } from "vitest";

import type { MpProfileSeed, SharedDealerSeed } from "./world.js";
import { planMultiProfileRun, runMultiProfileLane } from "./orchestrator.js";

const PROFILES: MpProfileSeed[] = [
  { id: "A", year: 2026, make: "Honda", model: "Accord", trim: "EX-L", budgetMax: 40000 },
  { id: "B", year: 2026, make: "Toyota", model: "Camry", trim: "XSE", budgetMax: 42000 },
  { id: "C", year: 2026, make: "Hyundai", model: "Sonata", trim: "Limited", budgetMax: 38000 },
];

const DEALER: SharedDealerSeed = {
  dealerKey: "collision-rooftop",
  name: "Collision Auto Group",
  website: "https://collision.example",
};

describe("planMultiProfileRun — reproducibility", () => {
  it("same opts → deep-equal plan", () => {
    const a = planMultiProfileRun({ seed: 7, rounds: 4, profiles: PROFILES, dealer: DEALER });
    const b = planMultiProfileRun({ seed: 7, rounds: 4, profiles: PROFILES, dealer: DEALER });
    expect(a).toEqual(b);
  });

  it("a different seed → a generally different plan", () => {
    const a = planMultiProfileRun({ seed: 7, rounds: 4, profiles: PROFILES, dealer: DEALER });
    const b = planMultiProfileRun({ seed: 8, rounds: 4, profiles: PROFILES, dealer: DEALER });
    // The chaos schedule is round-driven (deterministic) so the directives match,
    // but the prng-driven reply ordering differs => the plans are not deep-equal.
    expect(a).not.toEqual(b);
  });

  it("the plan carries one entry per round", () => {
    const plan = planMultiProfileRun({ seed: 1, rounds: 5, profiles: PROFILES, dealer: DEALER });
    expect(plan.rounds).toHaveLength(5);
    expect(plan.seed).toBe(1);
    plan.rounds.forEach((r, i) => expect(r.round).toBe(i));
  });
});

describe("planMultiProfileRun — escalation (chaos monotone round-over-round)", () => {
  it("ghost/badFaith/budgetProbe/aggression are non-decreasing across rounds", () => {
    const plan = planMultiProfileRun({ seed: 99, rounds: 5, profiles: PROFILES, dealer: DEALER });
    for (let i = 1; i < plan.rounds.length; i += 1) {
      const prev = plan.rounds[i - 1]!.chaos;
      const cur = plan.rounds[i]!.chaos;
      expect(cur.ghostProbability).toBeGreaterThanOrEqual(prev.ghostProbability);
      expect(cur.badFaithProbability).toBeGreaterThanOrEqual(prev.badFaithProbability);
      expect(cur.budgetProbeProbability).toBeGreaterThanOrEqual(prev.budgetProbeProbability);
      expect(cur.aggressionLevel).toBeGreaterThanOrEqual(prev.aggressionLevel);
      expect(cur.profileCount).toBeGreaterThanOrEqual(prev.profileCount);
    }
  });

  it("round 0 is fully cooperative; the collision flips on from round 1", () => {
    const plan = planMultiProfileRun({ seed: 99, rounds: 3, profiles: PROFILES, dealer: DEALER });
    expect(plan.rounds[0]!.chaos.aggressionLevel).toBe(0);
    expect(plan.rounds[0]!.chaos.ghostProbability).toBe(0);
    expect(plan.rounds[0]!.chaos.dealerGroupCollision).toBe(false);
    expect(plan.rounds[1]!.chaos.dealerGroupCollision).toBe(true);
  });

  it("a FRESH prng per round — the round-0 directive is identical whether rounds=1 or rounds=5", () => {
    // If a single advancing prng were threaded across rounds, the round-0 jitter
    // would depend on how many rounds follow. A fresh prng per round keeps each
    // round's directive a pure function of (seed, round).
    const short = planMultiProfileRun({ seed: 5, rounds: 1, profiles: PROFILES, dealer: DEALER });
    const long = planMultiProfileRun({ seed: 5, rounds: 5, profiles: PROFILES, dealer: DEALER });
    expect(long.rounds[0]!.chaos).toEqual(short.rounds[0]!.chaos);
    expect(long.rounds[0]!.replyOrder).toEqual(short.rounds[0]!.replyOrder);
  });
});

describe("planMultiProfileRun — hot-set cap (maxConcurrent)", () => {
  it("each round's hot set is within maxConcurrent and the rest are deferred", () => {
    const plan = planMultiProfileRun({
      seed: 3,
      rounds: 4,
      maxConcurrent: 2,
      profiles: PROFILES,
      dealer: DEALER,
    });
    for (const r of plan.rounds) {
      expect(r.schedule.hot.length).toBeLessThanOrEqual(2);
      // hot ∪ deferred == every profile, no overlap.
      const union = [...r.schedule.hot, ...r.schedule.deferred].sort();
      expect(union).toEqual([...PROFILES.map((p) => p.id)].sort());
      for (const id of r.schedule.hot) expect(r.schedule.deferred).not.toContain(id);
    }
  });

  it("no cap → every profile is hot", () => {
    const plan = planMultiProfileRun({ seed: 3, rounds: 2, profiles: PROFILES, dealer: DEALER });
    for (const r of plan.rounds) {
      expect(r.schedule.hot.sort()).toEqual([...PROFILES.map((p) => p.id)].sort());
      expect(r.schedule.deferred).toHaveLength(0);
    }
  });
});

describe("planMultiProfileRun — reply ordering is a permutation of the profile ids", () => {
  it("replyOrder is a deterministic permutation of the profile ids each round", () => {
    const plan = planMultiProfileRun({ seed: 11, rounds: 3, profiles: PROFILES, dealer: DEALER });
    const ids = [...PROFILES.map((p) => p.id)].sort();
    for (const r of plan.rounds) {
      expect([...r.replyOrder].sort()).toEqual(ids);
    }
  });
});

describe("planMultiProfileRun — purity (no DB/provider/spawn)", () => {
  it("never throws and never touches process env / globals (pure call)", () => {
    const envBefore = JSON.stringify(process.env);
    planMultiProfileRun({ seed: 42, rounds: 4, profiles: PROFILES, dealer: DEALER });
    expect(JSON.stringify(process.env)).toBe(envBefore);
  });
});

describe("runMultiProfileLane — structural (live-deferred; no unit drive)", () => {
  // The live drive boots a server + spawns a Sonnet dealer + drives Playwright;
  // it is integration-tested later, exactly like harness/soak/orchestrator.ts. We
  // only assert the function exists with the documented shape (it compiles).
  it("is an async function (the live driver entry point)", () => {
    expect(typeof runMultiProfileLane).toBe("function");
    expect(runMultiProfileLane.constructor.name).toBe("AsyncFunction");
  });
});
