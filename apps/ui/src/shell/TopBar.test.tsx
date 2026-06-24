// @vitest-environment happy-dom
/**
 * TopBar.test — the open-popover auto-refresh regression. The Searches popover's
 * active-searches list is subscribed to the data-change bus (useDataRefetch on
 * "profiles"), so a write that lands WHILE the popover is open (a restored /
 * created / removed profile) refreshes the list in place — no close/reopen. This
 * proves that path: open with 0 active rows ("No active searches yet."), flip the
 * mock to return 1 active row, pulse invalidate(["profiles"]) without touching
 * the popover, and assert the active row now renders.
 */

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "../api/client.js";
import { invalidate, resetDataRefetchForTests } from "../api/useDataChanged.js";
import { click, render } from "../test/render.js";
import { TopBar } from "./TopBar.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACTIVE_ROW = {
  search_profile_id: "active-1",
  year: 2026,
  make: "Hyundai",
  model: "Tucson Hybrid",
  trim: "Limited",
  status: "active",
};

/** A mock fetch: GET /api/profiles?status=active returns ZERO rows until
 *  `flag.hasRow` flips to true, then ONE row (so a refetch returns new data);
 *  sessions + skills are empty so the popover renders only the active list. */
function mockFetch(flag: { hasRow: boolean }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (url.includes("/api/profiles") && url.includes("status=active") && (init?.method ?? "GET") === "GET") {
      return json(flag.hasRow ? [ACTIVE_ROW] : []);
    }
    if (url.includes("/api/sessions") && (init?.method ?? "GET") === "GET") {
      return json([]);
    }
    if (url.includes("/api/skills") && (init?.method ?? "GET") === "GET") {
      return json([]);
    }
    return json({ error: { code: "nf", message: "no route" } }, 404);
  }) as typeof fetch;
}

function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const noop = (): void => {};
const baseProps = {
  runActive: false,
  pinnedProfileId: null,
  appMode: null,
  onModeSwitched: noop,
  onStartIntake: noop,
  onPin: noop,
  onUnpin: noop,
  onViewProfile: noop,
  onOpenSettings: noop,
};

beforeEach(() => {
  resetDataRefetchForTests();
  vi.restoreAllMocks();
});
afterEach(() => {
  resetDataRefetchForTests();
  vi.restoreAllMocks();
});

describe("TopBar — open Searches popover auto-refreshes on data.changed", () => {
  it("an open popover with 0 active rows shows the restored row after invalidate([\"profiles\"])", async () => {
    const flag = { hasRow: false };
    const client = new ApiClient({ fetchImpl: mockFetch(flag) });
    const r = render(<TopBar client={client} {...baseProps} />);
    await flush();

    // Open the Searches popover — 0 active rows yields the empty notice.
    click(r.get("topbar-searches"));
    await flush();
    expect(r.query("searches-popover")).not.toBeNull();
    expect(r.get("searches-popover").textContent).toContain("No active searches yet.");
    expect(r.query("searches-row-active-1")).toBeNull();

    // A write lands (a profile restored) while the popover is STILL open: flip
    // the mock and pulse the bus — no close/reopen.
    flag.hasRow = true;
    act(() => invalidate(["profiles"]));
    await flush();

    // The open list refreshed in place — the active row now renders.
    expect(r.query("searches-row-active-1")).not.toBeNull();
    expect(r.get("searches-row-active-1").textContent).toContain("Hyundai");
    r.unmount();
  });
});
