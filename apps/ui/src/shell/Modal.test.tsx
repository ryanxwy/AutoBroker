// @vitest-environment happy-dom
/**
 * Modal.test — the portal dialog's close contract:
 *   - dialog variant: Escape closes AND a backdrop click closes.
 *   - danger variant: Escape closes (the SAFE cancel), but a backdrop click does
 *     NOT (the irreversible path gets a single gated exit — an explicit button).
 *   - role is dialog vs alertdialog per variant; aria-modal is set.
 *
 * The dialog renders through createPortal into document.body, so these query the
 * document directly (not the render container).
 */

import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { render } from "../test/render.js";
import { Modal } from "./Modal.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const docGet = (testId: string): HTMLElement => {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  if (node === null) throw new Error(`no node with data-testid="${testId}"`);
  return node as HTMLElement;
};
const docQuery = (testId: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

function escape(node: HTMLElement): void {
  act(() => {
    node.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
}
function mousedown(node: HTMLElement): void {
  act(() => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });
}

describe("Modal — variant close contract", () => {
  it("dialog variant: Escape and backdrop click both close; role=dialog", () => {
    const onClose = vi.fn();
    const r = render(
      <Modal open onClose={onClose} labelId="t" variant="dialog">
        <h2 id="t">Edit</h2>
        <button type="button">x</button>
      </Modal>,
    );
    expect(docGet("modal-dialog").getAttribute("role")).toBe("dialog");
    expect(docGet("modal-dialog").getAttribute("aria-modal")).toBe("true");

    escape(docGet("modal-dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);

    mousedown(docGet("modal-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(2);
    r.unmount();
  });

  it("danger variant: Escape closes but a backdrop click does NOT; role=alertdialog", () => {
    const onClose = vi.fn();
    const r = render(
      <Modal open onClose={onClose} labelId="t" describedById="d" variant="danger">
        <h2 id="t">Delete?</h2>
        <p id="d">irreversible</p>
        <button type="button">cancel</button>
      </Modal>,
    );
    expect(docGet("modal-dialog").getAttribute("role")).toBe("alertdialog");

    // A backdrop click is inert for the irreversible variant.
    mousedown(docGet("modal-backdrop"));
    expect(onClose).not.toHaveBeenCalled();

    // Escape still routes to the safe cancel.
    escape(docGet("modal-dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it("renders nothing when closed", () => {
    const r = render(
      <Modal open={false} onClose={() => {}} labelId="t">
        <h2 id="t">hidden</h2>
      </Modal>,
    );
    expect(docQuery("modal-dialog")).toBeNull();
    r.unmount();
  });
});
