// @vitest-environment happy-dom
/**
 * AgentBar.test — the cross-disable + availability rules (pure), the dirty-omit
 * contract, and a render interaction proving the chips reflect presence (Claude
 * is OAuth-only: pick Claude → Method locks to OAuth, the API-key lane greyed).
 */

import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { click, render } from "../test/render.js";
import {
  AgentBar,
  agentPayload,
  laneOf,
  loadAgentSelection,
  methodAvail,
  providerAvail,
  reconcile,
  saveAgentSelection,
  toAgentSelection,
  type AgentPresence,
  type AgentUiSelection,
  DEFAULT_AGENT_SELECTION,
} from "./AgentBar.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ALL_PRESENT: AgentPresence = { deepseek: true, anthropic: true, claudeOauth: true };
const ONLY_DEEPSEEK: AgentPresence = { deepseek: true, anthropic: false, claudeOauth: false };
const CLAUDE_APIKEY_ONLY: AgentPresence = { deepseek: true, anthropic: true, claudeOauth: false };
const CLAUDE_OAUTH_ONLY: AgentPresence = { deepseek: false, anthropic: false, claudeOauth: true };

describe("AgentBar — availability rules", () => {
  it("DeepSeek locks Method to apikey (OAuth never offered)", () => {
    expect(methodAvail("deepseek", "oauth", ALL_PRESENT)).toEqual({
      ok: false,
      why: "DeepSeek has no subscription OAuth",
    });
    expect(methodAvail("deepseek", "apikey", ALL_PRESENT)).toEqual({ ok: true });
  });

  it("Claude is OAuth-only: API key is always greyed; oauth needs claude_oauth", () => {
    // Even with every credential present, Claude's API-key method is not offered.
    expect(methodAvail("claude", "apikey", ALL_PRESENT)).toEqual({
      ok: false,
      why: "Claude uses the OAuth subscription lane",
    });
    expect(methodAvail("claude", "apikey", CLAUDE_APIKEY_ONLY).ok).toBe(false);
    expect(methodAvail("claude", "oauth", CLAUDE_OAUTH_ONLY).ok).toBe(true);
    expect(methodAvail("claude", "oauth", CLAUDE_APIKEY_ONLY)).toEqual({
      ok: false,
      why: "connect a subscription token",
    });
  });

  it("DeepSeek·apikey gating reflects the deepseek credential", () => {
    expect(methodAvail("deepseek", "apikey", { deepseek: false, anthropic: false, claudeOauth: false })).toEqual({
      ok: false,
      why: "no DeepSeek API key",
    });
  });

  it("providerAvail: Claude needs the claude_oauth subscription token", () => {
    expect(providerAvail("claude", ONLY_DEEPSEEK)).toEqual({
      ok: false,
      why: "connect a Claude subscription token",
    });
    // An anthropic API key alone does NOT enable Claude (the lane is OAuth-only).
    expect(providerAvail("claude", CLAUDE_APIKEY_ONLY).ok).toBe(false);
    expect(providerAvail("claude", CLAUDE_OAUTH_ONLY).ok).toBe(true);
    expect(providerAvail("deepseek", ONLY_DEEPSEEK).ok).toBe(true);
  });
});

describe("AgentBar — reconcile", () => {
  it("switching to Claude reconciles method/model/effort into Claude's scales", () => {
    const start: AgentUiSelection = { provider: "claude", method: "apikey", model: "deepseek-v4-flash", effort: "max" };
    const out = reconcile(start, ALL_PRESENT);
    expect(out.model).toBe("claude-sonnet-4-6"); // deepseek model invalid for claude
    expect(out.effort).toBe("low"); // "max" not in claude's scale → second entry
    expect(out.method).toBe("oauth"); // Claude is OAuth-only; stale apikey → oauth
  });

  it("a deepseek selection carrying oauth is coerced to apikey", () => {
    const out = reconcile({ provider: "deepseek", method: "oauth", model: "deepseek-v4-pro", effort: "high" }, ALL_PRESENT);
    expect(out.method).toBe("apikey");
    expect(out.model).toBe("deepseek-v4-pro");
    expect(out.effort).toBe("high");
  });

  it("when the chosen method's credential is missing, it falls to the available one", () => {
    // claude with ONLY oauth present + a stale apikey method → falls to oauth.
    const out = reconcile({ provider: "claude", method: "apikey", model: "claude-opus-4-8", effort: "high" }, CLAUDE_OAUTH_ONLY);
    expect(out.method).toBe("oauth");
  });

  it("is idempotent", () => {
    const once = reconcile(DEFAULT_AGENT_SELECTION, ALL_PRESENT);
    expect(reconcile(once, ALL_PRESENT)).toEqual(once);
  });
});

