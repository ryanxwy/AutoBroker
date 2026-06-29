/**
 * Unit tests — the per-run provider-selection registry + alias override (lane A).
 *
 * Pure logic, no Mastra/agent/DB: the module is a module-level Map keyed by runId
 * plus a single env default + a route override. These tests pin the exact
 * contract later tasks (the server's setRunSelection wiring, lane-B/effort) build
 * on, AND the byte-identity guarantee: with the registry empty and the env var
 * unset, applySelection never fires (the route is unchanged).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type AgentSelection } from "@autobroker/core";
import { policy } from "@autobroker/model";

import {
  applySelection,
  clearRunSelection,
  envDefaultSelection,
  getRunSelection,
  resolveSelectionForRun,
  setRunSelection,
} from "./agentSelection.js";

const AGENT_PROVIDER_ENV = "AUTOBROKER_AGENT_PROVIDER";
const originalEnv = process.env[AGENT_PROVIDER_ENV];

const anthropicSel: AgentSelection = {
  provider: "anthropic",
  method: "oauth",
  model: null,
  effort: "off",
};
const deepseekSel: AgentSelection = {
  provider: "deepseek",
  method: "apikey",
  model: null,
  effort: "off",
};

beforeEach(() => {
  delete process.env[AGENT_PROVIDER_ENV];
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env[AGENT_PROVIDER_ENV];
  else process.env[AGENT_PROVIDER_ENV] = originalEnv;
});

describe("run-selection registry", () => {
  it("set / get / clear round-trips keyed by runId", () => {
    const runId = "run-reg-1";
    expect(getRunSelection(runId)).toBeUndefined();

    setRunSelection(runId, anthropicSel);
    expect(getRunSelection(runId)).toEqual(anthropicSel);

    // A different runId is independent.
    expect(getRunSelection("run-reg-other")).toBeUndefined();

    clearRunSelection(runId);
    expect(getRunSelection(runId)).toBeUndefined();
  });
});

describe("envDefaultSelection", () => {
  it('"claude" → anthropic/oauth', () => {
    process.env[AGENT_PROVIDER_ENV] = "claude";
    expect(envDefaultSelection()).toEqual<AgentSelection>({
      provider: "anthropic",
      method: "oauth",
      model: null,
      effort: "off",
    });
  });

  it('"deepseek" → deepseek/apikey', () => {
    process.env[AGENT_PROVIDER_ENV] = "deepseek";
    expect(envDefaultSelection()).toEqual<AgentSelection>({
      provider: "deepseek",
      method: "apikey",
      model: null,
      effort: "off",
    });
  });

  it("unset → null", () => {
    delete process.env[AGENT_PROVIDER_ENV];
    expect(envDefaultSelection()).toBeNull();
  });

  it("garbage / unknown value → null", () => {
    process.env[AGENT_PROVIDER_ENV] = "gemini";
    expect(envDefaultSelection()).toBeNull();
  });
});

describe("resolveSelectionForRun precedence (registry > env > null)", () => {
  it("registry wins over env", () => {
    const runId = "run-prec-1";
    process.env[AGENT_PROVIDER_ENV] = "deepseek"; // env says deepseek
    setRunSelection(runId, anthropicSel); // registry says anthropic
    expect(resolveSelectionForRun(runId)).toEqual(anthropicSel);
    clearRunSelection(runId);
  });

  it("env is the fallback when the registry has no entry", () => {
    const runId = "run-prec-2";
    clearRunSelection(runId);
    process.env[AGENT_PROVIDER_ENV] = "claude";
    expect(resolveSelectionForRun(runId)).toEqual(anthropicSel);
  });

  it("null when neither registry nor env resolves", () => {
    const runId = "run-prec-3";
    clearRunSelection(runId);
    delete process.env[AGENT_PROVIDER_ENV];
    expect(resolveSelectionForRun(runId)).toBeNull();
  });
});

describe("applySelection", () => {
  it("is IDENTITY when the route alias is not a deepseek alias (cross_provider_smoke)", () => {
    const route = policy("cross_provider_smoke"); // anthropic.chat
    expect(route.alias).toBe("anthropic.chat");
    // Even handed an anthropic selection, a non-deepseek base route is returned
    // verbatim (same object reference) — the override only re-homes deepseek.
    expect(applySelection(route, anthropicSel)).toBe(route);
  });

  it("swaps a deepseek base route to anthropic, preserving the useCase", () => {
    const route = policy("dealer_reply_extract"); // deepseek.chat
    expect(route.alias).toBe("deepseek.chat");

    const out = applySelection(route, anthropicSel);
    expect(out.alias).toBe("anthropic.chat");
    expect(out.provider).toBe("anthropic");
    expect(out.capabilities.supportsOutputObjectWithTools).toBe(true);
    // useCase is preserved across the override.
    expect(out.useCase).toBe("dealer_reply_extract");
  });

  it("is identity (alias unchanged) when the selection re-homes deepseek → deepseek", () => {
    const route = policy("dealer_reply_extract"); // deepseek.chat
    const out = applySelection(route, deepseekSel);
    expect(out.alias).toBe("deepseek.chat");
    expect(out.provider).toBe("deepseek");
    expect(out.useCase).toBe("dealer_reply_extract");
  });
});
