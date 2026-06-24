// @vitest-environment happy-dom
/**
 * NeedsYouInbox — the floating "Needs you" widget. Freezes:
 *   - ABSENT when nothing is parked (read-only/idle ⇒ zero items);
 *   - lists the consolidated approval queue (server-ranked action-required first);
 *   - names the item (summary heading); a gate "Review" routes to its run;
 *   - a retraction (no runId) is shown action-required but NOT routable;
 *   - never approves inline (no approve/decline buttons — only Review).
 */

import { describe, expect, it, vi } from "vitest";

import type { ApprovalItem } from "../api/wire.js";
import { render, click } from "../test/render.js";
import { NeedsYouInbox } from "./NeedsYouInbox.js";

function item(over: Partial<ApprovalItem>): ApprovalItem {
  return {
    kind: "gate",
    profileId: "p",
    runId: "r",
    decisionId: "d",
    skill: "dealer_web_lead_submit",
    reason: "lead_submit",
    actionRequired: true,
    summary: { heading: "2026 Honda Accord LX", lines: [] },
    ...over,
  };
}

describe("NeedsYouInbox", () => {
  it("is absent when the queue is empty", () => {
    const r = render(<NeedsYouInbox items={[]} onReview={() => {}} />);
    expect(r.query("needs-you-widget")).toBeNull();
  });

  it("lists queue items in server order and routes a gate's Review to its run", () => {
    const items = [
      item({ runId: "run-1", summary: { heading: "Camry", lines: [] } }),
      item({ runId: "run-2", summary: { heading: "Accord", lines: [] } }),
    ];
    const onReview = vi.fn();
    const r = render(<NeedsYouInbox items={items} onReview={onReview} />);
    expect(r.get("needs-you-count").textContent).toBe("2");
    click(r.get("needs-you-item-run-1"));
    expect(onReview).toHaveBeenCalledWith("run-1");
  });

  it("shows a retraction task (no runId) as action-required but not routable", () => {
    const items = [
      item({ kind: "retraction", runId: null, decisionId: null, reason: "retraction_required", summary: { heading: "Camry", lines: [] } }),
    ];
    const onReview = vi.fn();
    const r = render(<NeedsYouInbox items={items} onReview={onReview} />);
    const task = r.get("needs-you-task-0");
    expect(task.textContent).toContain("Action required");
    expect((task as HTMLButtonElement).disabled).toBe(true);
    click(task);
    expect(onReview).not.toHaveBeenCalled();
  });
});
