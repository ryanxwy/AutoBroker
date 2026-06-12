// @vitest-environment happy-dom
/**
 * GateBannerHost.test — the never-hidden safety floor. A banner-tracked
 * suspend kind (approval / batch_review / typed_yes) must surface the pending
 * placeholder card in the app-level banner host — visible, with zero decision
 * controls (nothing here can fake-approve); a rail-tracked kind must leave the
 * banner host empty (the rail's gate zone owns it).
 */

import { beforeEach, describe, expect, it } from "vitest";

import { GateBannerHost } from "./GateBannerHost.js";
import { useChat } from "../store/useChat.js";
import { render } from "../test/render.js";

/** Seed one session whose assistant turn is awaiting_user on a suspend of `kind`. */
function seedAwaiting(runId: string, kind: string): void {
  const s = useChat.getState();
  s.createSession({ sessionId: "sess-1" });
  s.appendAssistantTurn(runId);
  s.applyRunFrame(runId, {
    ts: "t1",
    kind: "awaiting_user",
    payload: { decision_id: "d1", form_kind: kind, step: "confirm", spec_inline: { kind } },
  });
}

beforeEach(() => {
  useChat.getState().__reset();
});

describe("GateBannerHost — never-hidden pending card", () => {
  it("a banner-tracked 'approval' suspend renders the visible pending card with no decision controls", () => {
    seedAwaiting("run-1", "approval");
    const r = render(<GateBannerHost activeRunId="run-1" />);
    const card = r.get("gate-banner-pending");
    expect(card.textContent).toContain("approval");
    expect(card.hidden).toBe(false);
    // No interactive control exists that could stand in for a real decision.
    expect(card.querySelectorAll("button, input, select, textarea, a")).toHaveLength(0);
    r.unmount();
  });

  it("a rail-tracked 'data_collection' suspend leaves the banner host empty", () => {
    seedAwaiting("run-2", "data_collection");
    const r = render(<GateBannerHost activeRunId="run-2" />);
    expect(r.query("gate-banner-pending")).toBeNull();
    r.unmount();
  });
});
