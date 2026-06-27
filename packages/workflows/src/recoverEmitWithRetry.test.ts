/**
 * recoverEmitWithRetry — orchestration tests over a FAKE harnessGenerate.
 *
 * The REAL agent → processor → #1244 detector → ledger chain is already proven in
 * harness.test.ts; here we exercise ONLY the helper's orchestration (which hop
 * runs, when a retry fires, when it fails closed) with a fake whose behavior keys
 * on `input.useCase`.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  MalformedToolCallAbort,
  type HarnessGenerateInput,
  type HarnessGenerateResult,
  type HarnessSuspend,
  type UseCase,
} from "@autobroker/model";

import type { harness, HarnessLedgerContext } from "./harness.js";
import {
  __recoveryBudgetSizeForTests,
  __resetRecoveryBudgetForTests,
  recoverEmitWithRetry,
} from "./recoverEmitWithRetry.js";

const SCHEMA = z.object({ ok: z.boolean() });
type Schema = typeof SCHEMA;

const CLEAN_RESULT: HarnessGenerateResult<z.infer<Schema>> = {
  object: { ok: true },
  usage: {
    costUsd: null,
    durationMs: 1,
    pricingSource: "unavailable",
    promptTokens: null,
    completionTokens: null,
  },
};

const LEDGER: HarnessLedgerContext = {
  runId: "run-1",
  skill: "test",
  layer: "L2",
  promptVersion: null,
  schemaVersion: null,
};

const PRIMARY: UseCase = "inventory_extract";
const RETRY: UseCase = "inventory_extract_retry";

function baseInput(useCase: UseCase, hitlAvailable = false): HarnessGenerateInput<Schema> {
  return { useCase, schema: SCHEMA, prompt: "fenced page snapshot", hitlAvailable };
}

/** A fake harnessGenerate whose per-call behavior keys on input.useCase, plus a
 *  call counter. Cast to the public `typeof harness.generate` so it slots into
 *  the helper exactly as the real facade would. */
function makeFake(
  behavior: (useCase: UseCase) => Promise<HarnessGenerateResult<z.infer<Schema>> | HarnessSuspend>,
): { fn: typeof harness.generate; calls: () => number } {
  let calls = 0;
  const fn = (async (input: HarnessGenerateInput<Schema>, _ledger: HarnessLedgerContext) => {
    calls += 1;
    return behavior(input.useCase);
  }) as unknown as typeof harness.generate;
  return { fn, calls: () => calls };
}

beforeEach(() => {
  __resetRecoveryBudgetForTests();
});

