// @vitest-environment happy-dom
/**
 * App.portfoliopin — verify #2 (pin focus + portfolio stays wide). At /portfolio
 * with two active searches, pinning one via the Searches picker flips THIS
 * session into focused pinned mode (rail-pin-title) while the board still lists
 * BOTH searches. Clearing the pin reverts the session.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";

import { App } from "./App.js";
import { ApiClient } from "./api/client.js";
import { resetDataRefetchForTests } from "./api/useDataChanged.js";
import { render, click } from "./test/render.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TUCSON = { search_profile_id: "p-tucson", year: 2026, make: "Hyundai", model: "Tucson Hybrid", trim: "SEL", status: "active" };
const RAV4 = { search_profile_id: "p-rav4", year: 2026, make: "Toyota", model: "RAV4", trim: "XLE", status: "active" };

function session(pin: string | null): Record<string, unknown> {
  return { id: "sess-new", title: "Pinned search", created_at: "2026-06-24T00:00:00Z", last_activity_at: "2026-06-24T00:00:00Z", pinned_profile_id: pin, scope_notice: null, last_run_id: null, archived: false };
}

function mockFetch(): typeof fetch {
  let pin: string | null = null;
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/mode")) return json({ active_db: "t.db", data_dir: "/x", demo: false, mode: "buyer" });
    if (url.endsWith("/api/settings/keys")) return json({ deepseek: { present: true }, anthropic: { present: false }, openai: { present: false }, google_places: { present: true }, claude_oauth: { present: false }, gmail: { connected: false } });
    if (url.endsWith("/api/settings/env")) return json({ vars: [] });
    if (url.endsWith("/api/skills")) return json([]);
    if (url.endsWith("/api/portfolio"))
      return json({ empty: false, generatedAt: "2026-06-24T00:00:00Z", cards: [
        { searchProfileId: "p-tucson", vehicle: "2026 Hyundai Tucson Hybrid SEL", city: "Tucson, AZ", dealerCount: 0, bestOtd: null, lastActivityAt: null, stage: "intake", health: "cold", reasons: [] },
        { searchProfileId: "p-rav4", vehicle: "2026 Toyota RAV4 XLE", city: "Tucson, AZ", dealerCount: 0, bestOtd: null, lastActivityAt: null, stage: "intake", health: "cold", reasons: [] },
      ] });
    if (url.endsWith("/api/approvals")) return json([]);
    if (url.endsWith("/api/sessions") && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { pinnedProfileId?: string | null };
      pin = body.pinnedProfileId ?? null;
      return json(session(pin), 201);
    }
    const sget = /\/api\/sessions\/([^/?]+)$/.exec(url);
    if (sget !== null && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as { pinnedProfileId?: string | null };
      if ("pinnedProfileId" in body) pin = body.pinnedProfileId ?? null;
      return json(session(pin));
    }
    if (sget !== null) return json(session(pin));
    if (url.endsWith("/api/sessions")) return json([]);
    const single = /\/api\/profiles\/([^/?]+)$/.exec(url);
    if (single !== null) return json(single[1] === "p-tucson" ? TUCSON : RAV4);
    if (url.includes("/api/profiles")) return json([TUCSON, RAV4]); // active list (newest-first)
    return json([], 200);
  }) as typeof fetch;
}

function flush(): Promise<void> {
  return act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => window.history.pushState({}, "", "/portfolio"));
afterEach(() => resetDataRefetchForTests());

describe("portfolio pin focus + stays-wide (verify #2)", () => {
  it("pinning a search focuses the session while the board still lists both; unpin reverts", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(<App client={client} />);
    await flush();

    // Board shows both; the header strip is present (2+ active).
    expect(r.all("portfolio-card-p-tucson").length + r.all("portfolio-card-p-rav4").length).toBe(2);
    expect(r.query("portfolio-status-bar")).not.toBeNull();

    // Pin Tucson via the TopBar Searches picker.
    click(r.get("topbar-searches"));
    await flush();
    click(r.get("searches-pin-p-tucson"));
    await flush();

    // THIS session is now focused on Tucson (rail shows the pinned identity)…
    expect(r.query("rail-pin-title")).not.toBeNull();
    // …and the picker row flipped to Unpin.
    expect(r.query("searches-unpin-p-tucson")).not.toBeNull();
    // …while the board still lists BOTH searches (portfolio stays wide).
    expect(r.all("portfolio-card-p-tucson").length + r.all("portfolio-card-p-rav4").length).toBe(2);

    // Clearing reverts to portfolio/multi mode.
    click(r.get("pin-chip-unpin"));
    await flush();
    expect(r.query("rail-pin-title")).toBeNull();

    r.unmount();
  });
});
