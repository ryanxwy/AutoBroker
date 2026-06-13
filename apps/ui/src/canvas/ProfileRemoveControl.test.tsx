// @vitest-environment happy-dom
/**
 * ProfileRemoveControl.test — the soft-delete affordance at the profile card
 * foot, driven against an injected ApiClient (mock fetch). Proves: the open
 * button expands the inline gate-card confirm; "Keep it" closes it (no DELETE);
 * Remove fires the DELETE and invalidates ["profiles"] on success; a 409
 * profile_busy keeps the card open with the busy plate; a generic error keeps
 * the card open with the error line.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "../api/client.js";
import * as dataChanged from "../api/useDataChanged.js";
import { click, render } from "../test/render.js";
import { ProfileRemoveControl } from "./ProfileRemoveControl.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A mock fetch: DELETE /api/profiles/:id → the selected outcome. */
function mockFetch(opts: {
  deleted?: string[];
  outcome?: "ok" | "busy" | "error";
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/profiles/") && init?.method === "DELETE") {
      opts.deleted?.push(url);
      if (opts.outcome === "busy") {
        return new Response(
          JSON.stringify({ error: { code: "profile_busy", message: "a run is using it" } }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      if (opts.outcome === "error") {
        return new Response(
          JSON.stringify({ error: { code: "internal", message: "boom" } }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ error: { code: "nf", message: "no route" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProfileRemoveControl — confirm → remove → states", () => {
  it("opening expands the inline confirm gate-card with the honest recoverable copy", () => {
    const client = new ApiClient({ fetchImpl: mockFetch({}) });
    const r = render(<ProfileRemoveControl client={client} profileId="prof-1" />);

    expect(r.query("profile-remove-confirm")).toBeNull();
    click(r.get("profile-remove-open"));

    const card = r.get("profile-remove-confirm");
    expect(card.getAttribute("role")).toBe("alertdialog");
    expect(card.textContent).toContain("Your data is kept");
    expect(card.textContent).toContain("restored from Closed searches");
    r.unmount();
  });

  it("\"Keep it\" closes the confirm without firing a DELETE", () => {
    const deleted: string[] = [];
    const client = new ApiClient({ fetchImpl: mockFetch({ deleted }) });
    const r = render(<ProfileRemoveControl client={client} profileId="prof-1" />);

    click(r.get("profile-remove-open"));
    click(r.get("profile-remove-cancel"));

    expect(r.query("profile-remove-confirm")).toBeNull();
    expect(r.query("profile-remove-open")).not.toBeNull();
    expect(deleted).toHaveLength(0);
    r.unmount();
  });

  it("Remove fires the DELETE and invalidates [\"profiles\"] on a 204 success", async () => {
    const deleted: string[] = [];
    const invalidateSpy = vi.spyOn(dataChanged, "invalidate");
    const client = new ApiClient({ fetchImpl: mockFetch({ deleted, outcome: "ok" }) });
    const r = render(<ProfileRemoveControl client={client} profileId="prof-1" />);

    click(r.get("profile-remove-open"));
    click(r.get("profile-remove-confirm-yes"));
    await flush();

    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain("/api/profiles/prof-1");
    expect(invalidateSpy).toHaveBeenCalledWith(["profiles"]);
    r.unmount();
  });

  it("a 409 profile_busy keeps the card open with the busy failure plate", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch({ outcome: "busy" }) });
    const r = render(<ProfileRemoveControl client={client} profileId="prof-1" />);

    click(r.get("profile-remove-open"));
    click(r.get("profile-remove-confirm-yes"));
    await flush();

    // The card is still open and now carries the busy message.
    expect(r.query("profile-remove-confirm")).not.toBeNull();
    expect(r.get("profile-remove-busy").textContent).toContain("a run is using it");
    r.unmount();
  });

  it("a generic error keeps the card open with the error line", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch({ outcome: "error" }) });
    const r = render(<ProfileRemoveControl client={client} profileId="prof-1" />);

    click(r.get("profile-remove-open"));
    click(r.get("profile-remove-confirm-yes"));
    await flush();

    expect(r.query("profile-remove-confirm")).not.toBeNull();
    expect(r.query("profile-remove-error")).not.toBeNull();
    r.unmount();
  });
});