describe("recoverEmitWithRetry", () => {
  it("recovers: a malformed first hop retries ONCE and returns the clean retry result", async () => {
    const fake = makeFake(async (uc) => {
      if (uc === PRIMARY) {
        throw new MalformedToolCallAbort(["finish_reason_not_tool_calls", "empty_tool_calls"]);
      }
      return CLEAN_RESULT;
    });

    const res = await recoverEmitWithRetry({
      harnessGenerate: fake.fn,
      input: baseInput(PRIMARY),
      retryUseCase: RETRY,
      ledger: LEDGER,
    });

    expect(res.object).toEqual({ ok: true });
    expect(fake.calls()).toBe(2);
  });

  it("second failure propagates: both hops malformed → rejects, no swallow, exactly two calls", async () => {
    const fake = makeFake(async () => {
      throw new MalformedToolCallAbort(["empty_tool_calls"]);
    });

    await expect(
      recoverEmitWithRetry({
        harnessGenerate: fake.fn,
        input: baseInput(PRIMARY),
        retryUseCase: RETRY,
        ledger: LEDGER,
      }),
    ).rejects.toBeInstanceOf(MalformedToolCallAbort);
    expect(fake.calls()).toBe(2);
  });

  it("hitlAvailable=true → throws BEFORE any hop", async () => {
    const fake = makeFake(async () => CLEAN_RESULT);

    await expect(
      recoverEmitWithRetry({
        harnessGenerate: fake.fn,
        input: baseInput(PRIMARY, true),
        retryUseCase: RETRY,
        ledger: LEDGER,
      }),
    ).rejects.toThrow(/no-HITL/i);
    expect(fake.calls()).toBe(0);
  });

  it("provider guard: a non-deepseek retryUseCase throws BEFORE any hop", async () => {
    const fake = makeFake(async () => CLEAN_RESULT);

    await expect(
      recoverEmitWithRetry({
        harnessGenerate: fake.fn,
        input: baseInput(PRIMARY),
        // cross_provider_smoke routes to anthropic → must be refused.
        retryUseCase: "cross_provider_smoke",
        ledger: LEDGER,
      }),
    ).rejects.toThrow(/deepseek/i);
    expect(fake.calls()).toBe(0);
  });

  it("blob-only signal → no retry, fails closed on the first hop", async () => {
    const fake = makeFake(async () => {
      throw new MalformedToolCallAbort(["tool_shaped_blob_in_content"]);
    });

    await expect(
      recoverEmitWithRetry({
        harnessGenerate: fake.fn,
        input: baseInput(PRIMARY),
        retryUseCase: RETRY,
        ledger: LEDGER,
      }),
    ).rejects.toBeInstanceOf(MalformedToolCallAbort);
    expect(fake.calls()).toBe(1);
  });

  it("non-malformed error → no retry, rethrown on the first hop", async () => {
    const fake = makeFake(async () => {
      throw new Error("transport boom");
    });

    await expect(
      recoverEmitWithRetry({
        harnessGenerate: fake.fn,
        input: baseInput(PRIMARY),
        retryUseCase: RETRY,
        ledger: LEDGER,
      }),
    ).rejects.toThrow("transport boom");
    expect(fake.calls()).toBe(1);
  });

  it("budget: after K=8 retries on one run, the next call does NOT retry", async () => {
    const fake = makeFake(async () => {
      throw new MalformedToolCallAbort(["empty_tool_calls"]);
    });

    // 8 calls, each consuming one retry (2 hops apiece) → budget exhausted.
    for (let i = 0; i < 8; i += 1) {
      await expect(
        recoverEmitWithRetry({
          harnessGenerate: fake.fn,
          input: baseInput(PRIMARY),
          retryUseCase: RETRY,
          ledger: LEDGER,
        }),
      ).rejects.toBeInstanceOf(MalformedToolCallAbort);
    }
    expect(fake.calls()).toBe(16);

    // 9th call on the SAME runId: budget exhausted → first hop only, no retry.
    const before = fake.calls();
    await expect(
      recoverEmitWithRetry({
        harnessGenerate: fake.fn,
        input: baseInput(PRIMARY),
        retryUseCase: RETRY,
        ledger: LEDGER,
      }),
    ).rejects.toBeInstanceOf(MalformedToolCallAbort);
    expect(fake.calls() - before).toBe(1);
  });

  it("budget Map stays bounded under many distinct runIds (eviction, not a leak)", async () => {
    const fake = makeFake(async () => {
      throw new MalformedToolCallAbort(["empty_tool_calls"]);
    });

    // 1100 distinct runIds (> the 1024 ceiling), each consuming one retry slot →
    // without eviction the Map would hold 1100 entries.
    for (let i = 0; i < 1100; i += 1) {
      await expect(
        recoverEmitWithRetry({
          harnessGenerate: fake.fn,
          input: baseInput(PRIMARY),
          retryUseCase: RETRY,
          ledger: { ...LEDGER, runId: `run-${i}` },
        }),
      ).rejects.toBeInstanceOf(MalformedToolCallAbort);
    }

    expect(__recoveryBudgetSizeForTests()).toBeLessThanOrEqual(1024);
  });

  it("multi-signal set CONTAINING blob DOES retry (gate excludes only the exact blob-only set)", async () => {
    const fake = makeFake(async (uc) => {
      if (uc === PRIMARY) {
        throw new MalformedToolCallAbort(["tool_shaped_blob_in_content", "empty_tool_calls"]);
      }
      return CLEAN_RESULT;
    });

    const res = await recoverEmitWithRetry({
      harnessGenerate: fake.fn,
      input: baseInput(PRIMARY),
      retryUseCase: RETRY,
      ledger: LEDGER,
    });

    expect(res.object).toEqual({ ok: true });
    expect(fake.calls()).toBe(2);
  });

  it("AI_InvalidToolInputError (no signals, #1069-class) retries by name", async () => {
    const fake = makeFake(async (uc) => {
      if (uc === PRIMARY) {
        throw Object.assign(new Error("invalid tool input"), { name: "AI_InvalidToolInputError" });
      }
      return CLEAN_RESULT;
    });

    const res = await recoverEmitWithRetry({
      harnessGenerate: fake.fn,
      input: baseInput(PRIMARY),
      retryUseCase: RETRY,
      ledger: LEDGER,
    });

    expect(res.object).toEqual({ ok: true });
    expect(fake.calls()).toBe(2);
  });

  it("retry is a FRESH generation over the ORIGINAL prompt (only useCase is swapped)", async () => {
    const input = baseInput(PRIMARY);
    const seen: HarnessGenerateInput<Schema>[] = [];
    const fn = (async (i: HarnessGenerateInput<Schema>, _ledger: HarnessLedgerContext) => {
      seen.push(i);
      if (i.useCase === PRIMARY) {
        throw new MalformedToolCallAbort(["empty_tool_calls"]);
      }
      return CLEAN_RESULT;
    }) as unknown as typeof harness.generate;

    const res = await recoverEmitWithRetry({
      harnessGenerate: fn,
      input,
      retryUseCase: RETRY,
      ledger: LEDGER,
    });

    expect(res.object).toEqual({ ok: true });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.useCase).toBe(PRIMARY);
    // The retry swapped ONLY the useCase: prompt + schema + hitlAvailable carry the
    // original input verbatim (the `{ ...input }` spread, no conversation resume).
    expect(seen[1]?.useCase).toBe(RETRY);
    expect(seen[1]?.prompt).toBe(input.prompt);
    expect(seen[1]?.schema).toBe(input.schema);
    expect(seen[1]?.hitlAvailable).toBe(false);
  });
});
