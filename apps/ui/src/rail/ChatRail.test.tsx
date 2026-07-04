// @vitest-environment happy-dom
/**
 * ChatRail.test — the freeform-while-suspended HAZARD FIX.
 *
 * While the active run has a pending gate (activeAwaiting !== null) the rail's
 * ChatInput is DISABLED, so a typed message (NL or slash) can NOT spawn a rogue
 * run — gates stay button-only. With nothing awaiting, the input is live.
 */

import { describe, expect, it } from "vitest";

import { ChatRail } from "./ChatRail.js";
import { ApiClient } from "../api/client.js";
import { EMPTY_BROWSER_VIEW } from "../chat/browserView.js";
import type { TurnView } from "../chat/messageModel.js";
import type { DecisionController } from "../chat/useDecision.js";
import { render } from "../test/render.js";

const decision: DecisionController = {
  submitting: false,
  decisionError: null,
  decide: () => {},
};

function renderRail(activeAwaiting: unknown | null) {
  return render(
    <ChatRail
      title="Search"
      turns={[]}
      activeRunId={activeAwaiting !== null ? "run-1" : null}
      runActive={activeAwaiting !== null}
      browserView={EMPTY_BROWSER_VIEW}
      decision={decision}
      knownSkills={["search_profile_intake"]}
      client={new ApiClient()}
      scopeNotice={null}
      pinnedProfileId={null}
      pinLabel={null}
      pinZip={null}
      currentSessionId={null}
      skills={[]}
      hasActiveProfile={false}
      deepseekReady={true}
      agentSelection={{ provider: "deepseek", method: "apikey", model: "deepseek-v4-flash", effort: "off" }}
      agentPresence={{ deepseek: true, anthropic: true, claudeOauth: true }}
      onAgentChange={() => {}}
      onSlash={() => {}}
      onFreeform={() => {}}
      onUnpin={() => {}}
      onPin={() => {}}
      onViewProfile={() => {}}
      onStartIntake={() => {}}
      onStopPick={() => {}}
      onSelectSession={() => {}}
      onRunSkill={() => {}}
      onRunSuggested={() => {}}
      onMinimize={() => {}}
    />,
  );
}

