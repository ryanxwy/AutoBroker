// @vitest-environment happy-dom
/**
 * InboxReviewCard.test — the per-dealer inbox review contract:
 * dealer rows default UNDECIDED, the classification badges + thread counts, the
 * collapsed non-interactive `unrouted` backstop (with sender_email), the live
 * counter, submit gating (every row decided AND >=1 approve), select-all, the
 * approved-dealer-ids-only payload shape, and the always-enabled terminal
 * decline. Plus readInboxReviewSpec's defensive wire parse + its MUTUAL
 * EXCLUSIVITY against the inventory + hygiene batch_review shapes.
 */

import { describe, expect, it, vi } from "vitest";

import { InboxReviewCard, readInboxReviewSpec, type InboxReviewSpec } from "./InboxReviewCard.js";
import { readBatchReviewSpec } from "./BatchReviewCard.js";
import { readHygieneStageSpec } from "./hygieneStage.js";
import { click, render } from "../test/render.js";

const SPEC: InboxReviewSpec = {
  question: "Ingest these dealer replies?",
  targets: [
    {
      dealer_id: "d-tustin",
      name: "Tustin Hyundai",
      thread_ids: ["t-1", "t-2"],
      classification: "quoted",
      snippet: "Here is your out-the-door price on the Tucson…",
    },
    {
      dealer_id: "d-hb",
      name: "Huntington Beach Hyundai",
      thread_ids: ["t-3"],
      classification: "replied",
      snippet: "Thanks for reaching out, let me check stock…",
    },
  ],
  unrouted: [
    { thread_id: "t-9", sender_email: "noreply@leadplatform.example", snippet: "A buyer is interested…" },
  ],
  totalTargets: 2,
};

function mount(spec: InboxReviewSpec = SPEC, submitting = false) {
  const onApprove = vi.fn();
  const onDecline = vi.fn();
  const r = render(
    <InboxReviewCard spec={spec} submitting={submitting} onApprove={onApprove} onDecline={onDecline} />,
  );
  return { r, onApprove, onDecline };
}

describe("InboxReviewCard — rendering targets + badges + unrouted", () => {
  it("renders each dealer target with its classification badge and thread count", () => {
    const { r } = mount();
    expect(r.get("inbox-review-card")).not.toBeNull();
    expect(r.get("inbox-class-d-tustin").getAttribute("data-classification")).toBe("quoted");
    expect(r.get("inbox-class-d-tustin").textContent).toContain("quoted");
    expect(r.get("inbox-class-d-hb").getAttribute("data-classification")).toBe("replied");
    expect(r.get("inbox-row-d-tustin").textContent).toContain("2 threads");
    expect(r.get("inbox-row-d-hb").textContent).toContain("1 thread");
    expect(r.get("inbox-row-d-tustin").textContent).toContain("Here is your out-the-door price");
    r.unmount();
  });

  it("renders the unrouted list collapsed, non-interactive, with the sender email", () => {
    const { r } = mount();
    const group = r.get("inbox-unrouted") as HTMLDetailsElement;
    expect(group.open).toBe(false); // collapsed by default.
    const row = r.get("inbox-unrouted-row-t-9");
    expect(row.textContent).toContain("noreply@leadplatform.example");
    expect(row.textContent).toContain("A buyer is interested");
    // The unrouted backstop is informational — never a decision target.
    expect(group.querySelectorAll("button, input, select, textarea")).toHaveLength(0);
    expect(r.query("inbox-approve-t-9")).toBeNull();
    r.unmount();
  });

  it("omits the unrouted group when there are no unrouted threads", () => {
    const { r } = mount({ ...SPEC, unrouted: [] });
    expect(r.query("inbox-unrouted")).toBeNull();
    r.unmount();
  });
});

