// @vitest-environment happy-dom
/**
 * Portfolio board — the Phase-3 segment-grouped overview. Freezes:
 *   - one card per active search, GROUPED BY SEGMENT (Tucson + RAV4 → one
 *     "Compact SUVs" group; Accord → "Midsize sedans");
 *   - each card shows the vehicle, stage, dealer count, best-OTD, health dot;
 *   - budget NEVER renders (#9);
 *   - clicking a card drills in (onOpen with the profile id);
 *   - the empty state renders when there are no active searches.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";

import { ApiClient } from "../api/client.js";
import { resetDataRefetchForTests } from "../api/useDataChanged.js";
import { render, click } from "../test/render.js";
import { Portfolio } from "./Portfolio.js";

function card(over: Record<string, unknown>): Record<string, unknown> {
  return {
    searchProfileId: "p",
    vehicle: "2026 Honda Accord LX",
    city: "Seattle, WA",
    dealerCount: 2,
    bestOtd: 35500,
    lastActivityAt: null,
    stage: "scan",
    health: "warm",
    reasons: ["has_dealers"],
    ...over,
  };
}

function mockFetch(view: unknown): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/portfolio")) return json(view);
    return json({ error: { code: "not_found", message: "no route" } });
  }) as typeof fetch;
}

function flush(): Promise<void> {
  return act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => resetDataRefetchForTests());
beforeEach(() => window.history.pushState({}, "", "/portfolio"));

describe("Portfolio board", () => {
  it("groups different-brand competitors by segment and renders card facts (no budget)", async () => {
    const view = {
      empty: false,
      generatedAt: "2026-06-24T00:00:00Z",
      cards: [
        card({ searchProfileId: "p-tucson", vehicle: "2026 Hyundai Tucson SEL", health: "hot", stage: "negotiation", bestOtd: 31000 }),
        card({ searchProfileId: "p-rav4", vehicle: "2026 Toyota RAV4 XLE", health: "warm", stage: "scan" }),
        card({ searchProfileId: "p-accord", vehicle: "2026 Honda Accord LX", health: "cold", stage: "intake", dealerCount: 0, bestOtd: null }),
      ],
    };
    const client = new ApiClient({ fetchImpl: mockFetch(view) });
    const r = render(<Portfolio client={client} onOpen={() => {}} />);
    await flush();

    expect(r.query("portfolio-board")).not.toBeNull();
    // Tucson + RAV4 share the Compact SUVs group; Accord is its own segment.
    expect(r.query("portfolio-segment-compact-suvs")).not.toBeNull();
    expect(r.query("portfolio-segment-midsize-sedans")).not.toBeNull();
    const suvGroup = r.get("portfolio-segment-compact-suvs");
    expect(suvGroup.querySelectorAll('[data-testid^="portfolio-card-"]').length).toBe(2);

    // Health dot carries the level; stage + OTD render.
    expect(r.get("portfolio-health-p-tucson").getAttribute("data-health")).toBe("hot");
    expect(r.get("portfolio-stage-p-tucson").getAttribute("data-stage")).toBe("negotiation");
    expect(r.get("portfolio-otd-p-tucson").textContent).toContain("$31,000");

    // Budget red-line: no budget figure anywhere on the board.
    expect(r.container.textContent).not.toContain("budget");
  });

  it("drills in on card click", async () => {
    const view = {
      empty: false,
      generatedAt: "2026-06-24T00:00:00Z",
      cards: [card({ searchProfileId: "p-accord" })],
    };
    const onOpen = vi.fn();
    const client = new ApiClient({ fetchImpl: mockFetch(view) });
    const r = render(<Portfolio client={client} onOpen={onOpen} />);
    await flush();
    click(r.get("portfolio-card-p-accord"));
    expect(onOpen).toHaveBeenCalledWith("p-accord");
  });

  it("renders the empty state when there are no active searches", async () => {
    const view = { empty: true, generatedAt: "2026-06-24T00:00:00Z", cards: [] };
    const client = new ApiClient({ fetchImpl: mockFetch(view) });
    const r = render(<Portfolio client={client} onOpen={() => {}} />);
    await flush();
    expect(r.query("portfolio-empty")).not.toBeNull();
  });
});
