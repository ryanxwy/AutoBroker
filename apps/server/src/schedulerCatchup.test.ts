/**
 * schedulerCatchup tests — the load-bearing catch-up decision, pure (no
 * Electron, no timers, no DB). Proves the watermark-vs-most-recent-fire rule
 * that survives sleep/down windows, and the no-double-run invariant.
 *
 * Representative standing patterns are "0 *\/6 * * *" (every 6h on the
 * hour) and "0 18 * * *" (18:00 daily); the same helper also serves the
 * 07:00 morning scan. UTC is used for deterministic clock math (process.env.TZ
 * is set to UTC below so the patterns anchor predictably).
 */

import { beforeAll, describe, expect, it } from "vitest";

import { catchUpDecision, mostRecentScheduledFire } from "./schedulerCatchup.js";

const SIX_HOURLY = "0 */6 * * *";
const DAILY_18 = "0 18 * * *";
const HOUR = 60 * 60 * 1000;

beforeAll(() => {
  process.env.TZ = "UTC";
});

describe("mostRecentScheduledFire", () => {
  it("returns the fire at or before now (a fire landing ON now counts)", () => {
    // 2026-06-12T12:00:00Z is itself a 6-hourly fire (00/06/12/18).
    const onFire = Date.parse("2026-06-12T12:00:00Z");
    expect(mostRecentScheduledFire(SIX_HOURLY, onFire)).toBe(onFire);
    // Just after the 12:00 fire → still 12:00 (not 18:00, which is in the future).
    expect(mostRecentScheduledFire(SIX_HOURLY, onFire + HOUR)).toBe(onFire);
    // Just before 12:00 → the previous fire at 06:00.
    expect(mostRecentScheduledFire(SIX_HOURLY, onFire - 1)).toBe(Date.parse("2026-06-12T06:00:00Z"));
  });
});

describe("catchUpDecision — the 6-hourly inbox poll", () => {
  // Anchor "now" at 2026-06-12T13:00:00Z: the most-recent 6-hourly fire ≤ now is
  // 12:00:00Z.
  const now = Date.parse("2026-06-12T13:00:00Z");
  const mostRecentFire = Date.parse("2026-06-12T12:00:00Z");

  it("last_success 7h ago → DUE (the noon fire was missed)", () => {
    const lastSuccess = now - 7 * HOUR; // 06:00Z — before the 12:00 fire
    const d = catchUpDecision(SIX_HOURLY, lastSuccess, now);
    expect(d.due).toBe(true);
    expect(d.mostRecentFireMs).toBe(mostRecentFire);
  });

  it("after running it (last_success := now) → NOT due again", () => {
    // Run sets last_success = now. now > the 12:00 fire, so it is now covered.
    const afterRun = catchUpDecision(SIX_HOURLY, now, now);
    expect(afterRun.due).toBe(false);
  });

  it("last_success 1h ago → NOT due (the noon fire is already covered)", () => {
    const lastSuccess = now - 1 * HOUR; // 12:00Z exactly — equals the fire-time
    // Equality is NOT due: the watermark already covers that fire (strict >).
    const d = catchUpDecision(SIX_HOURLY, lastSuccess, now);
    expect(d.due).toBe(false);
  });

  it("last_success just after the fire → NOT due", () => {
    const lastSuccess = mostRecentFire + 1000; // ran 1s after the 12:00 fire
    expect(catchUpDecision(SIX_HOURLY, lastSuccess, now).due).toBe(false);
  });

  it("a fresh install (watermark 0, never ran) → DUE exactly once", () => {
    const first = catchUpDecision(SIX_HOURLY, 0, now);
    expect(first.due).toBe(true);
    // After the first catch-up run advances the watermark to now, it is no
    // longer due.
    expect(catchUpDecision(SIX_HOURLY, now, now).due).toBe(false);
  });
});

describe("catchUpDecision — the 18:00 daily digest (merge, never N runs)", () => {
  it("a 25h-ago success → DUE once (collapses the missed day into one run)", () => {
    // now = 2026-06-13T09:00:00Z. The most-recent 18:00 fire ≤ now is
    // 2026-06-12T18:00:00Z. last_success 25h before now = 2026-06-12T08:00Z,
    // which is BEFORE that 18:00 fire → due.
    const now = Date.parse("2026-06-13T09:00:00Z");
    const lastSuccess = now - 25 * HOUR;
    const d = catchUpDecision(DAILY_18, lastSuccess, now);
    expect(d.due).toBe(true);
    expect(d.mostRecentFireMs).toBe(Date.parse("2026-06-12T18:00:00Z"));

    // Running it once sets last_success = now → not due again. The single run
    // covered the one missed fire; there is no second/third/fourth run.
    expect(catchUpDecision(DAILY_18, now, now).due).toBe(false);
  });

  it("a success AFTER yesterday's 18:00 fire → NOT due", () => {
    const now = Date.parse("2026-06-13T09:00:00Z");
    const lastSuccess = Date.parse("2026-06-12T20:00:00Z"); // after the 18:00 fire
    expect(catchUpDecision(DAILY_18, lastSuccess, now).due).toBe(false);
  });
});