describe("InboxReviewCard — row defaults + counter + submit gating", () => {
  it("every row defaults undecided, the counter reads 0/N, submit is disabled", () => {
    const { r } = mount();
    for (const t of SPEC.targets) {
      expect(r.get(`inbox-row-${t.dealer_id}`).getAttribute("data-decision")).toBe("undecided");
    }
    expect(r.get("inbox-counter").textContent).toContain("0/2 decided");
    expect((r.get("inbox-submit") as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });

  it("per-row approve/skip advance the counter; submit stays disabled until EVERY row is decided", () => {
    const { r } = mount();
    click(r.get("inbox-approve-d-tustin"));
    expect(r.get("inbox-row-d-tustin").getAttribute("data-decision")).toBe("approve");
    expect(r.get("inbox-counter").textContent).toContain("1/2 decided");
    expect((r.get("inbox-submit") as HTMLButtonElement).disabled).toBe(true);

    click(r.get("inbox-skip-d-hb"));
    expect(r.get("inbox-row-d-hb").getAttribute("data-decision")).toBe("skip");
    expect(r.get("inbox-counter").textContent).toContain("2/2 decided");
    expect((r.get("inbox-submit") as HTMLButtonElement).disabled).toBe(false);
    r.unmount();
  });

  it("submit sends ONLY the approved dealers' ids", () => {
    const { r, onApprove } = mount();
    click(r.get("inbox-approve-d-tustin"));
    click(r.get("inbox-skip-d-hb"));
    click(r.get("inbox-submit"));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(["d-tustin"]);
    r.unmount();
  });

  it("an all-skip batch keeps submit disabled and shows the zero-approved hint", () => {
    const { r, onApprove } = mount();
    for (const t of SPEC.targets) click(r.get(`inbox-skip-${t.dealer_id}`));
    expect(r.get("inbox-counter").textContent).toContain("2/2 decided");
    expect((r.get("inbox-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(r.query("inbox-zero-approved-hint")).not.toBeNull();
    expect(onApprove).not.toHaveBeenCalled();
    r.unmount();
  });
});

describe("InboxReviewCard — select all + decline", () => {
  it("Select all approves every row and submit sends the full id list", () => {
    const { r, onApprove } = mount();
    click(r.get("inbox-select-all"));
    for (const t of SPEC.targets) {
      expect(r.get(`inbox-row-${t.dealer_id}`).getAttribute("data-decision")).toBe("approve");
    }
    expect(r.get("inbox-counter").textContent).toContain("2/2 decided");
    click(r.get("inbox-submit"));
    expect(onApprove).toHaveBeenCalledWith(["d-tustin", "d-hb"]);
    r.unmount();
  });

  it("Decline is enabled with zero rows decided and fires onDecline (terminal)", () => {
    const { r, onDecline } = mount();
    const decline = r.get("inbox-decline") as HTMLButtonElement;
    expect(decline.disabled).toBe(false);
    click(decline);
    expect(onDecline).toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it("submitting disables the row/select-all/submit/decline controls", () => {
    const { r } = mount(SPEC, true);
    expect((r.get("inbox-approve-d-tustin") as HTMLButtonElement).disabled).toBe(true);
    expect((r.get("inbox-select-all") as HTMLButtonElement).disabled).toBe(true);
    expect((r.get("inbox-submit") as HTMLButtonElement).disabled).toBe(true);
    expect((r.get("inbox-decline") as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });
});

describe("readInboxReviewSpec — defensive wire parse + mutual exclusivity", () => {
  const INBOX_PAYLOAD = {
    kind: "batch_review",
    question: "Ingest these dealer replies?",
    targets: [
      { dealer_id: "a", name: "A", thread_ids: ["t1"], classification: "quoted", snippet: "…" },
    ],
    unrouted: [{ thread_id: "u1", sender_email: "x@y.example", snippet: "…" }],
    total_targets: 1,
  };
  const INVENTORY_PAYLOAD = {
    kind: "batch_review",
    question: "Scan these dealers' inventory now?",
    targets: [{ dealer_id: "a", name: "A", website: "https://a.example" }],
    skipped: [{ dealer_id: "b", name: "B", reason: "non_us" }],
    total_targets: 1,
    total_in_radius: 2,
  };
  const HYGIENE_PAYLOAD = {
    kind: "batch_review",
    stage: "orphans",
    question: "Clean these up?",
    targets: [{ id: "a", name: "A", reason: "empty" }],
    total: 1,
  };

  it("parses the inbox payload (preserving classification + sender_email)", () => {
    const spec = readInboxReviewSpec(INBOX_PAYLOAD);
    expect(spec).not.toBeNull();
    expect(spec!.targets[0]!.classification).toBe("quoted");
    expect(spec!.targets[0]!.thread_ids).toEqual(["t1"]);
    expect(spec!.unrouted[0]!.sender_email).toBe("x@y.example");
    expect(spec!.totalTargets).toBe(1);
  });

  it("returns NULL on the inventory payload and on the hygiene payload (shape-based)", () => {
    expect(readInboxReviewSpec(INVENTORY_PAYLOAD)).toBeNull();
    expect(readInboxReviewSpec(HYGIENE_PAYLOAD)).toBeNull();
  });

  it("the inventory + hygiene readers BOTH return null on the inbox payload (no misroute)", () => {
    expect(readBatchReviewSpec(INBOX_PAYLOAD)).toBeNull();
    expect(readHygieneStageSpec(INBOX_PAYLOAD)).toBeNull();
  });

  it("returns null on a malformed inbox payload (bad target / missing unrouted / wrong kind)", () => {
    expect(readInboxReviewSpec({ kind: "batch_review", targets: [{}], unrouted: [], total_targets: 1 })).toBeNull();
    expect(readInboxReviewSpec({ kind: "batch_review", targets: [], total_targets: 0 })).toBeNull();
    expect(readInboxReviewSpec({ ...INBOX_PAYLOAD, kind: "approval" })).toBeNull();
    expect(
      readInboxReviewSpec({
        kind: "batch_review",
        targets: [{ dealer_id: "a", name: "A", thread_ids: ["t1"], classification: "bogus", snippet: "…" }],
        unrouted: [],
        total_targets: 1,
      }),
    ).toBeNull();
  });
});
