// @vitest-environment happy-dom
/**
 * Canvas.rebind — the Phase-3 multi-profile rebind. The workbench must bind to
 * the EXPLICIT focused profile (the route/run pipeline's profile, threaded from
 * the session pin) instead of the newest-active `data[0]`. Freezes:
 *   - profileId set ⇒ the header vehicle is the EXPLICIT profile (getProfile),
 *     NOT data[0];
 *   - profileId absent ⇒ data[0] (byte-identical to the single-active home path).
 *
 * Only the header (canvas-vehicle, from the resolved snapshot) is asserted; the
 * per-profile sub-resource reads are allowed to 404 harmlessly (they render their
 * own empty/error sections — the header binds off the snapshot).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";

import { ApiClient } from "../api/client.js";
import { invalidate, resetDataRefetchForTests } from "../api/useDataChanged.js";
import { render } from "../test/render.js";
import { Canvas } from "./Canvas.js";

const P1 = { search_profile_id: "p1", year: 2026, make: "Honda", model: "Accord", status: "active" };
const P2 = { search_profile_id: "p2", year: 2026, make: "Toyota", model: "Camry", status: "active" };

/** A mock fetch answering the routes Canvas calls. /api/profiles (list) →
 *  [P1, P2] (newest-first); /api/profiles/:id → that single row; every
 *  per-profile sub-resource + digest 404s harmlessly. */
function mockFetch(): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    // single profile: /api/profiles/<id> (no further segment, no query)
    const single = /\/api\/profiles\/([^/?]+)$/.exec(url);
    if (single !== null) {
      const id = single[1]!;
      if (id === "p-gone") return json({ error: { code: "not_found", message: "gone" } }, 404);
      if (id === "p-closed") return json({ ...P2, search_profile_id: "p-closed", status: "closed" });
      return json(id === "p2" ? P2 : P1);
    }
    if (url.includes("/api/profiles")) return json([P1, P2]); // list (newest-first)
    return json({ error: { code: "not_found", message: "no route" } }, 404);
  }) as typeof fetch;
}

function flush(): Promise<void> {
  return act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  window.history.pushState({}, "", "/");
});
afterEach(() => {
  resetDataRefetchForTests();
});

const NOOP = (): void => {};

describe("Canvas rebind to the explicit focused profile", () => {
  it("binds to data[0] when no profileId is supplied (byte-identical home path)", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(<Canvas client={client} onStartIntake={NOOP} onEditProfile={NOOP} />);
    await flush();
    expect(r.get("canvas-vehicle").textContent).toContain("Accord"); // data[0] = P1
    expect(r.get("canvas-vehicle").textContent).not.toContain("Camry");
    r.unmount();
  });

  it("binds to the EXPLICIT profile (not data[0]) when profileId is set", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(
      <Canvas client={client} onStartIntake={NOOP} profileId="p2" onEditProfile={NOOP} />,
    );
    await flush();
    expect(r.get("canvas-vehicle").textContent).toContain("Camry"); // explicit P2
    expect(r.get("canvas-vehicle").textContent).not.toContain("Accord");
    r.unmount();
  });

  it("falls back to data[0] when the pinned profile is CLOSED (stale pin must not strand)", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(
      <Canvas client={client} onStartIntake={NOOP} profileId="p-closed" onEditProfile={NOOP} />,
    );
    await flush();
    expect(r.get("canvas-vehicle").textContent).toContain("Accord"); // data[0] fallback
    r.unmount();
  });

  it("falls back to data[0] when the pinned profile was DELETED (404)", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(
      <Canvas client={client} onStartIntake={NOOP} profileId="p-gone" onEditProfile={NOOP} />,
    );
    await flush();
    expect(r.get("canvas-vehicle").textContent).toContain("Accord"); // data[0] fallback
    r.unmount();
  });
});

/** Same routes as mockFetch, but records every requested URL for assertions. */
function recordingFetch(urls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const single = /\/api\/profiles\/([^/?]+)$/.exec(url);
    if (single !== null) {
      const id = single[1]!;
      if (id === "p-gone") return json({ error: { code: "not_found", message: "gone" } }, 404);
      return json(id === "p2" ? P2 : P1);
    }
    if (url.includes("/api/profiles")) return json([P1, P2]);
    return json({ error: { code: "not_found", message: "no route" } }, 404);
  }) as typeof fetch;
}

/** A single-profile read: /api/profiles/<id> with no further segment/query. */
const SINGLE_PROFILE = /\/api\/profiles\/[^/?]+$/;

describe("Canvas — never issues a doomed getProfile on a null or gone pin (console 404 guard)", () => {
  it("never fetches /api/profiles/<id> for a null pin, even on a profiles pulse", async () => {
    const urls: string[] = [];
    const client = new ApiClient({ fetchImpl: recordingFetch(urls) });
    const r = render(<Canvas client={client} onStartIntake={NOOP} onEditProfile={NOOP} />);
    await flush();
    // A global "profiles" pulse (e.g. a STOP/clarify run completing). The explicit
    // fetch's refetch bypasses its enabled flag, so pre-fix this fired
    // getProfile(null) -> /api/profiles/null. The closure guard now skips it.
    await act(async () => {
      invalidate(["profiles"], null);
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(urls.filter((u) => SINGLE_PROFILE.test(u))).toEqual([]);
    r.unmount();
  });

  it("does not re-fetch a just-deleted pin on a profiles pulse (post-reset accumulation stopped)", async () => {
    const urls: string[] = [];
    const client = new ApiClient({ fetchImpl: recordingFetch(urls) });
    const r = render(
      <Canvas client={client} onStartIntake={NOOP} profileId="p-gone" onEditProfile={NOOP} />,
    );
    await flush(); // the active list [P1, P2] loads; p-gone is not in it
    urls.length = 0; // ignore the one bounded mount-race fetch; assert the PULSE is suppressed
    // The pipeline_reset pulse carries profile_id null and matches every
    // registration; pre-fix this re-fired getProfile("p-gone") (a fresh 404) each
    // pulse. With the list resolved, the membership guard now skips it.
    await act(async () => {
      invalidate(["profiles"], null);
      await new Promise((res) => setTimeout(res, 0));
    });
    expect(urls.filter((u) => /\/api\/profiles\/p-gone$/.test(u))).toEqual([]);
    r.unmount();
  });
});
