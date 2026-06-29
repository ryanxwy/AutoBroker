/**
 * types.test — the driver_kind label derivations. providerDriverKind maps an
 * api-key Provider to `{provider}_apikey`; selectionDriverKind is METHOD-AWARE so
 * the Claude OAuth subscription lane (anthropic+oauth) reads `anthropic_oauth`,
 * not `anthropic_apikey` (the run-chip-mislabel fix).
 */

import { describe, expect, it } from "vitest";

import { providerDriverKind, selectionDriverKind } from "./types.js";

describe("providerDriverKind — api-key provider→label", () => {
  it("maps each provider to its {provider}_apikey label", () => {
    expect(providerDriverKind("deepseek")).toBe("deepseek_apikey");
    expect(providerDriverKind("anthropic")).toBe("anthropic_apikey");
    expect(providerDriverKind("openai")).toBe("openai_apikey");
  });
});

describe("selectionDriverKind — method-aware selection→label", () => {
  it("anthropic + oauth → anthropic_oauth (the subscription lane, NOT apikey)", () => {
    expect(selectionDriverKind("anthropic", "oauth")).toBe("anthropic_oauth");
  });

  it("anthropic + apikey → anthropic_apikey (the cross-provider api-key lane)", () => {
    expect(selectionDriverKind("anthropic", "apikey")).toBe("anthropic_apikey");
  });

  it("non-anthropic providers ignore method and resolve to their apikey label", () => {
    expect(selectionDriverKind("deepseek", "apikey")).toBe("deepseek_apikey");
    // oauth is anthropic-only today; a non-anthropic oauth still falls back to apikey.
    expect(selectionDriverKind("openai", "oauth")).toBe("openai_apikey");
  });
});
