// @vitest-environment happy-dom
/**
 * BatchReviewCard.test — the per-item batch-review row contract:
 * rows default UNDECIDED, the live counter, submit gating (every row decided
 * AND >=1 approve), select-all, the approved-ids-only payload shape, the
 * always-enabled decline, the muted skipped section, and both header variants
 * (full-radius vs max_targets-truncated).
 */

import { describe, expect, it, vi } from "vitest";

import { BatchReviewCard, batchHeaderLine, readBatchReviewSpec, type BatchReviewSpec } from "./BatchReviewCard.js";
import { click, render } from "../test/render.js";

const SPEC: BatchReviewSpec = {
  question: "Scan these dealers' inventory now?",
  targets: [
    { dealer_id: "d-tustin", name: "Tustin Hyundai", website: "https://www.tustinhyundai.com/inventory" },
    { dealer_id: "d-hb", name: "Huntington Beach Hyundai", website: "https://www.hbhyundai.com/" },
    { dealer_id: "d-anaheim", name: "Anaheim Hyundai", website: "https://www.anaheimhyundai.com/" },
  ],
  skipped: [{ dealer_id: "d-skip", name: "No-Site Motors", reason: "no_website" }],
  totalTargets: 3,
  totalInRadius: 3,
};

function mount(spec: BatchReviewSpec = SPEC, submitting = false) {
  const onApprove = vi.fn();
  const onDecline = vi.fn();
  const r = render(
    <BatchReviewCard spec={spec} submitting={submitting} onApprove={onApprove} onDecline={onDecline} />,
  );
  return { r, onApprove, onDecline };
}

describe("BatchReviewCard — row defaults + counter + submit gating", () => {
  it("every row defaults undecided, the counter reads 0/N, submit is disabled", () => {
    const { r } = mount();
    for (const t of SPEC.targets) {
      expect(r.get(`batch-row-${t.dealer_id}`).getAttribute("data-decision")).toBe("undecided");
    }
    expect(r.get("batch-counter").textContent).toContain("0/3 decided");
    expect((r.get("batch-submit") as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });

  it("per-row approve/skip advance the counter; submit stays disabled until EVERY row is decided", () => {
    const { r } = mount();
    click(r.get("batch-approve-d-tustin"));
    expect(r.get("batch-row-d-tustin").getAttribute("data-decision")).toBe("approve");
    expect(r.get("batch-counter").textContent).toContain("1/3 decided");
    expect((r.get("batch-submit") as HTMLButtonElement).disabled).toBe(true);

    click(r.get("batch-skip-d-hb"));
    expect(r.get("batch-row-d-hb").getAttribute("data-decision")).toBe("skip");
    expect(r.get("batch-counter").textContent).toContain("2/3 decided");
    expect((r.get("batch-submit") as HTMLButtonElement).disabled).toBe(true);

    click(r.get("batch-approve-d-anaheim"));
    expect(r.get("batch-counter").textContent).toContain("3/3 decided");
    expect((r.get("batch-submit") as HTMLButtonElement).disabled).toBe(false);
    r.unmount();
  });

  it("submit sends ONLY the approved rows' ids (the explicit-list wire shape)", () => {
    const { r, onApprove } = mount();
    click(r.get("batch-approve-d-tustin"));
    click(r.get("batch-skip-d-hb"));
    click(r.get("batch-approve-d-anaheim"));
    click(r.get("batch-submit"));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(["d-tustin", "d-anaheim"]);
    r.unmount();
  });

  it("an all-skip batch keeps submit disabled (min-1 approve; decline is the stop verb)", () => {
    const { r, onApprove } = mount();
    for (const t of SPEC.targets) click(r.get(`batch-skip-${t.dealer_id}`));
    expect(r.get("batch-counter").textContent).toContain("3/3 decided");
    expect((r.get("batch-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(r.query("batch-zero-approved-hint")).not.toBeNull();
    expect(onApprove).not.toHaveBeenCalled();
    r.unmount();
  });
});

describe("BatchReviewCard — select all", () => {
  it("Select all approves every row and enables submit with the full id list", () => {
    const { r, onApprove } = mount();
    click(r.get("batch-select-all"));
    for (const t of SPEC.targets) {
      expect(r.get(`batch-row-${t.dealer_id}`).getAttribute("data-decision")).toBe("approve");
    }
    expect(r.get("batch-counter").textContent).toContain("3/3 decided");
    click(r.get("batch-submit"));
    expect(onApprove).toHaveBeenCalledWith(["d-tustin", "d-hb", "d-anaheim"]);
    r.unmount();
  });
});

describe("BatchReviewCard — decline + skipped section + header", () => {
  it("Decline is enabled with zero rows decided and fires onDecline", () => {
    const { r, onDecline } = mount();
    const decline = r.get("batch-decline") as HTMLButtonElement;
    expect(decline.disabled).toBe(false);
    click(decline);
    expect(onDecline).toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it("skipped rows render collapsed/muted with their reason and carry no decision controls", () => {
    const { r } = mount();
    const skipped = r.get("batch-skipped") as HTMLDetailsElement;
    expect(skipped.open).toBe(false); // collapsed by default.
    expect(skipped.textContent).toContain("No-Site Motors — no_website");
    expect(skipped.querySelectorAll("button, input, select, textarea")).toHaveLength(0);
    expect(r.query("batch-approve-d-skip")).toBeNull();
    r.unmount();
  });

  it("header reads 'N of M in radius' for the full-radius default and 'N of M nearest shown' when truncated", () => {
    expect(batchHeaderLine({ totalTargets: 3, totalInRadius: 3 })).toBe("3 of 3 in radius");
    expect(batchHeaderLine({ totalTargets: 15, totalInRadius: 38 })).toBe("15 of 38 nearest shown");
    const { r } = mount({ ...SPEC, totalTargets: 3, totalInRadius: 9 });
    expect(r.get("batch-header").textContent).toBe("3 of 9 nearest shown");
    r.unmount();
  });

  it("submitting disables the row/submit/decline controls", () => {
    const { r } = mount(SPEC, true);
    expect((r.get("batch-approve-d-tustin") as HTMLButtonElement).disabled).toBe(true);
    expect((r.get("batch-submit") as HTMLButtonElement).disabled).toBe(true);
    expect((r.get("batch-decline") as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });
});

describe("readBatchReviewSpec — defensive wire parse", () => {
  it("parses the committed spec_inline shape", () => {
    const spec = readBatchReviewSpec({
      kind: "batch_review",
      question: "Scan these dealers' inventory now?",
      targets: [{ dealer_id: "a", name: "A", website: "https://a.example" }],
      skipped: [{ dealer_id: "b", name: "B", reason: "non_us" }],
      total_targets: 1,
      total_in_radius: 2,
    });
    expect(spec).not.toBeNull();
    expect(spec!.targets[0]!.dealer_id).toBe("a");
    expect(spec!.skipped[0]!.reason).toBe("non_us");
    expect(spec!.totalInRadius).toBe(2);
  });

  it("returns null on a malformed payload (the host falls back to the pending placeholder)", () => {
    expect(readBatchReviewSpec({ kind: "batch_review" })).toBeNull();
    expect(readBatchReviewSpec({ kind: "batch_review", targets: [{}], skipped: [], total_targets: 1, total_in_radius: 1 })).toBeNull();
    expect(readBatchReviewSpec({ kind: "approval", targets: [], skipped: [], total_targets: 0, total_in_radius: 0 })).toBeNull();
  });
});
