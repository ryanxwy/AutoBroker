/**
 * L1 unit tests — the test-only generate-fault seam (T4-U2).
 *
 * Freezes that arming a fault makes the NEXT resolved model FAIL CLOSED on
 * doGenerate/doStream (a provider-5xx / hung-request twin) and disarms cleanly.
 * The model layer only owns "the resolved model rejects"; the workflows harness
 * .catch() turns that reject into a NULL-not-$0 ledger row + re-throw (covered by
 * the workflows harness.test.ts). Here we assert the seam itself, no live LLM —
 * the wrapper short-circuits doGenerate before any network call.
 */
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetHarnessGenerateFaultForTests,
  __setHarnessGenerateFaultForTests,
  resolveModel,
} from "./index.js";

afterEach(() => __resetHarnessGenerateFaultForTests());

const probeArgs = {} as Parameters<LanguageModelV3["doGenerate"]>[0];

describe("generate-fault seam (resolveModel wrapper)", () => {
  it("disarmed: resolves the real registry model (identity preserved, no throw)", () => {
    const model = resolveModel("deepseek.cheap") as LanguageModelV3;
    expect(model.specificationVersion).toBe("v3");
    expect(model.modelId).toBe("deepseek-v4-flash"); // real route preserved for pricing.
  });

  it("llm_500: the resolved model's doGenerate rejects (fails closed, no fabricated result)", async () => {
    __setHarnessGenerateFaultForTests("llm_500");
    const model = resolveModel("deepseek.cheap") as LanguageModelV3;
    expect(model.modelId).toBe("deepseek-v4-flash"); // identity preserved → real ledger row.
    await expect(model.doGenerate(probeArgs)).rejects.toThrow(/llm_500/);
  });

  it("llm_timeout: doGenerate rejects after a delay (reject, never a hallucinated success)", async () => {
    __setHarnessGenerateFaultForTests("llm_timeout");
    const model = resolveModel("deepseek.cheap") as LanguageModelV3;
    await expect(model.doGenerate(probeArgs)).rejects.toThrow(/llm_timeout/);
  });

  it("disarms cleanly: after reset, the next resolved model is the real one again", () => {
    __setHarnessGenerateFaultForTests("llm_500");
    __resetHarnessGenerateFaultForTests();
    const model = resolveModel("deepseek.cheap") as LanguageModelV3;
    expect(model.modelId).toBe("deepseek-v4-flash"); // the real registry model, not the wrapper.
  });

  it("guard: the arm refuses outside a test runner", () => {
    const vitest = process.env["VITEST"];
    const nodeEnv = process.env["NODE_ENV"];
    delete process.env["VITEST"];
    process.env["NODE_ENV"] = "production";
    try {
      expect(() => __setHarnessGenerateFaultForTests("llm_500")).toThrow(/test-only seam/);
    } finally {
      if (vitest !== undefined) process.env["VITEST"] = vitest;
      else delete process.env["VITEST"];
      if (nodeEnv !== undefined) process.env["NODE_ENV"] = nodeEnv;
      else delete process.env["NODE_ENV"];
    }
  });
});
