// @vitest-environment happy-dom
/**
 * ClickableTile.test — the shared whole-card clickable primitive. Proves: a
 * click fires onActivate; Enter fires; Space fires; other keys are ignored; and
 * a nested interactive child that calls e.stopPropagation() does NOT also fire
 * onActivate (so the inline "View listing" link click-through stays distinct
 * from opening the detail modal).
 */

import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { ClickableTile } from "./ClickableTile.js";
import { click, render } from "../test/render.js";

function keyDown(node: HTMLElement, key: string): void {
  act(() => {
    node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("ClickableTile", () => {
  it("fires onActivate on click", () => {
    const onActivate = vi.fn();
    const { get } = render(
      <ClickableTile testid="tile" ariaLabel="Open" onActivate={onActivate}>
        body
      </ClickableTile>,
    );
    click(get("tile"));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("fires onActivate on Enter", () => {
    const onActivate = vi.fn();
    const { get } = render(
      <ClickableTile testid="tile" ariaLabel="Open" onActivate={onActivate}>
        body
      </ClickableTile>,
    );
    keyDown(get("tile"), "Enter");
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("fires onActivate on Space", () => {
    const onActivate = vi.fn();
    const { get } = render(
      <ClickableTile testid="tile" ariaLabel="Open" onActivate={onActivate}>
        body
      </ClickableTile>,
    );
    keyDown(get("tile"), " ");
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys", () => {
    const onActivate = vi.fn();
    const { get } = render(
      <ClickableTile testid="tile" ariaLabel="Open" onActivate={onActivate}>
        body
      </ClickableTile>,
    );
    keyDown(get("tile"), "a");
    keyDown(get("tile"), "Tab");
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("is a role=button with tabIndex 0 and the aria-label", () => {
    const { get } = render(
      <ClickableTile testid="tile" ariaLabel="View details" onActivate={() => {}}>
        body
      </ClickableTile>,
    );
    const tile = get("tile");
    expect(tile.getAttribute("role")).toBe("button");
    expect(tile.getAttribute("tabindex")).toBe("0");
    expect(tile.getAttribute("aria-label")).toBe("View details");
    expect(tile.className).toContain("tile");
    expect(tile.className).toContain("tile-clickable");
  });

  it("does NOT fire onActivate when a nested link stops propagation", () => {
    const onActivate = vi.fn();
    const { container } = render(
      <ClickableTile testid="tile" ariaLabel="Open" onActivate={onActivate}>
        <a
          href="https://dealer.test/vdp"
          data-testid="nested-link"
          onClick={(e) => e.stopPropagation()}
        >
          View listing
        </a>
      </ClickableTile>,
    );
    const link = container.querySelector('[data-testid="nested-link"]') as HTMLElement;
    click(link);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("does NOT fire onActivate when Enter is pressed on a nested control (no double-fire)", () => {
    const onActivate = vi.fn();
    const { container } = render(
      <ClickableTile testid="tile" ariaLabel="Open" onActivate={onActivate}>
        <a href="https://dealer.test/vdp" data-testid="nested-link">
          View listing
        </a>
      </ClickableTile>,
    );
    // Enter dispatched on the FOCUSED nested link bubbles up to the tile's
    // onKeyDown; the handler must ignore descendant key events (only the
    // tile-focused case activates), so onActivate stays silent.
    const link = container.querySelector('[data-testid="nested-link"]') as HTMLElement;
    keyDown(link, "Enter");
    expect(onActivate).not.toHaveBeenCalled();
  });
});
