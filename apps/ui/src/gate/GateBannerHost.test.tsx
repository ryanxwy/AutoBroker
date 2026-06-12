// @vitest-environment happy-dom
/**
 * GateBannerHost.test — the banner-track routing + the never-hidden safety
 * floor. batch_review renders its REAL decision surface (BatchReviewCard) and
 * wires submit/decline onto the decide() controller; an approval suspend
 * carrying a `summary` renders the REAL ApprovalPrompt (Approve → accept,
 * Deny → decline, Cancel run → cancel; sensitive hides batch approval); the
 * remaining banner-tracked kinds (typed_yes, a summary-less approval) still
 * surface the pending placeholder with zero decision controls; a rail-tracked
 * kind leaves the banner host empty; a MALFORMED batch_review payload falls
 * back to the placeholder (a pending gate is never silently hidden, never
 * mis-rendered).
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

describe("GateBannerHost — never-hidden pending card", () => {
  it("a SUMMARY-LESS 'approval' suspend renders the visible pending card with no decision controls", () => {
    const r = render(<GateBannerHost awaiting={awaiting("approval")} decision={controller()} />);
    const card = r.get("gate-banner-pending");
    expect(card.textContent).toContain("approval");
    expect(card.hidden).toBe(false);
    // No interactive control exists that could stand in for a real decision.
    expect(card.querySelectorAll("button, input, select, textarea, a")).toHaveLength(0);
    r.unmount();
  });

  it("a rail-tracked 'data_collection' suspend leaves the banner host empty", () => {
    const r = render(<GateBannerHost awaiting={awaiting("data_collection")} decision={controller()} />);
    expect(r.query("gate-banner-pending")).toBeNull();
    expect(r.query("batch-review-card")).toBeNull();
    r.unmount();
  });
});

describe("GateBannerHost — the batch_review decision surface", () => {
  it("a batch_review suspend renders the REAL card (no placeholder) and submit posts accept{approved_dealer_ids}", () => {
    const decision = controller();
    const r = render(
      <GateBannerHost awaiting={awaiting("batch_review", BATCH_SPEC)} decision={decision} />,
    );
    expect(r.query("gate-banner-pending")).toBeNull();
    expect(r.query("batch-review-card")).not.toBeNull();

    click(r.get("batch-select-all"));
    click(r.get("batch-submit"));
    expect(decision.decide).toHaveBeenCalledWith("accept", { approved_dealer_ids: ["d-1", "d-2"] });
    r.unmount();
  });

  it("the card's Decline posts the decline action (terminal, zero writes)", () => {
    const decision = controller();
    const r = render(
      <GateBannerHost awaiting={awaiting("batch_review", BATCH_SPEC)} decision={decision} />,
    );
    click(r.get("batch-decline"));
    expect(decision.decide).toHaveBeenCalledWith("decline");
    r.unmount();
  });

  it("a MALFORMED batch_review payload falls back to the never-hidden pending placeholder", () => {
    const r = render(
      <GateBannerHost awaiting={awaiting("batch_review", { targets: "not-an-array" })} decision={controller()} />,
    );
    expect(r.query("batch-review-card")).toBeNull();
    expect(r.query("gate-banner-pending")).not.toBeNull();
    r.unmount();
  });

  it("a decision error surfaces alongside the card", () => {
    const decision = { submitting: false, decisionError: "content_invalid: bad ids", decide: vi.fn() };
    const r = render(
      <GateBannerHost awaiting={awaiting("batch_review", BATCH_SPEC)} decision={decision} />,
    );
    expect(r.get("batch-decision-error").textContent).toContain("content_invalid");
    r.unmount();
  });
});

const APPROVAL_SPEC = {
  summary: "First encounter with a new incentive source: scrape https://www.hyundaiusa.com/us/en/offers ?",
  sensitive: true,
  oemUrl: "https://www.hyundaiusa.com/us/en/offers",
  normalizedUrl: "https://www.hyundaiusa.com/us/en/offers",
  make: "Hyundai",
  model: "Tucson Hybrid",
  reason: "oem_first_encounter",
};

describe("GateBannerHost — the approval decision surface", () => {
  it("a summary-carrying approval renders the REAL ApprovalPrompt (no placeholder); Approve posts accept", () => {
    const decision = controller();
    const r = render(
      <GateBannerHost awaiting={awaiting("approval", APPROVAL_SPEC)} decision={decision} />,
    );
    expect(r.query("gate-banner-pending")).toBeNull();
    const card = r.get("approval-prompt");
    expect(card.textContent).toContain("hyundaiusa.com");
    // sensitive: the danger frame is on and batch approval is HIDDEN.
    expect(card.getAttribute("data-sensitive")).toBe("true");
    expect(r.query("approval-approve-all")).toBeNull();

    click(r.get("approval-approve"));
    expect(decision.decide).toHaveBeenCalledWith("accept");
    r.unmount();
  });

  it("Deny posts decline and Cancel run posts cancel", () => {
    const decision = controller();
    const r = render(
      <GateBannerHost awaiting={awaiting("approval", APPROVAL_SPEC)} decision={decision} />,
    );
    click(r.get("approval-deny"));
    expect(decision.decide).toHaveBeenCalledWith("decline");
    click(r.get("approval-cancel"));
    expect(decision.decide).toHaveBeenCalledWith("cancel");
    r.unmount();
  });

  it("a decision error surfaces alongside the approval card", () => {
    const decision = { submitting: false, decisionError: "run_terminal: gone", decide: vi.fn() };
    const r = render(
      <GateBannerHost awaiting={awaiting("approval", APPROVAL_SPEC)} decision={decision} />,
    );
    expect(r.get("approval-decision-error").textContent).toContain("run_terminal");
    r.unmount();
  });
});
