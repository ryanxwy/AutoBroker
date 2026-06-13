// @vitest-environment happy-dom
/**
 * ProfileEditPanel.test — the in-dashboard preference-edit panel, driven
 * against an injected ApiClient (mock fetch). Proves: the editable fields
 * render from the fetched row (budget + arrays included); MultiValueChipEditor
 * add/remove; client validation (radius outside 1–500 blocks Save); a Save
 * fires the PATCH with the JSON-serialized arrays; a 200 calls invalidate +
 * (after the fade) onSaved; a 400 maps to the named field error; the 409
 * identity guard renders the failure strip.
 */

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "../api/client.js";
import * as dataChanged from "../api/useDataChanged.js";
import { change, click, render } from "../test/render.js";
import { ProfileEditPanel } from "./ProfileEditPanel.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROFILE_ROW = {
  search_profile_id: "prof-1",
  year: 2026,
  make: "Hyundai",
  model: "Tucson Hybrid",
  trim: "SEL",
  budget_max: 38000,
  search_radius_miles: 50,
  follow_up_email: "me@example.com",
  follow_up_phone: "",
  financing_preference: "finance",
  trade_in_description: "",
  preferred_exterior_colors_json: '["white"]',
  preferred_interior_colors_json: null,
  acceptable_trims_json: null,
  feature_preferences_json: null,
};

/** A mock fetch: GET /api/profiles/:id → the row; PATCH → captured + an
 *  outcome the test selects (200 row / 400 field / 409 identity_locked). */
function mockFetch(opts: {
  patched?: Array<Record<string, unknown>>;
  patchOutcome?: "ok" | "bad_radius" | "identity_locked";
}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/api/profiles/") && (init?.method ?? "GET") === "GET") {
      return json(PROFILE_ROW);
    }
    if (url.includes("/api/profiles/") && init?.method === "PATCH") {
      opts.patched?.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (opts.patchOutcome === "bad_radius") {
        return json(
          { error: { code: "content_invalid", message: "request body invalid", field: "/searchRadiusMiles" } },
          400,
        );
      }
      if (opts.patchOutcome === "identity_locked") {
        return json(
          { error: { code: "identity_locked", message: "identity is frozen", locked_fields: ["make"] } },
          409,
        );
      }
      return json(PROFILE_ROW);
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
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ProfileEditPanel — render + edit + save", () => {
  it("renders the editable fields from the fetched row (radius + budget + an exterior color chip)", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch({}) });
    const r = render(
      <ProfileEditPanel client={client} profileId="prof-1" onSaved={() => {}} onCancel={() => {}} />,
    );
    await flush();

    const radius = r.get("profile-edit-field-radius") as HTMLInputElement;
    expect(radius.value).toBe("50");
    const budget = r.get("profile-edit-field-budget") as HTMLInputElement;
    expect(budget.value).toBe("38000");
    // The seeded exterior color round-trips from its JSON-string column.
    expect(r.get("profile-edit-colors-exterior").textContent).toContain("white");
    r.unmount();
  });

  it("MultiValueChipEditor adds a value (via +) and removes it (via the ✕ button)", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch({}) });
    const r = render(
      <ProfileEditPanel client={client} profileId="prof-1" onSaved={() => {}} onCancel={() => {}} />,
    );
    await flush();

    const input = r.get("profile-edit-trims-input") as HTMLInputElement;
    change(input, "SEL");
    click(r.get("profile-edit-trims-add"));
    expect(r.get("profile-edit-trims").textContent).toContain("SEL");

    // The remove button is a real button with the per-value testid.
    click(r.get("profile-edit-trims-remove-SEL"));
    expect(r.get("profile-edit-trims").textContent).not.toContain("SEL");
    r.unmount();
  });

  it("client validation: a radius outside 1–500 surfaces the field error and disables Save", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch({}) });
    const r = render(
      <ProfileEditPanel client={client} profileId="prof-1" onSaved={() => {}} onCancel={() => {}} />,
    );
    await flush();

    const radius = r.get("profile-edit-field-radius") as HTMLInputElement;
    change(radius, "999");
    expect(r.query("field-error-radius")).not.toBeNull();
    expect((r.get("profile-edit-save") as HTMLButtonElement).disabled).toBe(true);
    expect(radius.getAttribute("aria-invalid")).toBe("true");
    r.unmount();
  });

  it("a Save fires the PATCH with the JSON-serialized arrays, then invalidate + onSaved fire", async () => {
    const patched: Array<Record<string, unknown>> = [];
    const onSaved = vi.fn();
    const invalidateSpy = vi.spyOn(dataChanged, "invalidate");
    const client = new ApiClient({ fetchImpl: mockFetch({ patched }) });
    const r = render(
      <ProfileEditPanel client={client} profileId="prof-1" onSaved={onSaved} onCancel={() => {}} />,
    );
    await flush();

    // Add a trim so the array serialization is observable on the wire.
    change(r.get("profile-edit-trims-input") as HTMLInputElement, "Limited");
    click(r.get("profile-edit-trims-add"));

    click(r.get("profile-edit-save"));
    await flush();

    expect(patched).toHaveLength(1);
    // The four array columns are JSON STRINGS on the wire.
    expect(patched[0]!["acceptableTrimsJson"]).toBe('["Limited"]');
    expect(patched[0]!["preferredExteriorColorsJson"]).toBe('["white"]');
    // budget rides the patch (internal-only, but persisted).
    expect(patched[0]!["budgetMax"]).toBe(38000);
    // No identity field is ever sent.
    expect("make" in patched[0]!).toBe(false);
    expect("year" in patched[0]!).toBe(false);

    // The success badge shows immediately; the read-view refresh + exit are
    // deferred to the ~2s mark (so the badge is not unmounted before it paints).
    expect(r.query("profile-edit-saved")).not.toBeNull();
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();

    // At the 2s mark: the read views refresh (invalidate) AND the host exits.
    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    expect(invalidateSpy).toHaveBeenCalledWith(["profiles"]);
    expect(onSaved).toHaveBeenCalledTimes(1);
    r.unmount();
  });

  it("a server 400 content_invalid maps the JSON-pointer back to the radius field error", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch({ patchOutcome: "bad_radius" }) });
    const r = render(
      <ProfileEditPanel client={client} profileId="prof-1" onSaved={() => {}} onCancel={() => {}} />,
    );
    await flush();

    // A client-valid radius (so Save is enabled), but the server rejects it.
    change(r.get("profile-edit-field-radius") as HTMLInputElement, "42");
    click(r.get("profile-edit-save"));
    await flush();

    expect(r.query("field-error-radius")).not.toBeNull();
    r.unmount();
  });

  it("a 409 identity_locked renders the failure strip with the locked fields", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch({ patchOutcome: "identity_locked" }) });
    const r = render(
      <ProfileEditPanel client={client} profileId="prof-1" onSaved={() => {}} onCancel={() => {}} />,
    );
    await flush();

    click(r.get("profile-edit-save"));
    await flush();

    const strip = r.get("profile-edit-identity-locked");
    expect(strip.className).toContain("failure");
    expect(strip.textContent).toContain("make");
    r.unmount();
  });
});
