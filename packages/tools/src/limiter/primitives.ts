/**
 * Pacing primitives shared by the LimiterRegistry. Pure/deterministic — no I/O,
 * no clock of their own (callers pass `now`), so they unit-test exactly.
 *
 * Dependency wall: imports nothing.
 */

// ---------------------------------------------------------------------------
// RateGate — GCRA (Generic Cell Rate Algorithm), the leaky-bucket meter in its
// throttling (delay, never reject) form. One TAT (theoretical arrival time)
// value paces a stream to ≤ 1 emission per `emissionIntervalMs`, tolerating a
// short burst of `burst` cells. A token bucket of capacity `burst` refilling at
// 1/interval is the mathematical dual — same guarantee, expressed as one number.
// ---------------------------------------------------------------------------

export interface RateGateOptions {
  /** Steady-state spacing between emissions (e.g. 1000ms → ≤ 60/min). */
  emissionIntervalMs: number;
  /** How many cells may emit back-to-back before pacing kicks in. Default 1
   *  (zero extra burst — the strictest "never exceeds the rate" posture). */
  burst?: number;
}

export class RateGate {
  /** Theoretical arrival time: the instant the bucket next drains to admit a
   *  cell at the steady rate. 0 acts as -∞ for real epoch-ms clocks. */
  private tat = 0;
  private readonly intervalMs: number;
  private readonly tau: number;

  constructor(opts: RateGateOptions) {
    this.intervalMs = opts.emissionIntervalMs;
    // Delay-variation tolerance: a burst of B cells = (B-1) intervals of slack.
    this.tau = Math.max(0, (opts.burst ?? 1) - 1) * opts.emissionIntervalMs;
  }

  /**
   * Reserve one emission slot for a request arriving at `now`; returns the ms to
   * wait before emitting (0 = conforming, emit immediately). Advances internal
   * state so the NEXT reserve is paced behind this one — call exactly once per
   * admitted request.
   */
  reserve(now: number): number {
    const earliest = this.tat - this.tau; // earliest this cell may emit
    const wait = Math.max(0, earliest - now);
    const effectiveArrival = now + wait; // == max(now, earliest)
    this.tat = Math.max(this.tat, effectiveArrival) + this.intervalMs;
    return wait;
  }
}

// ---------------------------------------------------------------------------
// AsyncSemaphore — a FIFO counting semaphore. Caps the number of concurrent
// holders at `max`; waiters are granted freed slots in arrival order.
// ---------------------------------------------------------------------------

export class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  /** Holders currently inside the gate (for tests/observability). */
  get inFlight(): number {
    return this.active;
  }

  /** Acquire one slot; resolves immediately when one is free, else parks FIFO.
   *  The slow path does NOT increment `active`: a waiter is woken only by
   *  `release()` HANDING it the slot it already held, so the permit is never
   *  double-counted (the fix for the over-admission race). */
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    // Slot transferred from release() — `active` already accounts for us.
  }

  /** Release one slot. If a waiter is parked, HAND it the freed slot directly
   *  (leave `active` unchanged so no fast-path acquire can slip onto the same
   *  slot in the wake gap); otherwise return the slot to the pool. */
  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next(); // transfer: this holder leaves, the woken waiter takes its slot.
    } else {
      this.active -= 1;
    }
  }

  /** Run `fn` holding exactly one slot; the slot is always released. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// ---------------------------------------------------------------------------
// pacificDayKey — the America/Los_Angeles calendar day (YYYY-MM-DD) an instant
// falls in. The Gmail daily-send budget resets at midnight Pacific; comparing
// day keys handles DST automatically (Intl owns the offset).
// ---------------------------------------------------------------------------

// en-CA renders "YYYY-MM-DD", which sorts and compares as a stable day key.
const PACIFIC_DAY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function pacificDayKey(epochMs: number): string {
  return PACIFIC_DAY_FMT.format(new Date(epochMs));
}

// ---------------------------------------------------------------------------
// fullJitterBackoffMs — full-jitter exponential backoff: a uniform draw over
// [0, min(cap, base·2^attempt)). Used for the Gmail 429 retry. `rand` is
// injectable so tests are deterministic.
// ---------------------------------------------------------------------------

export function fullJitterBackoffMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  rand: () => number = Math.random,
): number {
  return rand() * Math.min(capMs, baseMs * 2 ** attempt);
}
