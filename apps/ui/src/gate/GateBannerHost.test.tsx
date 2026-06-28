// @vitest-environment happy-dom
/**
 * GateBannerHost.test — the banner-track ROUTING guard (the card behavior itself
 * lives in GateCardSwitch.test). The banner hosts ONLY the banner-tracked kinds:
 * a mutation `approval` (the REAL ApprovalPrompt, or the never-hidden pending
 * placeholder for a summary-less payload) and the destructive typed-YES
 * `confirmation_gate`. The batch-review family now renders inline in the chat
 * rail, so a `batch_review` (and any other rail-tracked kind) leaves the banner
 * host EMPTY — its card is never mounted twice.
 */

import { describe, expect, it, vi } from "vitest";

import { GateBannerHost } from "./GateBannerHost.js";
import type { AwaitingUserPayload } from "../chat/messageModel.js";
import type { DecisionController } from "../chat/useDecision.js";
import { click, render } from "../test/render.js";

/** The projected pending suspend for a gate of `kind` (what App passes down). */
function awaiting(kind: string, specExtra: Record<string, unknown> = {}): AwaitingUserPayload {
  return {
    decisionId: "d1",
    formKind: kind,
    step: "confirm",
    specInline: { kind, ...specExtra },
  };
}

function controller(): DecisionController & { decide: ReturnType<typeof vi.fn<DecisionController["decide"]>> } {
  return { submitting: false, decisionError: null, decide: vi.fn<DecisionController["decide"]>() };
}

const BATCH_SPEC = {
  question: "Scan these dealers' inventory now?",
  targets: [
    { dealer_id: "d-1", name: "Tustin Hyundai", website: "https://www.tustinhyundai.com/" },
    { dealer_id: "d-2", name: "Anaheim Hyundai", website: "https://www.anaheimhyundai.com/" },
  ],
  skipped: [],
  total_targets: 2,
  total_in_radius: 2,
};

const APPROVAL_SPEC = {
  summary: "First encounter with a new incentive source: scrape https://www.hyundaiusa.com/us/en/offers ?",
  sensitive: true,
};

const CONFIRMATION_SPEC = {
  destructive: true,
  confirm_token: "YES",
  question: "This permanently erases all of your local pipeline data. Type YES to confirm, or cancel.",
  consequence_lines: ["one", "two", "three", "four", "five"],
};

describe("GateBannerHost — banner-track routing", () => {
  it("a banner-tracked 'approval' renders its card inside the banner; Approve posts accept", () => {
    const decision = controller();
    const r = render(<GateBannerHost awaiting={awaiting("approval", APPROVAL_SPEC)} decision={decision} />);
    const card = r.get("approval-prompt");
    expect(card.textContent).toContain("hyundaiusa.com");
    click(r.get("approval-approve"));
    expect(decision.decide).toHaveBeenCalledWith("accept");
    r.unmount();
  });

  it("a SUMMARY-LESS 'approval' still surfaces the never-hidden pending card in the banner", () => {
    const r = render(<GateBannerHost awaiting={awaiting("approval")} decision={controller()} />);
    const card = r.get("gate-banner-pending");
    expect(card.querySelectorAll("button, input, select, textarea, a")).toHaveLength(0);
    r.unmount();
  });

  it("a destructive 'confirmation_gate' renders the typed-YES card inside the banner", () => {
    const r = render(<GateBannerHost awaiting={awaiting("confirmation_gate", CONFIRMATION_SPEC)} decision={controller()} />);
    expect(r.query("confirmation-gate-card")).not.toBeNull();
    r.unmount();
  });

  it("a rail-tracked 'batch_review' leaves the banner host EMPTY (it renders in the rail now)", () => {
    const r = render(<GateBannerHost awaiting={awaiting("batch_review", BATCH_SPEC)} decision={controller()} />);
    expect(r.query("batch-review-card")).toBeNull();
    expect(r.query("gate-banner-pending")).toBeNull();
    r.unmount();
  });

  it("a rail-tracked 'data_collection' leaves the banner host empty", () => {
    const r = render(<GateBannerHost awaiting={awaiting("data_collection")} decision={controller()} />);
    expect(r.query("gate-banner-pending")).toBeNull();
    expect(r.query("batch-review-card")).toBeNull();
    r.unmount();
  });
});
