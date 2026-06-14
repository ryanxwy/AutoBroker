// @vitest-environment happy-dom
/**
 * HygieneReviewCard.test — the per-stage DESTRUCTIVE review contract:
 * rows default UNDECIDED, the live counter, submit gating (every row decided AND
 * >=1 approve), select-all (full explicit id list — NO approve-all wire member),
 * the approved-ids-only payload, the always-enabled decline, the malformed-spec
 * pending fallback, and the hygiene-stage value per stage.
 */

import { describe, expect, it, vi } from "vitest";

import { HygieneReviewCard } from "./HygieneReviewCard.js";
import { readHygieneStageSpec, type HygieneStageSpec } from "./hygieneStage.js";
import { click, render } from "../test/render.js";

const SPEC: HygieneStageSpec = {
  stage: "orphans",
  question: "Delete these orphan thread records?",
  targets: [
    { id: "t-1", name: "Tustin Hyundai", reason: "empty record — no messages" },
    { id: "t-2", name: "HB Hyundai", reason: "empty record — no messages" },
    { id: "t-3", name: "Anaheim Hyundai", reason: "empty record — no messages" },
  ],
  total: 3,
};

function mount(spec: HygieneStageSpec = SPEC, submitting = false) {
  const onApprove = vi.fn();
  const onDecline = vi.fn();
  const r = render(
    <HygieneReviewCard spec={spec} submitting={submitting} onApprove={onApprove} onDecline={onDecline} />,
  );
  return { r, onApprove, onDecline };
}

describe("HygieneReviewCard — row defaults + counter + submit gating", () => {
  it("every row defaults undecided, the counter reads 0/N, submit is disabled", () => {
    const { r } = mount();
    for (const t of SPEC.targets) {
      expect(r.get(`hygiene-row-${t.id}`).getAttribute("data-decision")).toBe("undecided");
    }
    expect(r.get("hygiene-counter").textContent).toContain("0/3 decided");
    expect((r.get("hygiene-submit") as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });

  it("per-row approve/skip advance the counter; submit stays disabled until EVERY row is decided", () => {
    const { r } = mount();
    click(r.get("hygiene-approve-t-1"));
    expect(r.get("hygiene-row-t-1").getAttribute("data-decision")).toBe("approve");
    expect(r.get("hygiene-counter").textContent).toContain("1/3 decided");
    expect((r.get("hygiene-submit") as HTMLButtonElement).disabled).toBe(true);

    click(r.get("hygiene-skip-t-2"));
    expect(r.get("hygiene-row-t-2").getAttribute("data-decision")).toBe("skip");
    expect(r.get("hygiene-counter").textContent).toContain("2/3 decided");

    click(r.get("hygiene-approve-t-3"));
    expect(r.get("hygiene-counter").textContent).toContain("3/3 decided");
    expect((r.get("hygiene-submit") as HTMLButtonElement).disabled).toBe(false);
    r.unmount();
  });

  it("submit sends ONLY the approved rows' ids (the explicit-list wire shape)", () => {
    const { r, onApprove } = mount();
    click(r.get("hygiene-approve-t-1"));
    click(r.get("hygiene-skip-t-2"));
    click(r.get("hygiene-approve-t-3"));
    click(r.get("hygiene-submit"));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith(["t-1", "t-3"]);
    r.unmount();
  });

  it("an all-skip stage keeps submit disabled (min-1 approve; decline is the stop verb)", () => {
    const { r, onApprove } = mount();
    for (const t of SPEC.targets) click(r.get(`hygiene-skip-${t.id}`));
    expect(r.get("hygiene-counter").textContent).toContain("3/3 decided");
    expect((r.get("hygiene-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(r.query("hygiene-zero-approved-hint")).not.toBeNull();
    expect(onApprove).not.toHaveBeenCalled();
    r.unmount();
  });
});

describe("HygieneReviewCard — select all + decline", () => {
  it("Select all approves every row and enables submit with the full id list", () => {
    const { r, onApprove } = mount();
    click(r.get("hygiene-select-all"));
    for (const t of SPEC.targets) {
      expect(r.get(`hygiene-row-${t.id}`).getAttribute("data-decision")).toBe("approve");
    }
    click(r.get("hygiene-submit"));
    expect(onApprove).toHaveBeenCalledWith(["t-1", "t-2", "t-3"]);
    r.unmount();
  });

  it("Decline is enabled with zero rows decided and fires onDecline", () => {
    const { r, onDecline } = mount();
    const decline = r.get("hygiene-decline") as HTMLButtonElement;
    expect(decline.disabled).toBe(false);
    click(decline);
    expect(onDecline).toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it("submitting disables the row/submit/decline controls", () => {
    const { r } = mount(SPEC, true);
    expect((r.get("hygiene-approve-t-1") as HTMLButtonElement).disabled).toBe(true);
    expect((r.get("hygiene-submit") as HTMLButtonElement).disabled).toBe(true);
    expect((r.get("hygiene-decline") as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });
});

describe("HygieneReviewCard — hygiene-stage value per stage", () => {
  it("carries the right stage value for each of the three stages", () => {
    for (const stage of ["orphans", "crm_threads", "crm_contacts"] as const) {
      const { r } = mount({ ...SPEC, stage });
      expect(r.get("hygiene-stage").getAttribute("data-stage")).toBe(stage);
      r.unmount();
    }
  });
});

describe("readHygieneStageSpec — defensive wire parse", () => {
  it("parses a hygiene batch_review spec_inline shape", () => {
    const spec = readHygieneStageSpec({
      kind: "batch_review",
      stage: "crm_threads",
      question: "Suppress these?",
      targets: [{ id: "t-a", name: "A", reason: "marketing follow-up" }],
      total: 1,
    });
    expect(spec).not.toBeNull();
    expect(spec!.stage).toBe("crm_threads");
    expect(spec!.targets[0]!.id).toBe("t-a");
  });

  it("returns null on a malformed payload (the host falls back to the pending placeholder)", () => {
    // missing stage (a scan batch_review, not hygiene) → null
    expect(readHygieneStageSpec({ kind: "batch_review", targets: [], total: 0 })).toBeNull();
    // bad target row → null
    expect(
      readHygieneStageSpec({ kind: "batch_review", stage: "orphans", targets: [{}], total: 1 }),
    ).toBeNull();
    // wrong kind → null
    expect(readHygieneStageSpec({ kind: "approval", stage: "orphans", targets: [], total: 0 })).toBeNull();
  });
});
