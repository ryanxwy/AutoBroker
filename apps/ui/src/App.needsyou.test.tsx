// @vitest-environment happy-dom
/**
 * App.needsyou — the Phase-3 cross-pipeline gate routing (verify #3). A gate
 * parked in profile C must surface in the GLOBAL "Needs you" widget WHILE the
 * user is focused on another pipeline (B / home), and reviewing it must route to
 * C's run (navigate /runs/:runId) — not B's. The actual approval then happens at
 * C's per-run GateBannerHost (existing, unchanged), so the decision routes to
 * C's (runId, decisionId).
 *
 * Driven through the REAL App with an injected ApiClient (mock fetch). The
 * approval-inbox returns C's parked gate; the focused route is home (B).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";

import { App } from "./App.js";
import { ApiClient } from "./api/client.js";
import { resetDataRefetchForTests } from "./api/useDataChanged.js";
import { render, click } from "./test/render.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class MockStream {
  readonly response: Response;
  constructor() {
    const body = new ReadableStream<Uint8Array>({ start: () => {} });
    this.response = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
    });
  }
}

const PROFILE_B = { search_profile_id: "p-b", year: 2026, make: "Honda", model: "Accord", status: "active" };
const PROFILE_C = { search_profile_id: "p-c", year: 2026, make: "Toyota", model: "Camry", status: "active" };

function mockFetch(): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/stream-v2")) return new MockStream().response;
    if (url.endsWith("/api/mode")) return json({ active_db: "t.db", data_dir: "/x", demo: false, mode: "buyer" });
    if (url.endsWith("/api/settings/keys"))
      return json({ deepseek: { present: true }, anthropic: { present: false }, openai: { present: false }, google_places: { present: true }, gmail: { connected: false } });
    if (url.endsWith("/api/settings/env")) return json({ vars: [] });
    if (url.endsWith("/api/skills")) return json([]);
    if (url.endsWith("/api/portfolio"))
      return json({
        empty: false,
        generatedAt: "2026-06-24T00:00:00Z",
        cards: [
          { searchProfileId: "p-b", vehicle: "2026 Honda Accord LX", city: "Seattle, WA", dealerCount: 1, bestOtd: null, lastActivityAt: null, stage: "scan", health: "warm", reasons: [] },
          { searchProfileId: "p-c", vehicle: "2026 Toyota Camry SE", city: "Irvine, CA", dealerCount: 2, bestOtd: 31000, lastActivityAt: null, stage: "negotiation", health: "hot", reasons: [] },
        ],
      });
    if (url.endsWith("/api/approvals"))
      return json([
        {
          kind: "gate",
          profileId: "p-c",
          runId: "run-c",
          decisionId: "dec-c",
          skill: "dealer_web_lead_submit",
          reason: "lead_submit",
          actionRequired: true,
          summary: { heading: "2026 Toyota Camry SE", lines: [] },
        },
      ]);
    if (url.endsWith("/api/profiles") || url.includes("/api/profiles?")) return json([PROFILE_C, PROFILE_B]);
    const single = /\/api\/profiles\/([^/?]+)$/.exec(url);
    if (single !== null) return json(single[1] === "p-c" ? PROFILE_C : PROFILE_B);
    if (url.includes("/api/sessions")) return json([]);
    const status = /\/api\/skill-runs\/([^/?]+)$/.exec(url);
    if (status !== null) return json({ run_id: status[1], skill: "dealer_web_lead_submit", status: "awaiting_approval", pending: { step: "batchReview", decision_id: "dec-c" }, events: [] });
    return json({ error: { code: "not_found", message: "no route" } }, 404);
  }) as typeof fetch;
}

function flush(): Promise<void> {
  return act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => window.history.pushState({}, "", "/"));
afterEach(() => resetDataRefetchForTests());

describe("Needs-you cross-pipeline gate routing (verify #3)", () => {
  it("a gate parked in C surfaces while focused on B (home) and reviewing routes to C's run", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(<App client={client} />);
    await flush();

    // The global widget surfaces C's parked gate even though we're focused on
    // home (B) — and it NAMES C's vehicle.
    expect(r.query("needs-you-widget")).not.toBeNull();
    const item = r.get("needs-you-item-run-c");
    expect(item.textContent).toContain("Camry");

    // Reviewing routes to C's run only.
    expect(window.location.pathname).toBe("/");
    click(item);
    expect(window.location.pathname).toBe("/runs/run-c");

    r.unmount();
  });
});