describe("AgentBar — lane + wire mapping", () => {
  it("Claude·OAuth is lane B; everything else lane A", () => {
    expect(laneOf({ provider: "claude", method: "oauth", model: "claude-opus-4-8", effort: "off" })).toBe("B");
    expect(laneOf({ provider: "claude", method: "apikey", model: "claude-opus-4-8", effort: "off" })).toBe("A");
    expect(laneOf(DEFAULT_AGENT_SELECTION)).toBe("A");
  });

  it("toAgentSelection maps claude→anthropic and forces apikey for deepseek", () => {
    expect(toAgentSelection({ provider: "claude", method: "oauth", model: "claude-opus-4-8", effort: "high" })).toEqual({
      provider: "anthropic",
      method: "oauth",
      model: "claude-opus-4-8",
      effort: "high",
    });
    expect(toAgentSelection({ provider: "deepseek", method: "oauth", model: "deepseek-v4-pro", effort: "max" })).toEqual({
      provider: "deepseek",
      method: "apikey",
      model: "deepseek-v4-pro",
      effort: "max",
    });
  });
});

describe("AgentBar — dirty-omit", () => {
  it("omits the agent payload until dirty", () => {
    expect(agentPayload(DEFAULT_AGENT_SELECTION, false, ALL_PRESENT)).toBeUndefined();
  });

  it("emits the reconciled, wire-mapped selection once dirty", () => {
    const sel: AgentUiSelection = { provider: "claude", method: "oauth", model: "claude-opus-4-8", effort: "high" };
    expect(agentPayload(sel, true, ALL_PRESENT)).toEqual({
      provider: "anthropic",
      method: "oauth",
      model: "claude-opus-4-8",
      effort: "high",
    });
  });
});

describe("AgentBar — loadAgentSelection dirty seed (e2e-precedence guard)", () => {
  // Load-bearing: if a refactor defaulted dirty:true on a FRESH browser, the
  // agent payload would shadow the env default and silently break
  // `/e2e-loop --provider claude` (it routes via AUTOBROKER_AGENT_PROVIDER only
  // when the UI omits `agent`). This freezes the empty→false / saved→true seed.
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("a fresh browser (empty localStorage) is NOT dirty → the default selection", () => {
    const loaded = loadAgentSelection();
    expect(loaded.dirty).toBe(false);
    expect(loaded.selection).toEqual(DEFAULT_AGENT_SELECTION);
  });

  it("after a saved selection exists, it loads dirty:true with that selection", () => {
    const saved: AgentUiSelection = {
      provider: "claude",
      method: "oauth",
      model: "claude-opus-4-8",
      effort: "high",
    };
    saveAgentSelection(saved);
    const loaded = loadAgentSelection();
    expect(loaded.dirty).toBe(true);
    expect(loaded.selection).toEqual(saved);
  });

  it("a corrupt localStorage value degrades to not-dirty + the default", () => {
    window.localStorage.setItem("autobroker:agent-selection", "{not json");
    const loaded = loadAgentSelection();
    expect(loaded.dirty).toBe(false);
    expect(loaded.selection).toEqual(DEFAULT_AGENT_SELECTION);
  });
});

/** A tiny controlled host so a pick re-renders the bar (App owns the state). */
function Host({ presence }: { presence: AgentPresence }): JSX.Element {
  const [sel, setSel] = useState<AgentUiSelection>(DEFAULT_AGENT_SELECTION);
  return <AgentBar selection={sel} presence={presence} onChange={setSel} />;
}

describe("AgentBar — render interaction", () => {
  it("renders the four boxes only (no resolved line); the Effort box is disabled", () => {
    const r = render(<Host presence={ALL_PRESENT} />);
    expect(r.query("agent-bar")).not.toBeNull();
    for (const box of ["provider", "method", "model", "effort"]) {
      expect(r.query(`agent-box-${box}`)).not.toBeNull();
    }
    // The bar is the four boxes only — head/lane badge/resolved line/caption gone.
    expect(r.query("agent-resolved")).toBeNull();
    expect(r.query("agent-lane")).toBeNull();
    expect(r.query("agent-effort-caption")).toBeNull();
    // Effort is inert in v1 → its box is disabled.
    expect((r.get("agent-box-effort") as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });

  it("picking Claude locks Method to OAuth (API key greyed — the OAuth-only lane)", () => {
    const r = render(<Host presence={ALL_PRESENT} />);
    // Open the Provider box → pick Claude (enabled: claude_oauth present).
    click(r.get("agent-box-provider"));
    click(r.get("agent-opt-claude"));
    expect(r.get("agent-box-provider").textContent).toContain("Claude");
    // Method auto-resolved to OAuth; the model cascaded into Claude's scale.
    expect(r.get("agent-box-method").textContent).toContain("OAuth");
    expect(r.get("agent-box-model").textContent).toContain("Claude Sonnet 4.6");
    // Open the Method box → API key is disabled (OAuth-only); OAuth is enabled.
    click(r.get("agent-box-method"));
    expect((r.get("agent-opt-apikey") as HTMLButtonElement).disabled).toBe(true);
    expect((r.get("agent-opt-oauth") as HTMLButtonElement).disabled).toBe(false);
    r.unmount();
  });

  it("Claude is greyed in the Provider box when only an anthropic API key is present", () => {
    const r = render(<Host presence={CLAUDE_APIKEY_ONLY} />);
    click(r.get("agent-box-provider"));
    // OAuth-only lane: an anthropic key without a subscription token cannot pick Claude.
    expect((r.get("agent-opt-claude") as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });
});
