/**
 * L1 unit tests — self-managed pricing table + computeCostUsd.
 *
 * Freezes the NULL-not-$0 contract (HARNESS_FRAMEWORK §"成本/时间度量"; vercel/ai
 * #3932): null tokens or an unknown model id ⇒ { costUsd: null, pricingSource:
 * "unavailable" }, never a silent $0. Pure arithmetic — no LLM, no I/O.
 */

import { describe, expect, it } from "vitest";
import {
  PRICING,
  PRICING_SOURCE,
  computeCostUsd,
} from "./pricing.js";

describe("PRICING table", () => {
  it("uses the dated ledger label", () => {
    expect(PRICING_SOURCE).toBe("deepseek-2026-06");
  });

  it("carries the two officially-priced DeepSeek V4 ids", () => {
    expect(Object.keys(PRICING).sort()).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
  });

  it("stores raw per-MTok constants from the official source", () => {
    expect(PRICING["deepseek-v4-flash"]).toEqual({
      inputUsdPerMTok: 0.14,
      outputUsdPerMTok: 0.28,
      cacheHitInputUsdPerMTok: 0.0028,
    });
    expect(PRICING["deepseek-v4-pro"]).toEqual({
      inputUsdPerMTok: 0.435,
      outputUsdPerMTok: 0.87,
      cacheHitInputUsdPerMTok: 0.003625,
    });
  });
});

describe("computeCostUsd", () => {
  it("prices a flash run at the cache-MISS input rate + output rate", () => {
    // 1M prompt @ $0.14 + 1M completion @ $0.28 = $0.42
    const result = computeCostUsd("deepseek-v4-flash", 1_000_000, 1_000_000);
    expect(result.pricingSource).toBe("deepseek-2026-06");
    expect(result.costUsd).toBeCloseTo(0.42, 12);
  });

  it("prices a pro run with its own (higher) rates", () => {
    // 500k prompt @ $0.435/M + 250k completion @ $0.87/M
    const result = computeCostUsd("deepseek-v4-pro", 500_000, 250_000);
    expect(result.pricingSource).toBe("deepseek-2026-06");
    expect(result.costUsd).toBeCloseTo(0.5 * 0.435 + 0.25 * 0.87, 12);
  });

  it("returns $0 cost (not null) for a real zero-token run", () => {
    const result = computeCostUsd("deepseek-v4-flash", 0, 0);
    expect(result.costUsd).toBe(0);
    expect(result.pricingSource).toBe("deepseek-2026-06");
  });

  it("returns NULL + unavailable when promptTokens is null (never silent $0)", () => {
    expect(computeCostUsd("deepseek-v4-flash", null, 100)).toEqual({
      costUsd: null,
      pricingSource: "unavailable",
    });
  });

  it("returns NULL + unavailable when completionTokens is null", () => {
    expect(computeCostUsd("deepseek-v4-flash", 100, null)).toEqual({
      costUsd: null,
      pricingSource: "unavailable",
    });
  });

  it("returns NULL + unavailable for an unknown model id (never invents a price)", () => {
    expect(computeCostUsd("some-unpriced-model", 1000, 1000)).toEqual({
      costUsd: null,
      pricingSource: "unavailable",
    });
  });
});
