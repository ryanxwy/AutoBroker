/**
 * L1 unit tests — chooseStructuredOutputStrategy (the #1244 strategy gate).
 *
 * Freezes the pure decision (the layer-ownership decision): the model layer
 * picks emit_result vs output_object SOLELY from the capability flag
 * `supportsOutputObjectWithTools`, never from a provider name. Pure function —
 * no LLM, no I/O, no framework.
 */

import { describe, expect, it } from "vitest";
import type { CapabilityFlags } from "@autobroker/core";
import { chooseStructuredOutputStrategy } from "./harness.js";

const baseCaps: CapabilityFlags = {
  supportsToolCalls: true,
  supportsOutputObjectWithTools: true,
  strictJsonSchema: true,
  supportsVision: true,
  reportsUsageTokens: true,
};

describe("chooseStructuredOutputStrategy", () => {
  it("returns 'emit_result' when the model CANNOT mix object output + tools (DeepSeek/#1244)", () => {
    expect(
      chooseStructuredOutputStrategy({
        ...baseCaps,
        supportsOutputObjectWithTools: false,
      }),
    ).toBe("emit_result");
  });

  it("returns 'output_object' when the model CAN mix object output + tools", () => {
    expect(
      chooseStructuredOutputStrategy({
        ...baseCaps,
        supportsOutputObjectWithTools: true,
      }),
    ).toBe("output_object");
  });

  it("keys off supportsOutputObjectWithTools alone, ignoring other flags", () => {
    // Flip every OTHER flag; the strategy must still follow the one flag.
    expect(
      chooseStructuredOutputStrategy({
        supportsToolCalls: false,
        supportsOutputObjectWithTools: false,
        strictJsonSchema: false,
        supportsVision: false,
        reportsUsageTokens: false,
      }),
    ).toBe("emit_result");
  });
});
