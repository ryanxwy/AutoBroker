// @vitest-environment happy-dom
/**
 * RailResizer.test — the keyboard resize contract (the path CI can exercise
 * without a layout engine): arrow steps widen/narrow + clamp + persist, and the
 * Enter collapse/restore with its restore-point invalidated by any intervening
 * sizing key. clientWidth is stubbed (happy-dom does no layout) so the clamp math
 * has a real container width; the persisted value backstops the CSS-var read.
 */

import { act, useRef } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { render } from "../test/render.js";
import { RailResizer } from "./RailResizer.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="app-body" data-testid="app-body" ref={ref}>
      <RailResizer containerRef={ref} />
    </div>
  );
}

function keydown(node: HTMLElement, init: KeyboardEventInit): void {
  act(() => {
    node.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}
function widthOf(body: HTMLElement): number {
  return parseFloat(body.style.getPropertyValue("--rail-width"));
}

/** Render the harness, stub the container's clientWidth (no layout in happy-dom),
 *  and seed the start width into BOTH the inline var and localStorage (the
 *  resizer reads the live width via the CSS var, falling back to the persisted
 *  value). */
function setup(startPx: number): { body: HTMLElement; sep: HTMLElement; unmount: () => void } {
  const r = render(<Harness />);
  const body = r.get("app-body");
  Object.defineProperty(body, "clientWidth", { value: 1200, configurable: true });
  localStorage.setItem("autobroker:rail-width", String(startPx));
  body.style.setProperty("--rail-width", `${startPx}px`);
  return { body, sep: r.get("rail-resizer"), unmount: r.unmount };
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("RailResizer — keyboard resize", () => {
  it("arrows widen/narrow by 16, clamp to [320, max], and persist", () => {
    const { body, sep, unmount } = setup(400);
    keydown(sep, { key: "ArrowLeft" }); // toward the rail = bigger → 416
    expect(widthOf(body)).toBe(416);
    keydown(sep, { key: "ArrowRight" }); // → 400
    expect(widthOf(body)).toBe(400);
    keydown(sep, { key: "Home" }); // → MIN 320
    expect(widthOf(body)).toBe(320);
    keydown(sep, { key: "ArrowRight" }); // 320-16 → clamped back to 320
    expect(widthOf(body)).toBe(320);
    keydown(sep, { key: "End" }); // → max = min(800, 60% of 1200=720) = 720
    expect(widthOf(body)).toBe(720);
    expect(localStorage.getItem("autobroker:rail-width")).toBe("720");
    unmount();
  });

  it("Enter collapses then restores; an intervening arrow invalidates the restore point", () => {
    const { body, sep, unmount } = setup(480);
    keydown(sep, { key: "Enter" }); // collapse: store 480 → MIN 320
    expect(widthOf(body)).toBe(320);
    keydown(sep, { key: "Enter" }); // restore → 480
    expect(widthOf(body)).toBe(480);

    keydown(sep, { key: "Enter" }); // collapse again: store 480 → 320
    expect(widthOf(body)).toBe(320);
    keydown(sep, { key: "ArrowLeft" }); // invalidates the restore point; 320 → 336
    expect(widthOf(body)).toBe(336);
    keydown(sep, { key: "Enter" }); // stores 336 → 320 (NOT the stale 480)
    expect(widthOf(body)).toBe(320);
    keydown(sep, { key: "Enter" }); // restore → 336
    expect(widthOf(body)).toBe(336);
    unmount();
  });
});
