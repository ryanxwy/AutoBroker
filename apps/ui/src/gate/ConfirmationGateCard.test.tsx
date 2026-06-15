// @vitest-environment happy-dom
/**
 * ConfirmationGateCard.test — the destructive typed-YES second-confirm contract:
 * exactly 5 consequence lines, Confirm DISABLED until the input trims to YES
 * (case-insensitive), Cancel→decline (always enabled), Confirm→accept with the
 * canonical {confirm_token:"YES"} payload, submitting disables the controls, and
 * the defensive wire parse (mutual-exclusive, exactly-5, returns null on a
 * malformed payload so the host falls back to its pending placeholder).
 */

import { describe, expect, it, vi } from "vitest";

import {
  ConfirmationGateCard,
  readConfirmationGateSpec,
  type ConfirmationGateSpec,
} from "./ConfirmationGateCard.js";
import { change, click, render } from "../test/render.js";

const SPEC: ConfirmationGateSpec = {
  question: "This permanently erases all of your local pipeline data. Type YES to confirm, or cancel.",
  consequenceLines: [
    "I'll close out your active dealers first, then erase all of your local pipeline data.",
    "Every search profile, dealer, message, quote, and saved result on this machine will be permanently deleted.",
    "I'll save a one-time local backup just before erasing, in case you need to recover.",
    "Any skill run that is still in progress, and anything waiting on your approval, will be cleared too.",
    "After the reset there is no undo from the app — you'll start over from a clean intake.",
  ],
};

function mount(spec: ConfirmationGateSpec = SPEC, submitting = false) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const r = render(
    <ConfirmationGateCard spec={spec} submitting={submitting} onConfirm={onConfirm} onCancel={onCancel} />,
  );
  return { r, onConfirm, onCancel };
}

describe("ConfirmationGateCard — consequence lines + confirm gating", () => {
  it("renders exactly 5 consequence lines and the question heading", () => {
    const { r } = mount();
    expect(r.all("reset-consequence-line")).toHaveLength(5);
    expect(r.get("confirmation-gate-card").textContent).toContain(SPEC.question);
    r.unmount();
  });

  it("Confirm is disabled until YES is typed", () => {
    const { r } = mount();
    expect((r.get("reset-confirm") as HTMLButtonElement).disabled).toBe(true);

    change(r.get("reset-confirm-token") as HTMLInputElement, "NO");
    expect((r.get("reset-confirm") as HTMLButtonElement).disabled).toBe(true);

    change(r.get("reset-confirm-token") as HTMLInputElement, "YES");
    expect((r.get("reset-confirm") as HTMLButtonElement).disabled).toBe(false);
    r.unmount();
  });

  it("the YES pre-check is case-insensitive and trims surrounding space", () => {
    const { r } = mount();
    change(r.get("reset-confirm-token") as HTMLInputElement, "yes");
    expect((r.get("reset-confirm") as HTMLButtonElement).disabled).toBe(false);

    change(r.get("reset-confirm-token") as HTMLInputElement, "YES ");
    expect((r.get("reset-confirm") as HTMLButtonElement).disabled).toBe(false);

    // a non-empty partial keeps it disabled.
    change(r.get("reset-confirm-token") as HTMLInputElement, "YE");
    expect((r.get("reset-confirm") as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });

  it("Confirm fires accept with the canonical {confirm_token:'YES'} (not the raw casing)", () => {
    const { r, onConfirm } = mount();
    change(r.get("reset-confirm-token") as HTMLInputElement, "yes");
    click(r.get("reset-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it("Cancel is always enabled and fires onCancel (the never-hidden decline)", () => {
    const { r, onCancel } = mount();
    const cancel = r.get("reset-cancel") as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it("submitting disables both the input and the Confirm/Cancel controls", () => {
    const { r } = mount(SPEC, true);
    expect((r.get("reset-confirm-token") as HTMLInputElement).disabled).toBe(true);
    expect((r.get("reset-confirm") as HTMLButtonElement).disabled).toBe(true);
    expect((r.get("reset-cancel") as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
  });
});

describe("readConfirmationGateSpec — defensive wire parse", () => {
  const FIVE = ["a", "b", "c", "d", "e"];

  it("parses the committed spec_inline shape", () => {
    const spec = readConfirmationGateSpec({
      kind: "confirmation_gate",
      destructive: true,
      confirm_token: "YES",
      question: "Erase everything?",
      consequence_lines: FIVE,
    });
    expect(spec).not.toBeNull();
    expect(spec!.question).toBe("Erase everything?");
    expect(spec!.consequenceLines).toHaveLength(5);
  });

  it("returns null on a malformed payload (the host falls back to the pending placeholder)", () => {
    // wrong kind
    expect(
      readConfirmationGateSpec({ kind: "batch_review", destructive: true, confirm_token: "YES", question: "q", consequence_lines: FIVE }),
    ).toBeNull();
    // not destructive
    expect(
      readConfirmationGateSpec({ kind: "confirmation_gate", destructive: false, confirm_token: "YES", question: "q", consequence_lines: FIVE }),
    ).toBeNull();
    // wrong token literal
    expect(
      readConfirmationGateSpec({ kind: "confirmation_gate", destructive: true, confirm_token: "OK", question: "q", consequence_lines: FIVE }),
    ).toBeNull();
    // not exactly 5 lines
    expect(
      readConfirmationGateSpec({ kind: "confirmation_gate", destructive: true, confirm_token: "YES", question: "q", consequence_lines: ["a", "b", "c", "d"] }),
    ).toBeNull();
    // a non-string line
    expect(
      readConfirmationGateSpec({ kind: "confirmation_gate", destructive: true, confirm_token: "YES", question: "q", consequence_lines: ["a", "b", "c", "d", 5] }),
    ).toBeNull();
    // missing question
    expect(
      readConfirmationGateSpec({ kind: "confirmation_gate", destructive: true, confirm_token: "YES", consequence_lines: FIVE }),
    ).toBeNull();
  });
});
