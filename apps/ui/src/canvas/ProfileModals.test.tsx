// @vitest-environment happy-dom
/**
 * ProfileModals.test — the irreversible HardDeleteModal: Cancel calls onClose,
 * Permanently-delete calls onConfirm, the busy state disables both buttons, and
 * an error surfaces. (Portaled to document.body → queried off the document.)
 */

import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { render } from "../test/render.js";
import { HardDeleteModal } from "./ProfileModals.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const docGet = (testId: string): HTMLElement => {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  if (node === null) throw new Error(`no node with data-testid="${testId}"`);
  return node as HTMLElement;
};
const docQuery = (testId: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
function clickDoc(node: HTMLElement): void {
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

describe("HardDeleteModal — irreversible confirm", () => {
  it("names the search, confirms via onConfirm, cancels via onClose", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const r = render(
      <HardDeleteModal
        open
        name="2026 Toyota RAV4"
        busy={false}
        error={null}
        onClose={onClose}
        onConfirm={onConfirm}
      />,
    );
    expect(docGet("hard-del-title").textContent).toContain("2026 Toyota RAV4");

    clickDoc(docGet("hard-del-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    clickDoc(docGet("hard-del-cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it("busy disables both buttons; an error surfaces", () => {
    const r = render(
      <HardDeleteModal
        open
        name="x"
        busy={true}
        error="boom"
        onClose={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect((docGet("hard-del-confirm") as HTMLButtonElement).disabled).toBe(true);
    expect((docGet("hard-del-cancel") as HTMLButtonElement).disabled).toBe(true);
    expect(docQuery("hard-del-error")?.textContent).toContain("boom");
    r.unmount();
  });
});
