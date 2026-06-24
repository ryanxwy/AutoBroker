/**
 * PortfolioScheduler — the bounded hot-set scheduler ABOVE the resolver. Tests the
 * load-bearing invariants with injected deps (a controllable fake health provider,
 * a recording startProfileRun, the real in-memory activation registry):
 *   - MAX_CONCURRENT_ACTIVE_PROFILES cap respected (the deletion test: remove it and
 *     fan-out is N×4 Chromium + SQLITE_BUSY storms).
 *   - LRU/recency eviction: the least-recently-progressed hot profile is warmed and
 *     RESUMES when a slot frees.
 *   - per-profile concurrency key = 1 (never two runs for one profile).
 *   - a SUSPENDED run holds ZERO slots (its freed slot admits a warm profile).
 *   - a lock-blocked profile is NON-HOT (never scheduled).
 */

import { describe, it, expect } from "vitest";

import { PortfolioScheduler } from "./portfolioScheduler.js";
import { InMemoryActivationRegistry } from "./activationRegistry.js";
import { StubProfileHealthProvider, type ProfileHealth, type ProfileHealthProvider } from "./profileHealth.js";

/** A controllable health provider — the test mutates `hot` between ticks. */
function fakeHealth(): ProfileHealthProvider & { hot: string[] } {
  const p = {
    hot: [] as string[],
    snapshot(): ProfileHealth[] {
      return p.hot.map((profileId) => ({ profileId, health: "hot" as const, reasons: [] }));
    },
  };
  return p;
}

function recorder() {
  const starts: string[] = [];
  let n = 0;
  return {
    starts,
    startProfileRun: async (profileId: string) => {
      starts.push(profileId);
      return { runId: `run-${profileId}-${(n += 1)}` };
    },
  };
}

describe("PortfolioScheduler", () => {
  it("respects the MAX_CONCURRENT_ACTIVE_PROFILES cap and warms the least-recently-progressed", async () => {
    const health = fakeHealth();
    const reg = new InMemoryActivationRegistry();
    const rec = recorder();
    const sched = new PortfolioScheduler({
      healthProvider: health,
      activationRegistry: reg,
      startProfileRun: rec.startProfileRun,
      cap: 2,
    });
    // recency: A then B (more recent than fresh C) → C is least-recently-progressed.
    sched.recordProgress("A");
    sched.recordProgress("B");
    health.hot = ["A", "B", "C"];

    await sched.tick();

    // cap=2 respected; C (least-recent) warmed (not started).
    expect(rec.starts.sort()).toEqual(["A", "B"]);
    expect(rec.starts).not.toContain("C");
  });

  it("resumes a warmed profile when a running slot frees (LRU re-admission)", async () => {
    const health = fakeHealth();
    const reg = new InMemoryActivationRegistry();
    const rec = recorder();
    const sched = new PortfolioScheduler({
      healthProvider: health,
      activationRegistry: reg,
      startProfileRun: rec.startProfileRun,
      cap: 2,
    });
    sched.recordProgress("A");
    sched.recordProgress("B");
    health.hot = ["A", "B", "C"];
    await sched.tick(); // A,B running; C warm
    const runA = reg.liveRunFor("A")!;

    // A terminates → its slot frees; A is no longer hot.
    sched.onRunTerminal({ runId: runA, profileId: "A", skill: "quote_pipeline", terminalKind: "completed" });
    health.hot = ["B", "C"];
    await sched.tick();

    expect(rec.starts).toContain("C"); // the warmed profile resumed into the freed slot
  });

  it("enforces per-profile concurrency = 1 (never starts a second run for a live profile)", async () => {
    const health = fakeHealth();
    const reg = new InMemoryActivationRegistry();
    const rec = recorder();
    const sched = new PortfolioScheduler({
      healthProvider: health,
      activationRegistry: reg,
      startProfileRun: rec.startProfileRun,
      cap: 4,
    });
    health.hot = ["A"];
    await sched.tick();
    await sched.tick(); // A already live -> no second start
    expect(rec.starts).toEqual(["A"]);
  });

  it("a SUSPENDED run holds ZERO slots — the freed slot admits a warm profile", async () => {
    const health = fakeHealth();
    const reg = new InMemoryActivationRegistry();
    const rec = recorder();
    const sched = new PortfolioScheduler({
      healthProvider: health,
      activationRegistry: reg,
      startProfileRun: rec.startProfileRun,
      cap: 2,
    });
    sched.recordProgress("A");
    sched.recordProgress("B");
    health.hot = ["A", "B", "C"];
    await sched.tick(); // A,B running (cap full); C warm
    const runA = reg.liveRunFor("A")!;

    // A suspends at a gate: it keeps its key=1 binding but holds ZERO slots.
    sched.onRunSuspended({ runId: runA, profileId: "A", skill: "quote_pipeline" });
    await sched.tick();

    expect(rec.starts).toContain("C"); // C admitted into A's freed slot
    expect(reg.liveRunFor("A")).toBe(runA); // A still live (suspended), not restarted
    expect(rec.starts.filter((p) => p === "A")).toHaveLength(1); // A never double-started
  });

  it("treats a lock-blocked profile as NON-HOT (never scheduled)", async () => {
    const reg = new InMemoryActivationRegistry();
    const rec = recorder();
    const sched = new PortfolioScheduler({
      healthProvider: new StubProfileHealthProvider(
        () => ["A", "B"],
        () => new Set(["B"]),
      ),
      activationRegistry: reg,
      startProfileRun: rec.startProfileRun,
      cap: 4,
    });
    await sched.tick();
    expect(rec.starts).toEqual(["A"]); // B is lock-blocked -> warm -> never started
  });

  it("a resumed run RE-OCCUPIES its slot so the cap is not exceeded when new work arrives", async () => {
    const health = fakeHealth();
    const reg = new InMemoryActivationRegistry();
    const rec = recorder();
    const sched = new PortfolioScheduler({
      healthProvider: health,
      activationRegistry: reg,
      startProfileRun: rec.startProfileRun,
      cap: 2,
    });
    health.hot = ["A", "B"];
    await sched.tick(); // A,B running (cap full)
    const runA = reg.liveRunFor("A")!;

    sched.onRunSuspended({ runId: runA, profileId: "A", skill: "quote_pipeline" }); // A frees its slot (still live)
    sched.onRunResumed({ runId: runA, profileId: "A", skill: "quote_pipeline" }); // human resumes A -> re-occupies it

    // New work arrives (C hot). A re-occupies, so running == {A,B} == cap, C must NOT be admitted.
    health.hot = ["A", "B", "C"];
    await sched.tick();
    expect(rec.starts).not.toContain("C"); // cap held across the suspend/resume cycle
  });

  it("overlapping ticks do not double-start a profile (re-entrancy guard)", async () => {
    const health = fakeHealth();
    const reg = new InMemoryActivationRegistry();
    const starts: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let n = 0;
    const sched = new PortfolioScheduler({
      healthProvider: health,
      activationRegistry: reg,
      startProfileRun: async (pid) => {
        starts.push(pid);
        await gate; // hold the first tick inside startProfileRun so a second tick can overlap
        return { runId: `run-${pid}-${(n += 1)}` };
      },
      cap: 4,
    });
    health.hot = ["A"];
    const t1 = sched.tick();
    const t2 = sched.tick(); // overlaps t1 (awaiting startProfileRun, A not yet registered)
    release();
    await Promise.all([t1, t2]);
    expect(starts).toEqual(["A"]); // started exactly once despite two concurrent ticks
  });
});
