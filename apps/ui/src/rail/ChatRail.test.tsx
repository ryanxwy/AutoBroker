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
      activeAwaiting={activeAwaiting}
      browserView={EMPTY_BROWSER_VIEW}
      decision={decision}
      knownSkills={["search_profile_intake"]}
      client={new ApiClient()}
      scopeNotice={null}
      pinnedProfileId={null}
      pinLabel={null}
      onSlash={() => {}}
      onFreeform={() => {}}
      onUnpin={() => {}}
      onStartIntake={() => {}}
      onStopPick={() => {}}
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

  it("leaves the input live when nothing is awaiting (activeAwaiting === null)", () => {
    const r = renderRail(null);
    expect((r.get("chat-input-textarea") as HTMLTextAreaElement).disabled).toBe(false);
    expect((r.get("chat-send") as HTMLButtonElement).disabled).toBe(false);
    r.unmount();
  });
});
