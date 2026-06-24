/**
 * Gmail send limiter — paces the COMBINED send stream of every profile to
 * ≤ 60/min (GCRA), caps in-flight sends, enforces a hard daily budget that
 * resets at midnight Pacific, backs off+jitters on 429, and opens a circuit on
 * 403 dailyLimitExceeded until the daily reset. Pure pacing — no real Gmail; a
 * fake `fn` stands in for `adapter.send`, a VirtualClock for wall time.
 */

import { describe, expect, it } from "vitest";

import { VirtualClock } from "./clock.js";
import { classifyGmailError, GmailDailyLimitError, GmailSendLimiter } from "./gmailLimiter.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("classifyGmailError — maps a Gmail API error to a limiter action", () => {
  it("429 (any field) → rate_limited", () => {
    expect(classifyGmailError({ code: 429 })).toBe("rate_limited");
    expect(classifyGmailError({ status: 429 })).toBe("rate_limited");
    expect(classifyGmailError({ response: { status: 429 } })).toBe("rate_limited");
    expect(classifyGmailError({ errors: [{ reason: "rateLimitExceeded" }] })).toBe("rate_limited");
    expect(classifyGmailError({ errors: [{ reason: "userRateLimitExceeded" }] })).toBe(
      "rate_limited",
    );
  });

  it("403 with dailyLimitExceeded → daily_limit", () => {
    expect(classifyGmailError({ code: 403, errors: [{ reason: "dailyLimitExceeded" }] })).toBe(
      "daily_limit",
    );
    expect(
      classifyGmailError({ response: { data: { error: { errors: [{ reason: "dailyLimitExceeded" }] } } } }),
    ).toBe("daily_limit");
  });

  it("a 403 WITHOUT a daily reason, or any other error, → other", () => {
    expect(classifyGmailError({ code: 403, errors: [{ reason: "forbidden" }] })).toBe("other");
    expect(classifyGmailError({ code: 500 })).toBe("other");
    expect(classifyGmailError(new Error("network"))).toBe("other");
  });
});

describe("GmailSendLimiter.runGmailSend — pacing", () => {
  it("paces a burst of sends to one per emission interval (≤ 60/min)", async () => {
    const clock = new VirtualClock(0);
    const limiter = new GmailSendLimiter({ clock, emissionIntervalMs: 1000, burst: 1 });
    const firedAt: number[] = [];
    const send = () => {
      firedAt.push(clock.now());
      return Promise.resolve("ok");
    };

    const all = Array.from({ length: 5 }, () => limiter.runGmailSend(send));
    await tick();
    expect(firedAt).toEqual([0]); // first emits now; rest paced

    await clock.advance(1000);
    expect(firedAt).toEqual([0, 1000]);
    await clock.advance(1000);
    await clock.advance(1000);
    await clock.advance(1000);
    await Promise.all(all);
    expect(firedAt).toEqual([0, 1000, 2000, 3000, 4000]);
  });
});

describe("GmailSendLimiter.runGmailSend — in-flight cap", () => {
  it("never lets more than the in-flight cap of sends run at once", async () => {
    const clock = new VirtualClock(0);
    // big interval so pacing doesn't interfere; cap is the thing under test.
    const limiter = new GmailSendLimiter({ clock, emissionIntervalMs: 0, inFlightCap: 2 });
    let active = 0;
    let maxActive = 0;
    const releasers: Array<() => void> = [];
    const send = () =>
      new Promise<void>((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        releasers.push(() => {
          active -= 1;
          resolve();
        });
      });

    const all = Array.from({ length: 5 }, () => limiter.runGmailSend(send));
    await tick();
    expect(active).toBe(2);
    while (releasers.length > 0) {
      releasers.shift()!();
      await tick();
    }
    await Promise.all(all);
    expect(maxActive).toBe(2);
  });
});

