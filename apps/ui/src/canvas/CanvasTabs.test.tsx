// @vitest-environment happy-dom
/**
 * CanvasTabs.test — the presentational workbench tab strip. Proves: tabs render
 * with their testids, the badge shows ONLY for a count > 0 (never for null or
 * 0), clicking a tab calls onSelect with its key, aria-selected tracks the
 * active key, and ArrowLeft/ArrowRight roving moves the selection.
 */

import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { click, render } from "../test/render.js";
import { CanvasTabs, type CanvasTab } from "./CanvasTabs.js";

function tabs(): CanvasTab[] {
  return [
    { key: "overview", label: "Overview", count: null },
    { key: "dealers", label: "Dealers", count: 2 },
    { key: "inventory", label: "Inventory", count: 0 },
    { key: "quotes", label: "Quotes", count: null },
  ];
}

describe("CanvasTabs — render", () => {
  it("renders one role=tab button per tab with its testid", () => {
    const { query, all } = render(<CanvasTabs tabs={tabs()} active="overview" onSelect={() => {}} />);
    expect(query("canvas-tab-overview")).not.toBeNull();
    expect(query("canvas-tab-dealers")).not.toBeNull();
    expect(query("canvas-tab-inventory")).not.toBeNull();
    expect(query("canvas-tab-quotes")).not.toBeNull();
    expect(all("canvas-tabs")).toHaveLength(1);
  });
});

describe("CanvasTabs — badge", () => {
  it("shows the badge only for count > 0", () => {
    const { get } = render(<CanvasTabs tabs={tabs()} active="overview" onSelect={() => {}} />);
    // count=2 → badge present with "2".
    expect(get("canvas-tab-dealers").querySelector(".canvas-tab-badge")?.textContent).toBe("2");
    // count=0 → no badge.
    expect(get("canvas-tab-inventory").querySelector(".canvas-tab-badge")).toBeNull();
    // count=null (overview/quotes) → no badge.
    expect(get("canvas-tab-overview").querySelector(".canvas-tab-badge")).toBeNull();
    expect(get("canvas-tab-quotes").querySelector(".canvas-tab-badge")).toBeNull();
  });
});

describe("CanvasTabs — selection", () => {
  it("calls onSelect with the tab key on click", () => {
    const onSelect = vi.fn();
    const { get } = render(<CanvasTabs tabs={tabs()} active="overview" onSelect={onSelect} />);
    click(get("canvas-tab-dealers"));
    expect(onSelect).toHaveBeenCalledWith("dealers");
  });

  it("aria-selected tracks the active key", () => {
    const { get } = render(<CanvasTabs tabs={tabs()} active="dealers" onSelect={() => {}} />);
    expect(get("canvas-tab-dealers").getAttribute("aria-selected")).toBe("true");
    expect(get("canvas-tab-overview").getAttribute("aria-selected")).toBe("false");
  });
});

describe("CanvasTabs — keyboard roving", () => {
  function arrow(node: HTMLElement, key: "ArrowLeft" | "ArrowRight"): void {
    act(() => {
      node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  }

  it("ArrowRight moves selection to the next tab", () => {
    const onSelect = vi.fn();
    const { get } = render(<CanvasTabs tabs={tabs()} active="overview" onSelect={onSelect} />);
    arrow(get("canvas-tabs"), "ArrowRight");
    expect(onSelect).toHaveBeenCalledWith("dealers");
  });

  it("ArrowLeft wraps from the first tab to the last", () => {
    const onSelect = vi.fn();
    const { get } = render(<CanvasTabs tabs={tabs()} active="overview" onSelect={onSelect} />);
    arrow(get("canvas-tabs"), "ArrowLeft");
    expect(onSelect).toHaveBeenCalledWith("quotes");
  });
});

describe("CanvasTabs — ARIA wiring", () => {
  it("tablist has an accessible name", () => {
    const { get } = render(<CanvasTabs tabs={tabs()} active="overview" onSelect={() => {}} />);
    expect(get("canvas-tabs").getAttribute("aria-label")).toBe("Workbench sections");
  });

  it("each tab button has a stable id and aria-controls pointing at its panel", () => {
    const { get } = render(<CanvasTabs tabs={tabs()} active="overview" onSelect={() => {}} />);
    for (const tab of tabs()) {
      const btn = get(`canvas-tab-${tab.key}`);
      expect(btn.id).toBe(`canvas-tab-${tab.key}-tab`);
      expect(btn.getAttribute("aria-controls")).toBe(`canvas-panel-${tab.key}`);
    }
  });

  it("ArrowRight selection moves DOM focus to the next tab button", () => {
    const onSelect = vi.fn((key: string) => key); // capture the selected key
    const { get } = render(<CanvasTabs tabs={tabs()} active="overview" onSelect={onSelect} />);
    // focus the active tab first so the element is in the document
    get("canvas-tab-overview").focus();
    act(() => {
      get("canvas-tabs").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      );
    });
    expect(onSelect).toHaveBeenCalledWith("dealers");
    // The dealers button should now be the focused element.
    expect(document.activeElement).toBe(get("canvas-tab-dealers"));
  });
});
