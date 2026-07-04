// @vitest-environment happy-dom
/**
 * Canvas.runview — the hidden run binder + the slim profile strip. Freezes:
 *   - runId set ⇒ run-view-id renders the BARE run id (the harness binds via
 *     trim() === runId), even with NO active profile;
 *   - runId absent ⇒ no run-view-id node at all;
 *   - the strip carries location + the preference chips + the Edit/Remove
 *     controls, and the retired identity row / hard-delete foot never render.
 */

import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ApiClient } from "../api/client.js";
import { resetDataRefetchForTests } from "../api/useDataChanged.js";
import { render } from "../test/render.js";
import { Canvas } from "./Canvas.js";

const ACTIVE = {
  search_profile_id: "p1",
  year: 2026,
  make: "Hyundai",
  model: "Tucson Hybrid",
  location_query: "Irvine, CA 92614",
  search_radius_miles: 25,
  financing_preference: "finance",
  status: "active",
};

/** A mock fetch: the profile LIST route answers with `profiles`; every other
 *  route (sub-resources, digest) answers [] — the digest decode rejects it into
 *  a harmless error state, the array reads parse as empty. */
function mockFetch(profiles: unknown[]): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    // list only: /api/profiles or /api/profiles?… (never /api/profiles/:id/…)
    if (/\/api\/profiles(\?.*)?$/.test(url)) return json(profiles);
    return json([]);
  }) as typeof fetch;
}

function flush(): Promise<void> {
  return act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => {
  resetDataRefetchForTests();
});

const NOOP = (): void => {};

describe("Canvas run binder + profile strip", () => {
  it("run-view-id carries the BARE run id even with no active profile", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch([]) });
    const r = render(
      <Canvas client={client} onStartIntake={NOOP} runId="run-e2e-1" onEditProfile={NOOP} />,
    );
    await flush();
    const binder = r.get("run-view-id");
    expect(binder.textContent).toBe("run-e2e-1");
    expect(binder.textContent!.trim()).toBe("run-e2e-1");
    expect(r.query("canvas-profile-card")).toBeNull();
    r.unmount();
  });

  it("run-view-id is absent when no run is in view", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch([]) });
    const r = render(<Canvas client={client} onStartIntake={NOOP} onEditProfile={NOOP} />);
    await flush();
    expect(r.query("run-view-id")).toBeNull();
    r.unmount();
  });

  it("the strip renders location + preference chips + Edit/Remove, no identity row or hard-delete foot", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch([ACTIVE]) });
    const r = render(<Canvas client={client} onStartIntake={NOOP} onEditProfile={NOOP} />);
    await flush();
    const card = r.get("canvas-profile-card");
    expect(r.get("canvas-vehicle").textContent).toContain("Hyundai Tucson Hybrid");
    expect(card.textContent).toContain("Irvine, CA");
    expect(r.get("profile-pref-radius").textContent).toBe("25 mi radius");
    expect(card.textContent).toContain("internal-only");
    expect(r.get("profile-edit-open")).toBeTruthy();
    expect(r.get("profile-remove-open")).toBeTruthy();
    expect(r.query("profile-identity-frozen")).toBeNull();
    expect(r.query("profile-hard-delete-open")).toBeNull();
    r.unmount();
  });
});
