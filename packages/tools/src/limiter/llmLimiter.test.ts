/**
 * Per-provider LLM rate limiter — a token bucket (GCRA) per provider so N
 * concurrent pipelines don't burst one provider past its RPM. Generous defaults
 * (a real skill run is never paced); deterministic here via a VirtualClock.
 */

import { describe, expect, it } from "vitest";

import { VirtualClock } from "./clock.js";
import { LlmRateLimiter } from "./llmLimiter.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("LlmRateLimiter.acquireLlm", () => {
  it("admits the first call immediately, then paces a provider's stream", async () => {
    const clock = new VirtualClock(0);
    const limiter = new LlmRateLimiter({ clock, emissionIntervalMs: 100, burst: 1 });
    const at: number[] = [];
    const acq = async () => {
      await limiter.acquireLlm("deepseek");
      at.push(clock.now());
    };
    const all = [acq(), acq(), acq()];
    await tick();
    expect(at).toEqual([0]);
    await clock.advance(100);
    expect(at).toEqual([0, 100]);
    await clock.advance(100);
    await Promise.all(all);
    expect(at).toEqual([0, 100, 200]);
  });

  it("paces each provider independently", async () => {
    const clock = new VirtualClock(0);
    const limiter = new LlmRateLimiter({ clock, emissionIntervalMs: 100, burst: 1 });
    const at: Record<string, number[]> = { deepseek: [], anthropic: [] };
    const acq = async (p: string) => {
      await limiter.acquireLlm(p);
      at[p]!.push(clock.now());
    };
    // One call to each provider — neither paces the other.
    await Promise.all([acq("deepseek"), acq("anthropic")]);
    expect(at.deepseek).toEqual([0]);
    expect(at.anthropic).toEqual([0]);
  });

  it("allows a burst then paces", async () => {
    const clock = new VirtualClock(0);
    const limiter = new LlmRateLimiter({ clock, emissionIntervalMs: 100, burst: 3 });
    const at: number[] = [];
    const acq = async () => {
      await limiter.acquireLlm("openai");
      at.push(clock.now());
    };
    const all = [acq(), acq(), acq(), acq()];
    await tick();
    expect(at).toEqual([0, 0, 0]); // burst of 3
    await clock.advance(100);
    await Promise.all(all);
    expect(at).toEqual([0, 0, 0, 100]);
  });
});
