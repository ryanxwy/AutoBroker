// @vitest-environment happy-dom
/**
 * GateBannerHost.test — the never-hidden safety floor. A banner-tracked
 * suspend kind (approval / batch_review / typed_yes) must surface the pending
 * placeholder card in the app-level banner host — visible, with zero decision
 * controls (nothing here can fake-approve); a rail-tracked kind must leave the
 * banner host empty (the rail's gate zone owns it).
 */

import { describe, expect, it } from "vitest";

import { GateBannerHost } from "./GateBannerHost.js";
import type { AwaitingUserPayload } from "../chat/messageModel.js";
import { render } from "../test/render.js";

/** The projected pending suspend for a gate of `kind` (what App passes down). */
function awaiting(kind: string): AwaitingUserPayload {
  return {
    decisionId: "d1",
    formKind: kind,
    step: "confirm",
    specInline: { kind },
  };
}

describe("GateBannerHost — never-hidden pending card", () => {
  it("a banner-tracked 'approval' suspend renders the visible pending card with no decision controls", () => {
    const r = render(<GateBannerHost awaiting={awaiting("approval")} />);
    const card = r.get("gate-banner-pending");
    expect(card.textContent).toContain("approval");
    expect(card.hidden).toBe(false);
    // No interactive control exists that could stand in for a real decision.
    expect(card.querySelectorAll("button, input, select, textarea, a")).toHaveLength(0);
    r.unmount();
  });

  it("a rail-tracked 'data_collection' suspend leaves the banner host empty", () => {
    const r = render(<GateBannerHost awaiting={awaiting("data_collection")} />);
    expect(r.query("gate-banner-pending")).toBeNull();
    r.unmount();
  });
});
