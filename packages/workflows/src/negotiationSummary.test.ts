/**
 * negotiation_summary unit tests — the advisory projection drives the REAL
 * function (short-circuit, cache, fail-closed) against a STUBBED harness + a
 * fixed reply-body read. No real LLM, no DB.
 *
 * Coverage:
 *   - success → the generated prose summary is returned.
 *   - generate throws → {summary:null} (degrade).
 *   - budget in the output → {summary:null} (the assertNoBudget belt throws,
 *     caught → null; NOT cached).
 *   - empty body set → {summary:null} with ZERO harness calls (short-circuit).
 *   - cache hit on the same sig → a second call does NOT re-invoke the harness.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getOrGenerateDealerNegotiationSummary,
  __setNegotiationSummaryDepsForTests,
  __resetNegotiationSummaryDepsForTests,
  type NegotiationSummaryDeps,
} from "./negotiationSummary.js";

const NO_USAGE = {
  costUsd: null,
  durationMs: 0,
  pricingSource: "unavailable" as const,
  promptTokens: null,
  completionTokens: null,
};

/** A harness stub returning a FIXED emit object for every call. */
function harnessFixed(summary: string): NegotiationSummaryDeps["generate"] {
  return (async () => ({
    object: { summary },
    usage: NO_USAGE,
  })) as unknown as NegotiationSummaryDeps["generate"];
}

/** A readBodies stub returning a FIXED body set for every (profile, dealer). */
function bodiesFixed(bodies: string[]): NegotiationSummaryDeps["readBodies"] {
  return (() => bodies) as unknown as NegotiationSummaryDeps["readBodies"];
}

// The db handle is never touched by the stub readBodies — a sentinel is fine.
const DB = {} as Parameters<typeof getOrGenerateDealerNegotiationSummary>[0];
const ARGS = { profileId: "p-1", dealerId: "d-1" };

afterEach(() => {
  __resetNegotiationSummaryDepsForTests();
});

describe("getOrGenerateDealerNegotiationSummary", () => {
  it("returns the generated prose summary on success", async () => {
    __setNegotiationSummaryDepsForTests({
      readBodies: bodiesFixed(["We can do $32,500 out the door on the SEL."]),
      generate: harnessFixed("The dealer countered at a firm OTD; still room to push."),
    });

    const result = await getOrGenerateDealerNegotiationSummary(DB, ARGS);
    expect(result.summary).toBe("The dealer countered at a firm OTD; still room to push.");
  });

  it("degrades to null when the harness throws", async () => {
    const generate = (async () => {
      throw new Error("transport boom");
    }) as unknown as NegotiationSummaryDeps["generate"];
    __setNegotiationSummaryDepsForTests({
      readBodies: bodiesFixed(["A real quote body."]),
      generate,
    });

    const result = await getOrGenerateDealerNegotiationSummary(DB, ARGS);
    expect(result.summary).toBeNull();
  });

  it("degrades to null when the output leaks a budget (assertNoBudget belt)", async () => {
    __setNegotiationSummaryDepsForTests({
      readBodies: bodiesFixed(["A real quote body."]),
      generate: harnessFixed("The buyer's budget is $30,000 so we are close."),
    });

    const result = await getOrGenerateDealerNegotiationSummary(DB, ARGS);
    expect(result.summary).toBeNull();
  });

  it("short-circuits an empty body set to null with NO harness call", async () => {
    const generate = vi.fn();
    __setNegotiationSummaryDepsForTests({
      readBodies: bodiesFixed([]),
      generate: generate as unknown as NegotiationSummaryDeps["generate"],
    });

    const result = await getOrGenerateDealerNegotiationSummary(DB, ARGS);
    expect(result.summary).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it("serves the cache on the same sig (a second call does not re-invoke the harness)", async () => {
    const generate = vi.fn(async () => ({
      object: { summary: "cached read" },
      usage: NO_USAGE,
    }));
    __setNegotiationSummaryDepsForTests({
      readBodies: bodiesFixed(["Same body set every call."]),
      generate: generate as unknown as NegotiationSummaryDeps["generate"],
    });

    const first = await getOrGenerateDealerNegotiationSummary(DB, ARGS);
    const second = await getOrGenerateDealerNegotiationSummary(DB, ARGS);

    expect(first.summary).toBe("cached read");
    expect(second.summary).toBe("cached read");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("re-generates when the body set (sig) changes", async () => {
    const generate = vi.fn(async () => ({
      object: { summary: "fresh read" },
      usage: NO_USAGE,
    }));
    let bodies = ["first body set"];
    __setNegotiationSummaryDepsForTests({
      readBodies: (() => bodies) as unknown as NegotiationSummaryDeps["readBodies"],
      generate: generate as unknown as NegotiationSummaryDeps["generate"],
    });

    await getOrGenerateDealerNegotiationSummary(DB, ARGS);
    bodies = ["a different body set"];
    await getOrGenerateDealerNegotiationSummary(DB, ARGS);

    expect(generate).toHaveBeenCalledTimes(2);
  });
});