describe("ChatRail — input disabled while a gate is pending", () => {
  it("disables the textarea AND the send button when activeAwaiting !== null", () => {
    const r = renderRail({ decisionId: "d-1", step: "collect" });
    expect((r.get("chat-input-textarea") as HTMLTextAreaElement).disabled).toBe(true);
    expect((r.get("chat-send") as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });

  it("leaves the textarea live when nothing is awaiting (activeAwaiting === null)", () => {
    const r = renderRail(null);
    // The gate is clear → the textarea is NOT gate-disabled (a real user can type).
    // The Send button additionally requires non-empty text via the composer's own
    // canSend logic (independent of the gate), so it stays disabled on this empty
    // render — the gate's load-bearing control is the textarea, asserted here.
    expect((r.get("chat-input-textarea") as HTMLTextAreaElement).disabled).toBe(false);
    r.unmount();
  });
});

/** Render with an explicit runActive (the SOFT-BLOCK arm: a run is RUNNING with NO
 *  pending gate — activeAwaiting is null but the composer must still lock so a
 *  typed message cannot spawn a concurrent run). */
function renderRunActive(runActive: boolean) {
  return render(
    <ChatRail
      title="Search"
      turns={[]}
      activeRunId={runActive ? "run-1" : null}
      runActive={runActive}
      browserView={EMPTY_BROWSER_VIEW}
      decision={decision}
      knownSkills={["search_profile_intake"]}
      client={new ApiClient()}
      scopeNotice={null}
      pinnedProfileId={null}
      pinLabel={null}
      pinZip={null}
      currentSessionId={null}
      skills={[]}
      hasActiveProfile={false}
      deepseekReady={true}
      agentSelection={{ provider: "deepseek", method: "apikey", model: "deepseek-v4-flash", effort: "off" }}
      agentPresence={{ deepseek: true, anthropic: true, claudeOauth: true }}
      onAgentChange={() => {}}
      onSlash={() => {}}
      onFreeform={() => {}}
      onUnpin={() => {}}
      onPin={() => {}}
      onViewProfile={() => {}}
      onStartIntake={() => {}}
      onStopPick={() => {}}
      onSelectSession={() => {}}
      onRunSkill={() => {}}
      onRunSuggested={() => {}}
      onMinimize={() => {}}
    />,
  );
}

/** Render a PINNED rail (a search bound to the session): the header title is the
 *  pinned search identity — vehicle + ZIP + unpin — not the launch/skill title. */
function renderPinned(pinLabel: string | null, pinZip: string | null) {
  return render(
    <ChatRail
      title="/dealer_inbox_check"
      turns={[]}
      activeRunId={null}
      runActive={false}
      browserView={EMPTY_BROWSER_VIEW}
      decision={decision}
      knownSkills={["search_profile_intake"]}
      client={new ApiClient()}
      scopeNotice={null}
      pinnedProfileId={"profile-1"}
      pinLabel={pinLabel}
      pinZip={pinZip}
      currentSessionId={null}
      skills={[]}
      hasActiveProfile={true}
      deepseekReady={true}
      agentSelection={{ provider: "deepseek", method: "apikey", model: "deepseek-v4-flash", effort: "off" }}
      agentPresence={{ deepseek: true, anthropic: true, claudeOauth: true }}
      onAgentChange={() => {}}
      onSlash={() => {}}
      onFreeform={() => {}}
      onUnpin={() => {}}
      onPin={() => {}}
      onViewProfile={() => {}}
      onStartIntake={() => {}}
      onStopPick={() => {}}
      onSelectSession={() => {}}
      onRunSkill={() => {}}
      onRunSuggested={() => {}}
      onMinimize={() => {}}
    />,
  );
}

describe("ChatRail — pinned-search title (the pin IS the rail title)", () => {
  it("shows the pinned vehicle + ZIP (not the skill title) with an unpin control", () => {
    const r = renderPinned("2026 Honda Pilot EX-L", "10001");
    const title = r.get("rail-pin-title");
    // The vehicle identity + ZIP render in the title…
    expect(r.get("pin-chip-label").textContent).toContain("2026 Honda Pilot EX-L");
    expect(r.get("pin-chip-label").textContent).toContain("10001");
    // …and the launch/skill title ("/dealer_inbox_check") does NOT.
    expect(title.textContent).not.toContain("/dealer_inbox_check");
    // The unpin affordance is folded into the title.
    expect(r.query("pin-chip-unpin")).not.toBeNull();
    r.unmount();
  });

  it("falls back to the profile id and omits the ZIP separator when none resolved", () => {
    const r = renderPinned(null, null);
    expect(r.get("pin-chip-label").textContent).toBe("profile-1");
    expect(r.get("pin-chip-label").textContent).not.toContain("·");
    r.unmount();
  });
});

describe("ChatRail — SOFT-BLOCK: composer locked while a run is in flight", () => {
  it("disables the textarea AND Send while a run is RUNNING (no gate pending)", () => {
    const r = renderRunActive(true);
    expect((r.get("chat-input-textarea") as HTMLTextAreaElement).disabled).toBe(true);
    expect((r.get("chat-send") as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });

  it("leaves the textarea live once the run is terminal (runActive === false)", () => {
    const r = renderRunActive(false);
    expect((r.get("chat-input-textarea") as HTMLTextAreaElement).disabled).toBe(false);
    r.unmount();
  });
});

/** An assistant turn parked on a gate of the given kind (spec_inline.kind). */
function gateTurn(gateKind: string): TurnView {
  return {
    kind: "assistant",
    id: "run-1",
    turn: {
      runId: "run-1",
      skill: "search_profile_intake",
      status: "awaiting_approval",
      text: "",
      milestones: [],
      currentActivity: null,
      driverKind: null,
      awaitingUser: { decisionId: "d-1", formKind: null, step: "collect", specInline: { kind: gateKind } },
      error: null,
      errorName: null,
      errorCode: null,
      resolution: null,
      suggestedSkill: null,
    },
  };
}

/** Render with a gate parked on the active run and a decision error set. */
function renderGateError(gateKind: string) {
  const decisionErr: DecisionController = {
    submitting: false,
    decisionError: "gate_conflict: another decision already landed",
    decide: () => {},
  };
  return render(
    <ChatRail
      title="Search"
      turns={[gateTurn(gateKind)]}
      activeRunId="run-1"
      runActive={true}
      browserView={EMPTY_BROWSER_VIEW}
      decision={decisionErr}
      knownSkills={["search_profile_intake"]}
      client={new ApiClient()}
      scopeNotice={null}
      pinnedProfileId={null}
      pinLabel={null}
      pinZip={null}
      currentSessionId={null}
      skills={[]}
      hasActiveProfile={false}
      deepseekReady={true}
      agentSelection={{ provider: "deepseek", method: "apikey", model: "deepseek-v4-flash", effort: "off" }}
      agentPresence={{ deepseek: true, anthropic: true, claudeOauth: true }}
      onAgentChange={() => {}}
      onSlash={() => {}}
      onFreeform={() => {}}
      onUnpin={() => {}}
      onPin={() => {}}
      onViewProfile={() => {}}
      onStartIntake={() => {}}
      onStopPick={() => {}}
      onSelectSession={() => {}}
      onRunSkill={() => {}}
      onRunSuggested={() => {}}
      onMinimize={() => {}}
    />,
  );
}

describe("ChatRail — rail-level decision error de-duplicates the per-card error", () => {
  it("SUPPRESSES the rail-level error when a batch_review gate is active (GateCardSwitch owns it)", () => {
    const r = renderGateError("batch_review");
    expect(r.query("decision-error")).toBeNull();
    r.unmount();
  });

  it("SHOWS the rail-level error for an intake-family gate (no per-card error surface)", () => {
    const r = renderGateError("intake_confirm");
    expect(r.query("decision-error")).not.toBeNull();
    r.unmount();
  });
});
