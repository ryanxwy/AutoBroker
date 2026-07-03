/**
 * policy() routing — policyForAlias() and withProvider() helper coverage plus the
 * ALIAS_MODEL_ID ↔ registry sync guard.
 */

import { describe, expect, it } from "vitest";

import { ALIAS_MODEL_ID, aliasForModelId, policy, policyForAlias, withProvider } from "./policy.js";
import { registry } from "./registry.js";
import type { ModelAlias } from "@autobroker/core";

describe("policyForAlias()", () => {
  it("resolves anthropic.chat → provider anthropic + supportsOutputObjectWithTools true", () => {
    const res = policyForAlias("anthropic.chat");
    expect(res.provider).toBe("anthropic");
    expect(res.alias).toBe("anthropic.chat");
    expect(res.capabilities.supportsOutputObjectWithTools).toBe(true);
  });

  it("resolves deepseek.chat → supportsOutputObjectWithTools false", () => {
    const res = policyForAlias("deepseek.chat");
    expect(res.provider).toBe("deepseek");
    expect(res.capabilities.supportsOutputObjectWithTools).toBe(false);
  });

  it("throws loudly on an alias with no capabilities row", () => {
    // deepseek.reasoner is no longer a registered tier (removed from MODEL_TIERS),
    // so it has no ALIAS_CAPABILITIES entry — policyForAlias must fail loud, not
    // silently down-route. Cast through unknown since it is no longer a ModelAlias.
    expect(() =>
      policyForAlias("deepseek.reasoner" as unknown as Parameters<typeof policyForAlias>[0]),
    ).toThrow(/no CapabilityFlags registered/);
  });
});

describe("withProvider()", () => {
  it('withProvider("deepseek.chat", "anthropic") === "anthropic.chat"', () => {
    expect(withProvider("deepseek.chat", "anthropic")).toBe("anthropic.chat");
  });

  it('withProvider("deepseek.strong", "anthropic") === "anthropic.strong"', () => {
    expect(withProvider("deepseek.strong", "anthropic")).toBe("anthropic.strong");
  });
});

describe("aliasForModelId()", () => {
  it("claude-opus-4-8 → anthropic.strong", () => {
    expect(aliasForModelId("claude-opus-4-8")).toBe("anthropic.strong");
  });

  it("claude-sonnet-4-6 → anthropic.chat", () => {
    expect(aliasForModelId("claude-sonnet-4-6")).toBe("anthropic.chat");
  });

  it("deepseek-v4-pro → deepseek.strong", () => {
    expect(aliasForModelId("deepseek-v4-pro")).toBe("deepseek.strong");
  });

  it("unknown id → null", () => {
    expect(aliasForModelId("nope")).toBeNull();
  });
});

describe("policy() still returns correct resolution after refactor", () => {
  it("cross_provider_smoke routes to anthropic.chat with supportsOutputObjectWithTools true", () => {
    const res = policy("cross_provider_smoke");
    expect(res.useCase).toBe("cross_provider_smoke");
    expect(res.alias).toBe("anthropic.chat");
    expect(res.provider).toBe("anthropic");
    expect(res.capabilities.supportsOutputObjectWithTools).toBe(true);
  });

  it("dealer_reply_extract routes to deepseek.chat with supportsOutputObjectWithTools false", () => {
    const res = policy("dealer_reply_extract");
    expect(res.useCase).toBe("dealer_reply_extract");
    expect(res.alias).toBe("deepseek.chat");
    expect(res.provider).toBe("deepseek");
    expect(res.capabilities.supportsOutputObjectWithTools).toBe(false);
  });
});

describe("ALIAS_MODEL_ID ↔ registry sync guard", () => {
  // Every alias in the policy map must resolve, in the registry, to the exact
  // same concrete model id. This catches registry/policy drift at `pnpm test`.
  it.each(Object.keys(ALIAS_MODEL_ID) as ModelAlias[])(
    "registry.languageModel(%s).modelId === ALIAS_MODEL_ID[alias]",
    (alias) => {
      const model = registry.languageModel(alias);
      const modelId = typeof model === "string" ? model : model.modelId;
      expect(modelId).toBe(ALIAS_MODEL_ID[alias]);
    },
  );
});
