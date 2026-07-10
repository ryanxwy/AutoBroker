/**
 * scheduler tests — the background-scheduler MACHINERY (registration discipline,
 * the no-op seam, the run-scoped power guard, throw-containment, the watermark
 * advance, and the no-double-run invariant). The watermark store is mocked to an
 * in-memory map so these stay pure (the catch-up decision math has its own pure
 * test in schedulerCatchup.test.ts; the DB accessor has its own test in tools).
 *
 * croner's scheduled-fire TIMING is not asserted here (it would make the suite
 * slow + flaky); the catch-up trigger drives every code path the scheduled fire
 * shares (runJob → handler/seam → watermark advance → throw containment).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory watermark store, shared with the mocked tools accessors below.
const watermarks = new Map<string, number>();
// Job names whose watermark read should throw (simulating a DB read failure).
const readThrows = new Set<string>();
const claims = new Map<string, { ownerId: string; expiresAtMs: number; value: string }>();
vi.mock("@autobroker/tools", () => ({
  readLastSuccess: (job: string) => {
    if (readThrows.has(job)) throw new Error("db gone");
    return watermarks.get(job) ?? 0;
  },
  writeLastSuccess: (job: string, atMs: number) => void watermarks.set(job, atMs),
  tryClaimScheduledJob: ({
    jobName,
    ownerId,
    nowMs,
    leaseMs,
  }: {
    jobName: string;
    ownerId: string;
    nowMs: number;
    leaseMs: number;
  }) => {
    const existing = claims.get(jobName);
    if (existing !== undefined && existing.expiresAtMs > nowMs) return null;
    const value = `${nowMs + leaseMs}:${ownerId}`;
    const claim = { ownerId, expiresAtMs: nowMs + leaseMs, value };
    claims.set(jobName, claim);
    return { jobName, ...claim };
  },
  releaseScheduledJobClaim: (claim: { jobName: string; value: string }) => {
    if (claims.get(claim.jobName)?.value !== claim.value) return 0;
    claims.delete(claim.jobName);
    return 1;
  },
}));

import { BackgroundScheduler, SCHEDULED_JOBS, type SchedulerTrace } from "./scheduler.js";

const NOW = Date.parse("2026-06-12T13:00:00Z"); // most-recent 6-hourly fire = 12:00Z

beforeEach(() => {
  watermarks.clear();
  // Keep the 07:00 job covered unless a test explicitly makes it due.
  watermarks.set("morning_scan", NOW);
  readThrows.clear();
  claims.clear();
});

/** A scheduler that never starts the heartbeat/croner timers (heartbeatMs huge,
 *  and start() is not called) — the tests drive runCatchUp via onPower/boot or
 *  call the private path indirectly. We expose a trace sink + a fixed clock. */
function makeScheduler(extra: Partial<Parameters<typeof makeSchedulerImpl>[0]> = {}) {
  return makeSchedulerImpl({ now: () => NOW, ...extra });
}
function makeSchedulerImpl(opts: {
  now: () => number;
  acquire?: () => void;
  release?: () => void;
  instanceId?: string;
}) {
  const traces: SchedulerTrace[] = [];
  const scheduler = new BackgroundScheduler({
    now: opts.now,
    trace: (line) => traces.push(line),
    heartbeatMs: 10 * 60 * 1000, // long enough never to fire during a test
    ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
    ...(opts.acquire !== undefined && opts.release !== undefined
      ? { powerGuard: { acquire: opts.acquire, release: opts.release } }
      : {}),
  });
  return { scheduler, traces };
}

describe("registration: jobs armed with protect + catch", () => {
  it("start() arms exactly the three standing anchored jobs", () => {
    const { scheduler, traces } = makeScheduler();
    // Pre-arm the watermarks so the boot catch-up pass is a no-op (we only test
    // the arming trace here).
    for (const j of SCHEDULED_JOBS) watermarks.set(j.name, NOW);
    scheduler.start();
    try {
      const armed = traces.find((t) => t.scheduler === "lifecycle" && t.detail?.startsWith("armed"));
      expect(armed?.detail).toBe(`armed ${SCHEDULED_JOBS.length} jobs`);
      expect(SCHEDULED_JOBS.map((j) => j.name)).toEqual([
        "inbox_poll",
        "morning_scan",
        "daily_digest",
      ]);
      expect(SCHEDULED_JOBS.map((j) => j.pattern)).toEqual([
        "0 */6 * * *",
        "0 7 * * *",
        "0 18 * * *",
      ]);
    } finally {
      scheduler.stop();
    }
  });
});

describe("the no-op seam (no handler registered)", () => {
  it("a due job with no handler traces the no-op AND advances the watermark", async () => {
    const { scheduler, traces } = makeScheduler();
    // last_success well before the 12:00 fire → both jobs are due on resume.
    watermarks.set("inbox_poll", NOW - 7 * 60 * 60 * 1000);
    watermarks.set("daily_digest", NOW - 7 * 60 * 60 * 1000);

    scheduler.onPower("resume");
    await vi.waitFor(() => expect(traces.some((t) => t.scheduler === "job_noop")).toBe(true));

    const noop = traces.find((t) => t.scheduler === "job_noop" && t.job === "inbox_poll");
    expect(noop?.detail).toBe("no-op: dealer_inbox_check not yet wired");
    // SEAM never fabricates a run; the watermark advances so the bookkeeping is
    // correct (the missed fire is now covered).
    expect(watermarks.get("inbox_poll")).toBe(NOW);
  });
});

