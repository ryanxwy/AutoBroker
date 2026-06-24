/**
 * LimiterRegistry pacing primitives — pure/deterministic units: the GCRA rate
 * gate, the async concurrency semaphore, the midnight-Pacific day key, and the
 * VirtualClock that drives the rest of the limiter suite.
 */

import { describe, expect, it } from "vitest";

import { VirtualClock } from "./clock.js";
import {
  AsyncSemaphore,
  fullJitterBackoffMs,
  pacificDayKey,
  RateGate,
} from "./primitives.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("RateGate (GCRA) — paces a stream to ≤ 1 emission per interval", () => {
  it("admits the first request with zero wait", () => {
    const gate = new RateGate({ emissionIntervalMs: 1000, burst: 1 });
    expect(gate.reserve(0)).toBe(0);
  });

  it("spaces back-to-back requests by the emission interval (burst=1)", () => {
    const gate = new RateGate({ emissionIntervalMs: 1000, burst: 1 });
    expect(gate.reserve(0)).toBe(0);
    expect(gate.reserve(0)).toBe(1000);
    expect(gate.reserve(0)).toBe(2000);
  });

  it("allows a burst up to `burst`, then paces", () => {
    const gate = new RateGate({ emissionIntervalMs: 1000, burst: 3 });
    expect(gate.reserve(0)).toBe(0);
    expect(gate.reserve(0)).toBe(0);
    expect(gate.reserve(0)).toBe(0);
    expect(gate.reserve(0)).toBe(1000);
  });

  it("60 reserves at one instant schedule the last 59s out — never > 60/min", () => {
    const gate = new RateGate({ emissionIntervalMs: 1000, burst: 1 });
    let maxWait = 0;
    for (let i = 0; i < 60; i += 1) maxWait = Math.max(maxWait, gate.reserve(0));
    expect(maxWait).toBe(59_000);
  });

  it("recovers after an idle gap (a request well past the TAT waits 0)", () => {
    const gate = new RateGate({ emissionIntervalMs: 1000, burst: 1 });
    gate.reserve(0);
    expect(gate.reserve(10_000)).toBe(0);
  });
});

describe("AsyncSemaphore — caps concurrent holders", () => {
  it("never runs more than `max` tasks at once", async () => {
    const sem = new AsyncSemaphore(2);
    let active = 0;
    let maxActive = 0;
    const releasers: Array<() => void> = [];
    const block = () => new Promise<void>((r) => releasers.push(r));
    const task = () =>
      sem.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await block();
        active -= 1;
      });

    const all = [task(), task(), task(), task(), task()];
    await tick();
    expect(active).toBe(2); // only two acquired; three queued
    expect(sem.inFlight).toBe(2);

    while (releasers.length > 0) {
      releasers.shift()!();
      await tick();
    }
    await Promise.all(all);
    expect(maxActive).toBe(2);
    expect(sem.inFlight).toBe(0);
  });

  it("never over-admits when a fresh acquire() races a release()'s wake in the same turn", async () => {
    // The one freed slot must go to EXACTLY one of {woken waiter, fresh acquire}.
    // The buggy impl decremented in release() but re-incremented in the woken
    // waiter's deferred continuation, so a fast-path acquire in the gap admitted a
    // SECOND holder onto one slot (cap over-admission — peaked +8 at cap 40).
    const sem = new AsyncSemaphore(2);
    await sem.acquire();
    await sem.acquire(); // slots full: inFlight = 2
    const waiter = sem.acquire(); // parks for a slot
    sem.release(); // frees one slot AND wakes the waiter
    const fresh = sem.acquire(); // fresh acquire in the SAME turn as the wake
    await waiter; // the woken waiter takes the freed slot
    expect(sem.inFlight).toBeLessThanOrEqual(2);
    void fresh; // correctly left parked on a correct impl (the slot went to `waiter`)
  });

  it("acquire grants a freed slot to the next waiter in FIFO order", async () => {
    const sem = new AsyncSemaphore(1);
    const order: number[] = [];
    const releasers: Array<() => void> = [];
    const block = () => new Promise<void>((r) => releasers.push(r));
    const task = (id: number) =>
      sem.run(async () => {
        order.push(id);
        await block();
      });
    const all = [task(1), task(2), task(3)];
    await tick();
    expect(order).toEqual([1]);
    releasers.shift()!(); // finish 1
    await tick();
    expect(order).toEqual([1, 2]);
    releasers.shift()!();
    await tick();
    expect(order).toEqual([1, 2, 3]);
    releasers.shift()!();
    await Promise.all(all);
  });
});

describe("pacificDayKey — the daily-budget reset boundary is midnight America/Los_Angeles", () => {
  it("maps an instant before Pacific midnight to the prior calendar day", () => {
    // 2026-06-24T05:00:00Z = 2026-06-23 22:00 PDT (UTC-7 in June).
    expect(pacificDayKey(Date.UTC(2026, 5, 24, 5, 0, 0))).toBe("2026-06-23");
  });

  it("maps an instant just after Pacific midnight to the new calendar day", () => {
    // 2026-06-24T08:00:00Z = 2026-06-24 01:00 PDT.
    expect(pacificDayKey(Date.UTC(2026, 5, 24, 8, 0, 0))).toBe("2026-06-24");
  });

  it("two instants in the same Pacific day share a key; crossing midnight differs", () => {
    const beforeMidnight = Date.UTC(2026, 5, 24, 6, 59, 0); // 23:59 PDT 06-23
    const afterMidnight = Date.UTC(2026, 5, 24, 7, 1, 0); //  00:01 PDT 06-24
    expect(pacificDayKey(beforeMidnight)).toBe("2026-06-23");
    expect(pacificDayKey(afterMidnight)).toBe("2026-06-24");
  });
});

describe("fullJitterBackoffMs — bounded full-jitter exponential backoff", () => {
  it("is a uniform draw over [0, min(cap, base·2^attempt))", () => {
    expect(fullJitterBackoffMs(0, 1000, 32_000, () => 0)).toBe(0);
    expect(fullJitterBackoffMs(0, 1000, 32_000, () => 1)).toBe(1000); // base·2^0
    expect(fullJitterBackoffMs(2, 1000, 32_000, () => 1)).toBe(4000); // base·2^2
    expect(fullJitterBackoffMs(2, 1000, 32_000, () => 0.5)).toBe(2000);
  });

  it("is clamped by the cap at high attempts", () => {
    expect(fullJitterBackoffMs(10, 1000, 8000, () => 1)).toBe(8000); // 2^10·1000 > cap
  });
});

describe("VirtualClock — deterministic time for the limiter suite", () => {
  it("now() reflects advance()", async () => {
    const clock = new VirtualClock(1000);
    expect(clock.now()).toBe(1000);
    await clock.advance(500);
    expect(clock.now()).toBe(1500);
  });

  it("sleep(ms) resolves only once advance() passes the wake instant", async () => {
    const clock = new VirtualClock(0);
    let woke = false;
    const p = clock.sleep(100).then(() => {
      woke = true;
    });
    await clock.advance(50);
    expect(woke).toBe(false);
    await clock.advance(50);
    await p;
    expect(woke).toBe(true);
  });

  it("sleep(0) resolves without an advance", async () => {
    const clock = new VirtualClock(0);
    await clock.sleep(0); // resolves immediately
    expect(clock.now()).toBe(0);
  });
});
