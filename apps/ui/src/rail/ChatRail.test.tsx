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
      currentSessionId={null}
      skills={[]}
      hasActiveProfile={false}
      deepseekReady={true}
      onSlash={() => {}}
      onFreeform={() => {}}
      onUnpin={() => {}}
      onStartIntake={() => {}}
      onStopPick={() => {}}
      onSelectSession={() => {}}
      onRunSkill={() => {}}
      onRunSuggested={() => {}}
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
      currentSessionId={null}
      skills={[]}
      hasActiveProfile={false}
      deepseekReady={true}
      onSlash={() => {}}
      onFreeform={() => {}}
      onUnpin={() => {}}
      onStartIntake={() => {}}
      onStopPick={() => {}}
      onSelectSession={() => {}}
      onRunSkill={() => {}}
      onRunSuggested={() => {}}
    />,
  );
}

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