describe("GmailSendLimiter.runGmailSend — daily budget", () => {
  it("fails closed once the daily cap is reached, then resets at midnight Pacific", async () => {
    // Start mid-day Pacific: 2026-06-24 12:00 PDT = 19:00Z.
    const clock = new VirtualClock(Date.UTC(2026, 5, 24, 19, 0, 0));
    const limiter = new GmailSendLimiter({ clock, emissionIntervalMs: 0, dailyCap: 3 });
    const send = () => Promise.resolve("ok");

    await limiter.runGmailSend(send);
    await limiter.runGmailSend(send);
    await limiter.runGmailSend(send);
    await expect(limiter.runGmailSend(send)).rejects.toBeInstanceOf(GmailDailyLimitError);

    // Advance to the next Pacific day (well past midnight) → budget resets.
    await clock.advance(24 * 60 * 60 * 1000);
    await expect(limiter.runGmailSend(send)).resolves.toBe("ok");
  });

  it("fails closed under CONCURRENCY — never overshoots the daily cap", async () => {
    // The cap is a hard budget; N concurrent sends must not all pass a stale
    // check. Exactly `dailyCap` succeed; the rest reject (budget reserved at
    // admission, not on completion).
    const clock = new VirtualClock(Date.UTC(2026, 5, 24, 19, 0, 0));
    const limiter = new GmailSendLimiter({ clock, emissionIntervalMs: 0, inFlightCap: 40, dailyCap: 3 });
    const send = () => Promise.resolve("ok");
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, () => limiter.runGmailSend(send)),
    );
    const ok = settled.filter((r) => r.status === "fulfilled").length;
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(ok).toBe(3); // exactly the cap
    expect(rejected).toHaveLength(7);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(GmailDailyLimitError);
    }
  });

  it("a failed send releases its reserved budget slot (a failure does not consume budget)", async () => {
    const clock = new VirtualClock(Date.UTC(2026, 5, 24, 19, 0, 0));
    const limiter = new GmailSendLimiter({ clock, emissionIntervalMs: 0, dailyCap: 1, maxRetries: 0 });
    // First send fails with a non-retryable error → its reservation is released.
    await expect(limiter.runGmailSend(() => Promise.reject(new Error("smtp")))).rejects.toThrow("smtp");
    // The single budget slot is free again → a real send still succeeds.
    await expect(limiter.runGmailSend(() => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});

describe("GmailSendLimiter.runGmailSend — 429 backoff + retry", () => {
  it("retries with backoff and succeeds after transient 429s", async () => {
    const clock = new VirtualClock(0);
    const limiter = new GmailSendLimiter({
      clock,
      emissionIntervalMs: 0,
      rand: () => 1, // deterministic full backoff
      backoffBaseMs: 1000,
      backoffCapMs: 32_000,
      maxRetries: 5,
    });
    let calls = 0;
    const send = () => {
      calls += 1;
      if (calls < 3) return Promise.reject({ code: 429 });
      return Promise.resolve("ok");
    };

    const p = limiter.runGmailSend(send);
    await tick();
    expect(calls).toBe(1); // first attempt failed, parked on backoff
    await clock.advance(1000); // attempt 0 backoff = base·2^0
    await tick();
    expect(calls).toBe(2);
    await clock.advance(2000); // attempt 1 backoff = base·2^1
    await expect(p).resolves.toBe("ok");
    expect(calls).toBe(3);
  });

  it("rethrows the 429 once retries are exhausted", async () => {
    const clock = new VirtualClock(0);
    const limiter = new GmailSendLimiter({
      clock,
      emissionIntervalMs: 0,
      rand: () => 0, // zero backoff → resolves without advancing
      maxRetries: 2,
    });
    const send = () => Promise.reject({ code: 429 });
    await expect(limiter.runGmailSend(send)).rejects.toMatchObject({ code: 429 });
  });
});

describe("GmailSendLimiter.runGmailSend — 403 dailyLimitExceeded opens the circuit", () => {
  it("opens the circuit on a 403 daily-limit and fails closed until the Pacific reset", async () => {
    const clock = new VirtualClock(Date.UTC(2026, 5, 24, 19, 0, 0));
    const limiter = new GmailSendLimiter({ clock, emissionIntervalMs: 0 });
    let calls = 0;
    const dailyErr = { code: 403, errors: [{ reason: "dailyLimitExceeded" }] };
    const sendDaily = () => {
      calls += 1;
      return Promise.reject(dailyErr);
    };
    await expect(limiter.runGmailSend(sendDaily)).rejects.toMatchObject({ code: 403 });
    expect(calls).toBe(1);

    // Circuit now open — the next send fails closed WITHOUT calling fn.
    const sendOk = () => {
      calls += 1;
      return Promise.resolve("ok");
    };
    await expect(limiter.runGmailSend(sendOk)).rejects.toBeInstanceOf(GmailDailyLimitError);
    expect(calls).toBe(1); // fn never invoked while circuit open

    // After the Pacific reset the circuit closes.
    await clock.advance(24 * 60 * 60 * 1000);
    await expect(limiter.runGmailSend(sendOk)).resolves.toBe("ok");
    expect(calls).toBe(2);
  });
});
