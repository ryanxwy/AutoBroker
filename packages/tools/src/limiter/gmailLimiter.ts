/**
 * Gmail send limiter — the resource arbiter for the ONE shared Gmail account,
 * sitting BELOW the L2 approval gate (the gate approves intent; this only paces
 * execution). It is engaged ONLY for real sends (buyer mode); test-mode fake
 * sends bypass it (no real quota to protect), so the unit suite is never paced.
 *
 *   - GCRA pacing of the COMBINED stream of every profile to ≤ 60 sends/min
 *     (Gmail: 6,000 quota-units/min ÷ 100 units/send);
 *   - an in-flight concurrency cap (< 40/mailbox);
 *   - a hard daily budget (default 500 free / 2,000 Workspace) that resets at
 *     midnight America/Los_Angeles;
 *   - exponential backoff + full jitter on a 429, bounded retries;
 *   - a circuit that opens on a 403 dailyLimitExceeded and fails closed until the
 *     next Pacific-day reset.
 *
 * Dependency wall: pure within tools — imports only the local pacing primitives.
 */

import { systemClock, type Clock } from "./clock.js";
import { AsyncSemaphore, fullJitterBackoffMs, pacificDayKey, RateGate } from "./primitives.js";

export type GmailErrorKind = "rate_limited" | "daily_limit" | "other";

/** Thrown when the limiter itself refuses a send (self-budget exhausted or the
 *  403 circuit is open) — distinct from a provider error so callers can tell a
 *  "we paced you off" refusal from a real Gmail failure. */
export class GmailDailyLimitError extends Error {
  constructor(public readonly cause_kind: "budget_exhausted" | "circuit_open") {
    super(`gmail send refused: ${cause_kind}`);
    this.name = "GmailDailyLimitError";
  }
}

function httpStatusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.code === "number") return e.code;
  if (typeof e.status === "number") return e.status;
  const resp = e.response as Record<string, unknown> | undefined;
  if (resp !== undefined && typeof resp.status === "number") return resp.status;
  return undefined;
}

/** All `reason` strings reachable in a Gmail/Gaxios error, across the shapes the
 *  client library uses (top-level `errors[]` and nested `response.data.error.errors[]`). */
function reasonsOf(err: unknown): string[] {
  if (typeof err !== "object" || err === null) return [];
  const e = err as Record<string, unknown>;
  const out: string[] = [];
  const collect = (arr: unknown): void => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      const reason = (item as Record<string, unknown> | null)?.reason;
      if (typeof reason === "string") out.push(reason);
    }
  };
  collect(e.errors);
  const resp = e.response as Record<string, unknown> | undefined;
  const data = resp?.data as Record<string, unknown> | undefined;
  const error = data?.error as Record<string, unknown> | undefined;
  collect(error?.errors);
  return out;
}

/** Classify a thrown Gmail error into the limiter's action. */
export function classifyGmailError(err: unknown): GmailErrorKind {
  const reasons = reasonsOf(err);
  if (reasons.includes("dailyLimitExceeded")) return "daily_limit";
  if (reasons.includes("rateLimitExceeded") || reasons.includes("userRateLimitExceeded")) {
    return "rate_limited";
  }
  if (httpStatusOf(err) === 429) return "rate_limited";
  return "other";
}

export interface GmailSendLimiterOptions {
  clock?: Clock;
  /** Steady-state spacing — 1000ms ⇒ ≤ 60/min. */
  emissionIntervalMs?: number;
  burst?: number;
  /** Max concurrent in-flight sends (< 40/mailbox). */
  inFlightCap?: number;
  /** Hard daily send budget (500 free / 2,000 Workspace). */
  dailyCap?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  rand?: () => number;
}

export class GmailSendLimiter {
  private readonly clock: Clock;
  private readonly rate: RateGate;
  private readonly sem: AsyncSemaphore;
  private readonly dailyCap: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly rand: () => number;

  /** Daily-budget bookkeeping, keyed by Pacific calendar day. */
  private budgetDay: string | null = null;
  private budgetCount = 0;
  /** The Pacific day on which the 403 circuit opened (null = closed). */
  private circuitOpenDay: string | null = null;

  constructor(opts: GmailSendLimiterOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.rate = new RateGate({
      emissionIntervalMs: opts.emissionIntervalMs ?? 1000,
      burst: opts.burst ?? 1,
    });
    this.sem = new AsyncSemaphore(opts.inFlightCap ?? 40);
    this.dailyCap = opts.dailyCap ?? 500;
    this.maxRetries = opts.maxRetries ?? 5;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.backoffCapMs = opts.backoffCapMs ?? 32_000;
    this.rand = opts.rand ?? Math.random;
  }

  /** Reset the daily counter when the Pacific day rolls over. */
  private rollover(day: string): void {
    if (this.budgetDay !== day) {
      this.budgetDay = day;
      this.budgetCount = 0;
    }
  }

  /**
   * Pace + gate one real send. `fn` performs the actual `adapter.send`; it is
   * called at most once per success and is retried only on a transient 429 (a
   * 429 means the send did NOT land, so a retry never double-sends).
   */
  async runGmailSend<T>(fn: () => Promise<T>): Promise<T> {
    const now = this.clock.now();
    const day = pacificDayKey(now);
    this.rollover(day);

    if (this.circuitOpenDay === day) throw new GmailDailyLimitError("circuit_open");
    if (this.budgetCount >= this.dailyCap) throw new GmailDailyLimitError("budget_exhausted");

    // RESERVE the budget slot synchronously, right after the check, BEFORE any
    // await — so N concurrent admissions can never all pass a stale count and
    // overshoot the hard cap. Released below if the send ultimately fails.
    this.budgetCount += 1;
    let succeeded = false;
    try {
      // GCRA pacing happens OUTSIDE the in-flight semaphore so a paced wait never
      // counts as an in-flight send.
      const wait = this.rate.reserve(now);
      if (wait > 0) await this.clock.sleep(wait);

      const out = await this.sem.run(() => this.attemptWithRetry(fn));
      succeeded = true;
      return out;
    } finally {
      // A send that never landed (429 exhausted, 403 daily-limit, transport
      // error, decline) does not consume the daily budget — give the slot back.
      if (!succeeded) this.budgetCount -= 1;
    }
  }

  private async attemptWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        const kind = classifyGmailError(err);
        if (kind === "daily_limit") {
          this.circuitOpenDay = pacificDayKey(this.clock.now());
          throw err;
        }
        if (kind === "rate_limited" && attempt < this.maxRetries) {
          await this.clock.sleep(
            fullJitterBackoffMs(attempt, this.backoffBaseMs, this.backoffCapMs, this.rand),
          );
          // Re-meter the retry: a circuit that opened during the backoff stops us,
          // and the retry re-paces through the rate gate so retried sends stay
          // inside the same combined ≤ 60/min guarantee as first attempts.
          if (this.circuitOpenDay === pacificDayKey(this.clock.now())) throw err;
          const reWait = this.rate.reserve(this.clock.now());
          if (reWait > 0) await this.clock.sleep(reWait);
          continue;
        }
        throw err;
      }
    }
  }
}
