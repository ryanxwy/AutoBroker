/**
 * Tests for AgentSelection schema + parseAgentSelection.
 * Written before implementation (TDD).
 */

import { describe, expect, it } from "vitest";
import {
  AgentSelectionSchema,
  parseAgentSelection,
  type AgentSelection,
} from "./agentSelection.js";

describe("AgentSelectionSchema", () => {
  it("accepts a valid anthropic+oauth payload", () => {
    const result = AgentSelectionSchema.safeParse({
      provider: "anthropic",
      method: "oauth",
      model: "claude-opus-4-8",
      effort: "high",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid deepseek+apikey payload", () => {
    const result = AgentSelectionSchema.safeParse({
      provider: "deepseek",
      method: "apikey",
      model: null,
      effort: "off",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown provider", () => {
    const result = AgentSelectionSchema.safeParse({
      provider: "openai",
      method: "apikey",
      model: null,
      effort: "off",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown effort value", () => {
    const result = AgentSelectionSchema.safeParse({
      provider: "anthropic",
      method: "apikey",
      model: null,
      effort: "extreme",
    });
    expect(result.success).toBe(false);
  });
});

describe("parseAgentSelection", () => {
  it("maps provider:'claude' to 'anthropic' and preserves oauth + model + effort", () => {
    const result = parseAgentSelection({
      provider: "claude",
      method: "oauth",
      model: "claude-opus-4-8",
      effort: "high",
    });
    expect(result).toEqual<AgentSelection>({
      provider: "anthropic",
      method: "oauth",
      model: "claude-opus-4-8",
      effort: "high",
    });
  });

  it("parses deepseek+apikey with defaults for model and effort", () => {
    const result = parseAgentSelection({ provider: "deepseek", method: "apikey" });
    expect(result).toEqual<AgentSelection>({
      provider: "deepseek",
      method: "apikey",
      model: null,
      effort: "off",
    });
  });

  it("coerces deepseek+oauth to deepseek+apikey (deepseek has no oauth)", () => {
    const result = parseAgentSelection({
      provider: "deepseek",
      method: "oauth",
      model: null,
      effort: "off",
    });
    expect(result).toEqual<AgentSelection>({
      provider: "deepseek",
      method: "apikey",
      model: null,
      effort: "off",
    });
  });

  it("defaults model to null when absent", () => {
    const result = parseAgentSelection({ provider: "anthropic", method: "apikey" });
    expect(result).not.toBeNull();
    expect(result!.model).toBeNull();
  });

  it("defaults effort to 'off' when absent", () => {
    const result = parseAgentSelection({ provider: "anthropic", method: "apikey" });
    expect(result).not.toBeNull();
    expect(result!.effort).toBe("off");
  });

  it("returns null for undefined", () => {
    expect(parseAgentSelection(undefined)).toBeNull();
  });

  it("returns null for null", () => {
    expect(parseAgentSelection(null)).toBeNull();
  });

  it("returns null for empty object {}", () => {
    expect(parseAgentSelection({})).toBeNull();
  });

  it("returns null for a non-object (string)", () => {
    expect(parseAgentSelection("garbage")).toBeNull();
  });

  it("returns null for an unknown provider string", () => {
    expect(
      parseAgentSelection({ provider: "openai", method: "apikey", model: null, effort: "off" }),
    ).toBeNull();
  });

  it("accepts all effort levels for anthropic", () => {
    for (const effort of ["off", "low", "medium", "high", "max"] as const) {
      const result = parseAgentSelection({ provider: "anthropic", method: "apikey", effort });
      expect(result).not.toBeNull();
      expect(result!.effort).toBe(effort);
    }
  });
});
