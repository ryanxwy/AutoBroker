/**
 * Injectable clock for the LimiterRegistry. Production paces against wall time
 * (`systemClock`); tests drive a deterministic `VirtualClock` so rate/window
 * assertions never depend on real elapsed time.
 *
 * Dependency wall: pure — imports nothing. Lives in the tools layer because the
 * limiters that consume it (the only external-I/O pacing) live here.
 */

/** The two time capabilities every limiter needs: read now, and yield for `ms`. */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** Resolve after `ms` (non-negative; 0/negative resolves on the next turn). */
  sleep(ms: number): Promise<void>;
}

/** Real wall-clock — the production clock. `sleep` yields the event loop (never
 *  the synchronous Atomics.wait freeze the incentive lock used to do). */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

/**
 * Deterministic test clock. `now()` returns the virtual time; `sleep(ms)` parks
 * until `advance()` carries virtual time past the wake instant. `advance` flushes
 * due sleepers in wake-time order, so a test can step time and observe paced work
 * release exactly when it should — no real waiting, no flakiness.
 */
export class VirtualClock implements Clock {
  private t: number;
  private seq = 0;
  private waiters: Array<{ at: number; seq: number; resolve: () => void }> = [];

  constructor(startMs = 0) {
    this.t = startMs;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    const at = this.t + ms;
    return new Promise<void>((resolve) => {
      this.waiters.push({ at, seq: this.seq++, resolve });
    });
  }

  /** Advance virtual time by `ms`, waking (in wake-time then FIFO order) every
   *  sleeper now due. Awaits a microtask flush so awaited continuations run. */
  async advance(ms: number): Promise<void> {
    this.t += ms;
    let due = this.waiters
      .filter((w) => w.at <= this.t)
      .sort((a, b) => a.at - b.at || a.seq - b.seq);
    this.waiters = this.waiters.filter((w) => w.at > this.t);
    for (const w of due) {
      w.resolve();
      // Flush microtasks between wakes so a continuation that schedules a new
      // sleep at the current instant is itself observed on this advance.
      await Promise.resolve();
    }
    // A continuation woken above may have queued a fresh sleeper already due at
    // the current `t` (e.g. acquire→reserve→sleep(0)); drain those too.
    while ((due = this.waiters.filter((w) => w.at <= this.t)).length > 0) {
      this.waiters = this.waiters.filter((w) => w.at > this.t);
      for (const w of due.sort((a, b) => a.at - b.at || a.seq - b.seq)) {
        w.resolve();
        await Promise.resolve();
      }
    }
  }
}
