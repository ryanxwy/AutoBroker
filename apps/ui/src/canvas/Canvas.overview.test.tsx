// @vitest-environment happy-dom
/**
 * Canvas.overview — the Overview tab is the one non-duplicative surface:
 * deterministic next-actions when the digest has any, a single quiet empty
 * line otherwise. Freezes:
 *   - digest with nextActions ⇒ the list renders (canvas-next-actions) and the
 *     empty line is absent;
 *   - digest with NO nextActions ⇒ ONE quiet line (canvas-overview-empty) and
 *     no next-actions section;
 *   - the old what-happened/what's-next feed is gone on both paths (its lines
 *     restated vehicle/dealer data already in the strip/summary/tabs).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";

import { ApiClient } from "../api/client.js";
import { resetDataRefetchForTests } from "../api/useDataChanged.js";
import { render } from "../test/render.js";
import { Canvas } from "./Canvas.js";

const P1 = { search_profile_id: "p1", year: 2026, make: "Honda", model: "Accord", status: "active" };

/** A full DigestView body (the client Zod-decodes it strictly). */
function digestBody(nextActions: unknown[]): unknown {
  return {
    empty: false,
    state: "ok",
    generatedAt: "2026-07-04T08:00:00Z",
    headline: "1 active search.",
    overallBestOtd: null,
    nextActions,
    profiles: [],
  };
}

/** A mock fetch answering the routes Canvas calls: /api/profiles → [P1],
 *  /api/digest → the given body; every other sub-resource 404s harmlessly. */
function mockFetch(digest: unknown): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/api/digest")) return json(digest);
    if (/\/api\/profiles(\?|$)/.test(url)) return json([P1]);
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

describe("Canvas Overview tab — next actions vs quiet empty state", () => {
  it("renders ONE quiet empty line (and no next-actions section) when the digest has no next actions", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch(digestBody([])) });
    const r = render(<Canvas client={client} onStartIntake={NOOP} onEditProfile={NOOP} />);
    await flush();
    const empty = r.get("canvas-overview-empty");
    expect(empty.textContent).toContain("Nothing needs you right now");
    expect(r.query("canvas-next-actions")).toBeNull();
    expect(r.query("canvas-feed")).toBeNull();
    r.unmount();
  });

  it("renders the next-actions list (and no empty line) when the digest has next actions", async () => {
    const actions = [
      { kind: "needs_reply", profileId: "p1", vehicle: "2026 Honda Accord", count: 2, label: "Reply to 2 dealers" },
    ];
    const client = new ApiClient({ fetchImpl: mockFetch(digestBody(actions)) });
    const r = render(<Canvas client={client} onStartIntake={NOOP} onEditProfile={NOOP} />);
    await flush();
    const section = r.get("canvas-next-actions");
    expect(section.textContent).toContain("Reply to 2 dealers");
    expect(r.query("canvas-overview-empty")).toBeNull();
    expect(r.query("canvas-feed")).toBeNull();
    r.unmount();
  });

  it("falls back to the quiet empty line when the digest read fails", async () => {
    const failing = (async (): Promise<Response> =>
      new Response(JSON.stringify({ error: { code: "boom", message: "down" } }), { status: 500 })) as unknown;
    const client = new ApiClient({
      fetchImpl: (async (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/digest")) return (failing as () => Promise<Response>)();
        return mockFetch(digestBody([]))(input);
      }) as typeof fetch,
    });
    const r = render(<Canvas client={client} onStartIntake={NOOP} onEditProfile={NOOP} />);
    await flush();
    expect(r.query("canvas-overview-empty")).not.toBeNull();
    expect(r.query("canvas-next-actions")).toBeNull();
    r.unmount();
  });
});
