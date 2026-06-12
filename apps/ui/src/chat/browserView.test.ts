/**
 * browserView unit tests — the zone-4 reducer: trail folding (bounded,
 * dedup of the screenshot live-twin), the concurrent-open count (N parallel
 * isolated browsers, opened/closed interleave), screenshot latching, and
 * defensive no-ops on malformed data.
 */

import { describe, expect, it } from "vitest";

import {
  BROWSER_TRAIL_LIMIT,
  EMPTY_BROWSER_VIEW,
  reduceBrowserView,
  type BrowserView,
} from "./browserView.js";

function fold(parts: unknown[]): BrowserView {
  return parts.reduce<BrowserView>((v, p) => reduceBrowserView(v, p), EMPTY_BROWSER_VIEW);
}

describe("browserView — trail folding", () => {
  it("opened/action/error/closed fold into labeled entries (host, not full URL)", () => {
    const view = fold([
      { kind: "browser.opened", payload: { url: "https://www.google.com/maps/search/x" } },
      { kind: "browser.action", payload: { type: "navigate", target: "https://www.google.com/maps/search/x" } },
      { kind: "browser.error", payload: { message: "navigation timeout" } },
      { kind: "browser.closed", payload: {} },
    ]);
    expect(view.entries.map((e) => `${e.kind}:${e.label}`)).toEqual([
      "opened:Opened www.google.com",
      "action:navigate www.google.com",
      "error:navigation timeout",
      "closed:Browser closed",
    ]);
  });

  it("tolerates N concurrent opened states (parallel isolated browsers)", () => {
    const opened = { kind: "browser.opened", payload: { url: "https://maps.example/" } };
    const closed = { kind: "browser.closed", payload: {} };
    let view = fold([opened, opened, opened]); // 3 browsers in flight
    expect(view.openCount).toBe(3);
    view = [closed, closed].reduce((v, p) => reduceBrowserView(v, p), view);
    expect(view.openCount).toBe(1);
    // A stray extra closed never goes negative.
    view = [closed, closed].reduce((v, p) => reduceBrowserView(v, p), view);
    expect(view.openCount).toBe(0);
  });

  it("bounds the trail to the newest BROWSER_TRAIL_LIMIT entries", () => {
    const parts = Array.from({ length: BROWSER_TRAIL_LIMIT + 4 }, (_, i) => ({
      kind: "browser.action",
      payload: { type: "navigate", target: `https://host${i}.example/` },
    }));
    const view = fold(parts);
    expect(view.entries).toHaveLength(BROWSER_TRAIL_LIMIT);
    expect(view.entries[view.entries.length - 1]!.label).toBe(
      `navigate host${BROWSER_TRAIL_LIMIT + 3}.example`,
    );
  });
});

describe("browserView — screenshots (live-only thumbnail)", () => {
  it("latches the latest screenshot and collapses the live twin's duplicate label", () => {
    const view = fold([
      { kind: "browser.action", payload: { type: "navigate", target: "https://a.example/" } },
      // The fan-out-only twin repeats the same {type,target} plus the base64.
      {
        kind: "browser.action",
        payload: { type: "navigate", target: "https://a.example/", screenshot_b64: "AAA" },
      },
      { kind: "browser.action", payload: { type: "navigate", target: "https://b.example/", screenshot_b64: "BBB" } },
    ]);
    expect(view.screenshot).toBe("BBB"); // latest wins
    // The duplicate-label twin did not double the trail.
    expect(view.entries.map((e) => e.label)).toEqual([
      "navigate a.example",
      "navigate b.example",
    ]);
  });
});

describe("browserView — defensive no-ops", () => {
  it("unknown kinds and malformed data leave the view unchanged", () => {
    const view = fold([
      null,
      42,
      { kind: "data-gate" },
      { kind: "browser.unknown", payload: {} },
    ]);
    expect(view).toEqual(EMPTY_BROWSER_VIEW);
  });
});