describe("a registered handler runs and a throw is contained", () => {
  it("the fake clock makes the 07:00 morning_scan catch-up fire", async () => {
    const { scheduler } = makeScheduler();
    watermarks.set("inbox_poll", NOW);
    watermarks.set("morning_scan", NOW - 48 * 60 * 60 * 1000);
    watermarks.set("daily_digest", NOW);
    const calls: string[] = [];
    scheduler.registerHandler("morning_scan", async (job) => void calls.push(job.name));

    scheduler.onPower("resume");
    await vi.waitFor(() => expect(calls).toEqual(["morning_scan"]));
    expect(watermarks.get("morning_scan")).toBe(NOW);
  });

  it("the handler runs once, the watermark advances", async () => {
    const { scheduler, traces } = makeScheduler();
    watermarks.set("inbox_poll", NOW - 7 * 60 * 60 * 1000);
    watermarks.set("daily_digest", NOW); // not due — keep this test to one job
    const calls: string[] = [];
    scheduler.registerHandler("inbox_poll", async (job) => void calls.push(job.name));

    scheduler.onPower("resume");
    await vi.waitFor(() => expect(calls).toEqual(["inbox_poll"]));
    expect(traces.some((t) => t.scheduler === "job_run" && t.job === "inbox_poll")).toBe(true);
    expect(watermarks.get("inbox_poll")).toBe(NOW);
  });

  it("a handler THROW is traced as job_error, does NOT advance the watermark, and the scheduler lives on", async () => {
    const { scheduler, traces } = makeScheduler();
    watermarks.set("inbox_poll", NOW - 7 * 60 * 60 * 1000);
    watermarks.set("daily_digest", NOW);
    scheduler.registerHandler("inbox_poll", () => {
      throw new Error("boom");
    });

    // The throw must not escape onPower (it would crash the trigger).
    expect(() => scheduler.onPower("resume")).not.toThrow();
    await vi.waitFor(() =>
      expect(traces.some((t) => t.scheduler === "job_error" && t.detail === "boom")).toBe(true),
    );
    // A failed run leaves the watermark untouched → still catch-up-due.
    expect(watermarks.get("inbox_poll")).toBe(NOW - 7 * 60 * 60 * 1000);
  });
});

describe("no double-run: a covered fire is not re-run", () => {
  it("once the watermark is advanced past the fire, a second resume does nothing", async () => {
    const { scheduler, traces } = makeScheduler();
    watermarks.set("inbox_poll", NOW - 7 * 60 * 60 * 1000);
    watermarks.set("daily_digest", NOW);
    const calls: string[] = [];
    scheduler.registerHandler("inbox_poll", async (job) => void calls.push(job.name));

    scheduler.onPower("resume"); // due → runs, watermark := NOW
    await vi.waitFor(() => expect(calls).toEqual(["inbox_poll"]));

    traces.length = 0;
    scheduler.onPower("resume"); // 12:00 fire now covered (NOW > fire) → not due
    // Give the async pass a tick; it must not run the job again.
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual(["inbox_poll"]); // still exactly one run
    expect(traces.some((t) => t.scheduler === "catch_up")).toBe(false);
  });
});

describe("cross-process claim", () => {
  it("only one scheduler starts a due job while the loser traces a claimed skip", async () => {
    watermarks.set("inbox_poll", NOW - 7 * 60 * 60 * 1000);
    watermarks.set("daily_digest", NOW);
    const a = makeSchedulerImpl({ now: () => NOW, instanceId: "process-a" });
    const b = makeSchedulerImpl({ now: () => NOW, instanceId: "process-b" });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    a.scheduler.registerHandler("inbox_poll", async () => {
      calls.push("a");
      await held;
    });
    b.scheduler.registerHandler("inbox_poll", async () => void calls.push("b"));

    a.scheduler.onPower("resume");
    await vi.waitFor(() => expect(calls).toEqual(["a"]));
    b.scheduler.onPower("resume");
    await vi.waitFor(() =>
      expect(
        b.traces.some((t) => t.scheduler === "job_skipped_claimed" && t.job === "inbox_poll"),
      ).toBe(true),
    );
    expect(calls).toEqual(["a"]);

    release();
    await vi.waitFor(() => expect(watermarks.get("inbox_poll")).toBe(NOW));
  });
});

describe("run-scoped power guard wraps a single run", () => {
  it("acquire and release fire exactly once around a run, release even on throw", async () => {
    let acquired = 0;
    let released = 0;
    const { scheduler } = makeSchedulerImpl({
      now: () => NOW,
      acquire: () => void acquired++,
      release: () => void released++,
    });
    watermarks.set("inbox_poll", NOW - 7 * 60 * 60 * 1000);
    watermarks.set("daily_digest", NOW);
    scheduler.registerHandler("inbox_poll", () => {
      throw new Error("boom");
    });

    scheduler.onPower("resume");
    await vi.waitFor(() => expect(released).toBe(1));
    expect(acquired).toBe(1); // acquired for the run's duration only
    expect(released).toBe(1); // released in finally even though the handler threw
  });
});

describe("a watermark READ failure does not crash the catch-up pass", () => {
  it("the other job still runs when one job's watermark read throws", async () => {
    // inbox_poll read throws; daily_digest reads a clearly-due watermark
    // (48h ago is before the most-recent 18:00 daily fire).
    readThrows.add("inbox_poll");
    watermarks.set("daily_digest", NOW - 48 * 60 * 60 * 1000);
    const { scheduler, traces } = makeScheduler();
    const calls: string[] = [];
    scheduler.registerHandler("daily_digest", async (job) => void calls.push(job.name));

    scheduler.onPower("resume");
    await vi.waitFor(() => expect(calls).toEqual(["daily_digest"]));
    expect(traces.some((t) => t.scheduler === "job_error" && t.job === "inbox_poll")).toBe(true);
  });
});
