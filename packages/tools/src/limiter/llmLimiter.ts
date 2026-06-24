/**
 * Per-provider LLM rate limiter — one token bucket (GCRA) per provider so that
 * N concurrent pipelines fanning out to the same provider don't burst it past
 * its RPM. Sits BELOW the L2 gate; it only paces calls the workflow already
 * decided to make.
 *
 * Defaults are generous (a single skill run is never paced — the burst absorbs
 * a normal multi-step run); the cap bites only under heavy concurrent fan-out.
 * Deterministic in tests via an injected clock.
 *
 * Dependency wall: pure within tools.
 */

import { systemClock, type Clock } from "./clock.js";
import { RateGate } from "./primitives.js";

/** ~600 calls/min steady state. */
const DEFAULT_EMISSION_INTERVAL_MS = 100;
/** A full skill run's burst of steps drains free before pacing engages. */
const DEFAULT_BURST = 60;

export interface LlmRateLimiterOptions {
  clock?: Clock;
  emissionIntervalMs?: number;
  burst?: number;
}

export class LlmRateLimiter {
  private readonly clock: Clock;
  private readonly emissionIntervalMs: number;
  private readonly burst: number;
  private readonly gates = new Map<string, RateGate>();

  constructor(opts: LlmRateLimiterOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.emissionIntervalMs = opts.emissionIntervalMs ?? DEFAULT_EMISSION_INTERVAL_MS;
    this.burst = opts.burst ?? DEFAULT_BURST;
  }

  private gate(provider: string): RateGate {
    let g = this.gates.get(provider);
    if (g === undefined) {
      g = new RateGate({ emissionIntervalMs: this.emissionIntervalMs, burst: this.burst });
      this.gates.set(provider, g);
    }
    return g;
  }

  /** Reserve one call slot for `provider`, waiting out the pace if needed. */
  async acquireLlm(provider: string): Promise<void> {
    const wait = this.gate(provider).reserve(this.clock.now());
    if (wait > 0) await this.clock.sleep(wait);
  }
}
