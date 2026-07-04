// @vitest-environment happy-dom
/**
 * ChatRail — the per-session pin toggle (ruling #6). Freezes:
 *   - UNPINNED: a pin toggle (session-pin) at the top of the session opens the
 *     Searches picker;
 *   - PINNED: the pin chip + unpin show instead (the toggle is folded into the
 *     chip), so a single-pinned session reads exactly as before.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "../api/client.js";
import { resetDataRefetchForTests } from "../api/useDataChanged.js";
import { render, click } from "../test/render.js";
import { ChatRail, type ChatRailProps } from "./ChatRail.js";
import type { DecisionController } from "../chat/useDecision.js";

const decision: DecisionController = { submitting: false, decisionError: null, decide: async () => {} };

function baseProps(over: Partial<ChatRailProps>): ChatRailProps {
  return {
    title: "New search",
    turns: [],
    activeRunId: null,
    runActive: false,
    browserView: null,
    decision,
    knownSkills: [],
    client: new ApiClient({ fetchImpl: (async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch }),
    scopeNotice: null,
    pinnedProfileId: null,
    pinLabel: null,
    pinZip: null,
    currentSessionId: null,
    skills: [],
    hasActiveProfile: false,
    deepseekReady: true,
    agentSelection: { provider: "deepseek", method: "apikey", model: "deepseek-v4-flash", effort: "off" },
    agentPresence: { deepseek: true, anthropic: true, claudeOauth: true },
    onAgentChange: () => {},
    onSlash: () => {},
    onFreeform: () => {},
    onUnpin: () => {},
    onPin: () => {},
    onViewProfile: () => {},
    onStartIntake: () => {},
    onStopPick: () => {},
    onSelectSession: () => {},
    onRunSkill: () => {},
    onRunSuggested: () => {},
    onMinimize: () => {},
    ...over,
  };
}

afterEach(() => resetDataRefetchForTests());

describe("ChatRail per-session pin toggle", () => {
  it("shows the session pin toggle when unpinned and opens the picker", () => {
    const r = render(<ChatRail {...baseProps({ pinnedProfileId: null })} />);
    expect(r.query("session-pin")).not.toBeNull();
    expect(r.query("rail-pin-title")).toBeNull();
    click(r.get("session-pin"));
    expect(r.query("session-pin-popover")).not.toBeNull();
    r.unmount();
  });

  it("shows the pin chip (not the toggle) when pinned — single-pinned reads as before", () => {
    const r = render(<ChatRail {...baseProps({ pinnedProfileId: "p-1", pinLabel: "Honda Accord" })} />);
    expect(r.query("rail-pin-title")).not.toBeNull();
    expect(r.query("pin-chip-unpin")).not.toBeNull();
    expect(r.query("session-pin")).toBeNull();
    r.unmount();
  });

  it("clearing the pin fires onUnpin (reverts to portfolio/multi mode)", () => {
    const onUnpin = vi.fn();
    const r = render(<ChatRail {...baseProps({ pinnedProfileId: "p-1", pinLabel: "Honda Accord", onUnpin })} />);
    click(r.get("pin-chip-unpin"));
    expect(onUnpin).toHaveBeenCalled();
    r.unmount();
  });
});
