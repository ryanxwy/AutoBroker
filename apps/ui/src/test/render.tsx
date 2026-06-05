/**
 * render — a tiny RTL-free render helper for component tests, following the
 * scaffold's useRunStream.test pattern (react-dom/client + act under happy-dom; no
 * @testing-library dep). Exposes the container + query-by-testid helpers + a
 * click/change/submit driver. Kept under src/test/ (no `.test` suffix) so vitest
 * does not pick it up as a suite.
 */

import { act } from "react";
import { type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Rendered {
  container: HTMLElement;
  root: Root;
  rerender: (el: ReactElement) => void;
  unmount: () => void;
  get: (testId: string) => HTMLElement;
  query: (testId: string) => HTMLElement | null;
  all: (testId: string) => HTMLElement[];
}

export function render(el: ReactElement): Rendered {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(el);
  });
  const get = (testId: string): HTMLElement => {
    const node = container.querySelector(`[data-testid="${testId}"]`);
    if (node === null) throw new Error(`no node with data-testid="${testId}"`);
    return node as HTMLElement;
  };
  return {
    container,
    root,
    rerender: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
    get,
    query: (testId) => container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null,
    all: (testId) =>
      Array.from(container.querySelectorAll(`[data-testid="${testId}"]`)) as HTMLElement[],
  };
}

/** Fire a click inside act(). */
export function click(node: HTMLElement): void {
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Set an input/textarea value + dispatch React's input event inside act(). */
export function change(node: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Toggle a radio/checkbox (sets checked + fires React's change). */
export function clickRadio(node: HTMLInputElement): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
  act(() => {
    setter?.call(node, true);
    node.dispatchEvent(new Event("click", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** Submit a form inside act(). */
export function submit(form: HTMLFormElement): void {
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
