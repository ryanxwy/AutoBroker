// @vitest-environment happy-dom
/**
 * ClosedSearchesGroup.test — the "Closed" group inside the Searches popover,
 * driven against an injected ApiClient (mock fetch). Proves: the group renders a
 * row per closed profile with a Restore verb; a Restore fires the POST and
 * invalidates ["profiles"] on success (the row leaves the list); a 409
 * active_slot_conflict renders the inline conflict line reading the brand off the
 * error envelope; the group renders nothing when there are no closed profiles.
 */

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "../api/client.js";
import * as dataChanged from "../api/useDataChanged.js";
import { click, render } from "../test/render.js";
import { ClosedSearchesGroup } from "./ClosedSearchesGroup.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLOSED_ROWS = [
  { search_profile_id: "closed-1", year: 2025, make: "Hyundai", model: "Tucson Hybrid", trim: "Limited", status: "closed" },
  { search_profile_id: "closed-2", year: 2026, make: "Toyota", model: "RAV4", trim: "XLE", status: "closed" },
];

/** A mock fetch: GET /api/profiles?status=closed → a row list that empties after
 *  a restore (call-count driven); POST /restore → the selected outcome. */
function mockFetch(opts: {
  listCalls?: { n: number };
  restored?: string[];
  restoreOutcome?: "ok" | "conflict";
  emptyAfterRestore?: boolean;
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (url.includes("/api/profiles") && url.includes("status=closed") && (init?.method ?? "GET") === "GET") {
      if (opts.listCalls) opts.listCalls.n += 1;
      // After a restore the second list call returns the row removed.
      const rows = opts.emptyAfterRestore && (opts.listCalls?.n ?? 0) > 1 ? [CLOSED_ROWS[1]] : CLOSED_ROWS;
      return json(rows);
    }
    if (url.includes("/restore") && init?.method === "POST") {
      opts.restored?.push(url);
      if (opts.restoreOutcome === "conflict") {
        return json(
          { error: { code: "active_slot_conflict", message: "slot taken", brand: "Hyundai" } },
          409,
        );
      }
      return json({ search_profile_id: "closed-1", status: "active", make: "Hyundai" });
    }
    return json({ error: { code: "nf", message: "no route" } }, 404);
  }) as typeof fetch;
}

function flush(): Promise<void> {
  return act(async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ClosedSearchesGroup — list + restore", () => {
  it("renders a Closed group with a Restore verb per closed profile", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch({}) });
    const r = render(<ClosedSearchesGroup client={client} />);
    await flush();

    expect(r.query("searches-closed-group")).not.toBeNull();
    expect(r.get("searches-closed-row-closed-1").textContent).toContain("Hyundai");
    expect(r.query("profile-restore-closed-1")).not.toBeNull();
    expect(r.query("profile-restore-closed-2")).not.toBeNull();
    r.unmount();
  });

  it("renders nothing when there are no closed profiles", async () => {
    const client = new ApiClient({
      fetchImpl: (async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    const r = render(<ClosedSearchesGroup client={client} />);
    await flush();
    expect(r.query("searches-closed-group")).toBeNull();
    r.unmount();
  });

  it("Restore fires the POST and invalidates [\"profiles\"]; the row leaves the list", async () => {
    const restored: string[] = [];
    const listCalls = { n: 0 };
    const invalidateSpy = vi.spyOn(dataChanged, "invalidate");
    const client = new ApiClient({
      fetchImpl: mockFetch({ restored, listCalls, restoreOutcome: "ok", emptyAfterRestore: true }),
    });
    const r = render(<ClosedSearchesGroup client={client} />);
    await flush();

    click(r.get("profile-restore-closed-1"));
    await flush();

    expect(restored).toHaveLength(1);
    expect(restored[0]).toContain("/api/profiles/closed-1/restore");
    expect(invalidateSpy).toHaveBeenCalledWith(["profiles"]);
    // The list re-fetched and the restored row is gone (only closed-2 remains).
    expect(r.query("searches-closed-row-closed-1")).toBeNull();
    expect(r.query("searches-closed-row-closed-2")).not.toBeNull();
    r.unmount();
  });

  it("a 409 active_slot_conflict renders the inline conflict line reading the brand", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch({ restoreOutcome: "conflict" }) });
    const r = render(<ClosedSearchesGroup client={client} />);
    await flush();

    click(r.get("profile-restore-closed-1"));
    await flush();

    const conflict = r.get("profile-restore-conflict-closed-1");
    expect(conflict.textContent).toContain("active Hyundai search");
    // The row stays (restore did not succeed).
    expect(r.query("searches-closed-row-closed-1")).not.toBeNull();
    r.unmount();
  });
});
