/**
 * policy() routing — the four shared malformed-class recovery hops.
 *
 * Each *_retry useCase must route to the `deepseek.strong` alias on the deepseek
 * provider: the recoverEmitWithRetry helper asserts the provider is deepseek
 * (same-provider, privacy-clean — no cross-provider egress), so this binding is
 * load-bearing for the closure.
 */

import { describe, expect, it } from "vitest";

import { policy } from "./policy.js";
import type { UseCase } from "./policy.js";

const RETRY_USE_CASES: UseCase[] = [
  "geosearch_extract_retry",
  "inventory_extract_retry",
  "incentive_extract_retry",
  "lead_form_map_retry",
];

describe("policy() — malformed-class recovery routes", () => {
  it.each(RETRY_USE_CASES)(
    "%s routes to deepseek.strong on the deepseek provider",
    (useCase) => {
      const resolved = policy(useCase);
      expect(resolved.alias).toBe("deepseek.strong");
      expect(resolved.provider).toBe("deepseek");
    },
  );

  it("the original dealer_reply_extract_retry still routes to deepseek.strong", () => {
    const resolved = policy("dealer_reply_extract_retry");
    expect(resolved.alias).toBe("deepseek.strong");
    expect(resolved.provider).toBe("deepseek");
  });
});
