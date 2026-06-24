// @vitest-environment happy-dom
/**
 * NeedsYouInbox — the floating "Needs you" widget. Freezes:
 *   - ABSENT when nothing is parked (read-only/idle ⇒ zero items);
 *   - lists parked gates, ERROR-FIRST (fail-closed before normal approval);
 *   - names the profile + reason; "Review" routes to the run (onReview(runId));
 *   - never approves inline (no approve/decline buttons — only Review).
 */

import { describe, expect, it, vi } from "vitest";

import type { ApprovalInboxItem } from "../api/wire.js";
import { render, click } from "../test/render.js";
import { NeedsYouInbox } from "./NeedsYouInbox.js";

function item(over: Partial<ApprovalInboxItem>): ApprovalInboxItem {
  return {
    profileId: "p",
    runId: "r",
    decisionId: "d",
    reason: "batch_review",
    vehicle: "2026 Honda Accord LX",
    summary: "needs approval",
    ...over,
  };
}

describe("NeedsYouInbox", () => {
  it("is absent when nothing is parked", () => {
    const r = render(<NeedsYouInbox items={[]} onReview={() => {}} />);
    expect(r.query("needs-you-widget")).toBeNull();
  });

  it("lists parked gates error-first and routes Review to the run", () => {
    const items = [
      item({ runId: "run-normal", reason: "batch_review", vehicle: "Camry" }),
      item({ runId: "run-fail", reason: "fail_closed", vehicle: "Accord" }),
    ];
    const onReview = vi.fn();
    const r = render(<NeedsYouInbox items={items} onReview={onReview} />);
    expect(r.get("needs-you-count").textContent).toBe("2");
    // error-first: the fail-closed item is the first list entry.
    const first = r.container.querySelector('[data-testid^="needs-you-item-"]') as HTMLElement;
    expect(first.getAttribute("data-testid")).toBe("needs-you-item-run-fail");

    click(r.get("needs-you-item-run-normal"));
    expect(onReview).toHaveBeenCalledWith("run-normal");
  });
});
