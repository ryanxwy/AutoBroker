/**
 * schedulerCatchup — the PURE catch-up decision, separated from croner's timers
 * and from Electron so it is unit-testable in isolation.
 *
 * WHY CATCH-UP (and never a single long setTimeout): libuv timers do NOT advance
 * while the machine sleeps — a `setTimeout(fn, 6h)` armed before a lid-close
 * fires late by however long the lid was shut, and a process that was fully down
 * across a scheduled fire would skip it entirely. The correct mechanism is a
 * recurring schedule (croner) PLUS a watermark check that, on every wakeup
 * trigger (boot / power-resume / a short heartbeat), asks "was the most-recent
 * scheduled fire-time later than my last recorded success?" and, if so, runs the
 * job ONCE — collapsing any number of fires missed while asleep/down into a
 * single catch-up run.
 *
 * THE RULE: a job is "due for catch-up" iff its most-recent scheduled fire-time
 * ≤ now is strictly LATER than its last-success watermark. Equality is NOT due
 * (the watermark already covers that fire), which is exactly what stops the
 * croner scheduled fire and a catch-up trigger from double-running: whichever
 * runs first writes last_success = now (> that fire-time), so the other sees the
 * fire as already covered and is not due.
 *
 * The most-recent fire-time is computed with croner's pattern math in PAUSED
 * mode (no scheduling, no timers) so this stays pure: same input → same output,
 * no clock side effects beyond the `nowMs` the caller supplies.
 */

import { Cron } from "croner";

/** The catch-up verdict for one job, plus the fire-time the decision hinged on. */
export interface CatchUpDecision {
  /** True when the most-recent scheduled fire ≤ now is later than last success. */
  due: boolean;
  /** Epoch-ms of the most-recent scheduled fire-time ≤ now (null if none yet). */
  mostRecentFireMs: number | null;
}

/**
 * Epoch-ms of the most-recent scheduled fire-time at or before `nowMs` for a
 * cron `pattern`. Pure (paused Cron = pattern math only, no timers). Returns
 * null when the pattern has no fire at or before now (not reachable for the
 * standing anchored patterns, but handled honestly).
 */
export function mostRecentScheduledFire(pattern: string, nowMs: number): number | null {
  // previousRuns(1, ref) returns the most-recent fire STRICTLY before `ref`, at
  // second granularity (croner strips sub-second precision). To make a fire that
  // lands exactly ON nowMs count as "at or before now", the reference is nudged
  // one full second past now: the latest fire < (nowSec + 1s) is the latest fire
  // <= nowSec, and no fire can fall in the open second between (cron fires are
  // whole-second aligned), so this cannot skip past a later real fire.
  const cron = new Cron(pattern, { paused: true });
  const prev = cron.previousRuns(1, new Date(nowMs + 1000))[0];
  return prev === undefined ? null : prev.getTime();
}

/**
 * The catch-up decision for one job: due iff the most-recent scheduled fire ≤
 * now is strictly later than the last-success watermark. A watermark of 0 ("never
 * ran") makes the first ever fire due exactly once.
 */
export function catchUpDecision(
  pattern: string,
  lastSuccessMs: number,
  nowMs: number,
): CatchUpDecision {
  const mostRecentFireMs = mostRecentScheduledFire(pattern, nowMs);
  const due = mostRecentFireMs !== null && mostRecentFireMs > lastSuccessMs;
  return { due, mostRecentFireMs };
}
