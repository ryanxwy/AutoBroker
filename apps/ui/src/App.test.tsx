// @vitest-environment happy-dom
/**
 * App.test — the shell integration path. Drives the
 * real App with an injected ApiClient (mock fetch) + a mock EventSource so the
 * full chain runs without a network: the canvas empty state renders → "Start a
 * new search" POSTs start → the rail binds the run → the SSE awaiting_user frame
 * surfaces the intake form in the gate zone (and the empty gate-banner host
 * precedes app-main in document order). Also: launching a skill from the Skills
 * popover (open → enabled Run button → POST), and refresh recovery — mounting at
 * /runs/:id with no in-store turn re-binds + re-subscribes (server replays).
 */

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import { ApiClient } from "./api/client.js";
import { __resetRunStreamRegistryForTests } from "./api/useRunStream.js";
import { useChat } from "./store/useChat.js";
import { change, click, render } from "./test/render.js";
import type { SseEvent } from "./api/wire.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --- mock EventSource (one live instance the test drives) -----------------
class MockEventSource {
  static instances: MockEventSource[] = [];
  static readonly CLOSED = 2;
  readonly CLOSED = 2;
  url: string;
  readyState = 1;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  emit(ev: SseEvent): void {
    act(() => this.onmessage?.({ data: JSON.stringify(ev) } as MessageEvent));
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}
(globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;

function frame(kind: string, payload: Record<string, unknown>, ts: string): SseEvent {
  return { ts, kind, payload };
}

/** A mock fetch that answers the routes the App calls. `posted` captures every
 *  POST /api/skill-runs body; `profiles` seeds the active-profile list (the
 *  Home ledger pin gate reads it). */
function mockFetch(opts: { posted?: Array<Record<string, unknown>>; profiles?: unknown[] } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/mode")) return json({ active_db: "test.db", data_dir: "/tmp/x" });
    if (url.endsWith("/api/skills"))
      return json([
        { name: "search_profile_intake", version: "1", summary: "Create a search", inputs: ["freeform"], outputs: "profile", sensitive: false, retries: 1 },
        { name: "dealer_geosearch", version: "1", summary: "Find dealers", inputs: ["search_profile_id"], outputs: "dealers", sensitive: false, retries: 1 },
      ]);
    if (url.includes("/dealers")) return json([]);
    if (url.includes("/api/profiles")) return json(opts.profiles ?? []);
    if (url.endsWith("/api/skill-runs") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      opts.posted?.push(body);
      const runId = body["skill"] === "dealer_geosearch" ? "run-geo" : "run-xyz";
      return json({ run_id: runId, session_id: "sess-1", scope_notice: null }, 201);
    }
    return json({ error: { code: "not_found", message: "no route" } }, 404);
  }) as typeof fetch;
}

beforeEach(() => {
  MockEventSource.instances = [];
  __resetRunStreamRegistryForTests();
  useChat.getState().__reset();
  window.history.pushState({}, "", "/");
});
afterEach(() => {
  vi.restoreAllMocks();
});

function flush(): Promise<void> {
  return act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("App — launch → rail bind → gate render", () => {
  it("Start a new search launches intake and the SSE form surfaces in the gate zone", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(<App client={client} />);
    await flush(); // resolve mode/skills/profiles.

    // The canvas empty state renders with the start CTA, and the (empty)
    // gate-banner host precedes app-main in document order (the system-layer
    // mount position that holds banner-gate-before-prose).
    expect(r.query("canvas-start-search")).not.toBeNull();
    const banner = r.get("gate-banner");
    const main = r.get("app-main");
    expect(banner.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    click(r.get("canvas-start-search"));
    await flush(); // resolve the POST start + navigate.

    // Navigated to the run view; the rail bound the run.
    expect(window.location.pathname).toBe("/runs/run-xyz");
    const es = MockEventSource.instances[0];
    expect(es).toBeDefined();

    // Drive the awaiting_user form frame → the gate zone shows the intake form.
    es!.emit(frame("init", { run_id: "run-xyz", driver_kind: "deepseek_apikey" }, "t0"));
    es!.emit(
      frame(
        "awaiting_user",
        { decision_id: "d1", form_kind: "data_collection", step: "collect", spec_inline: { kind: "data_collection", form_kind: "intake", seed_fields: null } },
        "t1",
      ),
    );
    await flush();

    expect(r.query("turn-zone-gate")).not.toBeNull();
    expect(r.query("intake-form")).not.toBeNull();
    r.unmount();
  });
});

describe("App — non-intake slash starts THAT skill", () => {
  it("typing /dealer_geosearch in the chat rail starts dealer_geosearch, not intake", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const client = new ApiClient({ fetchImpl: mockFetch({ posted }) });
    const r = render(<App client={client} />);
    await flush();

    change(r.get("chat-input-textarea") as HTMLTextAreaElement, "/dealer_geosearch");
    click(r.get("chat-send"));
    await flush();

    expect(posted).toHaveLength(1);
    expect(posted[0]!["skill"]).toBe("dealer_geosearch");
    expect(posted[0]!["input_mode"]).toBe("slash");
    // A generic start never forks (no from_session_id — only intake forks).
    expect("from_session_id" in posted[0]!).toBe(false);
    expect(window.location.pathname).toBe("/runs/run-geo");
    r.unmount();
  });

  it("a /search_profile_intake slash still takes the intake fork path", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const client = new ApiClient({ fetchImpl: mockFetch({ posted }) });
    const r = render(<App client={client} />);
    await flush();

    change(r.get("chat-input-textarea") as HTMLTextAreaElement, "/search_profile_intake");
    click(r.get("chat-send"));
    await flush();

    expect(posted).toHaveLength(1);
    expect(posted[0]!["skill"]).toBe("search_profile_intake");
    expect(window.location.pathname).toBe("/runs/run-xyz");
    r.unmount();
  });
});

describe("App — Skills popover launches implemented non-intake skills", () => {
  it("open the popover → the enabled dealer_geosearch Run button starts a generic slash run", async () => {
    const posted: Array<Record<string, unknown>> = [];
    // One active profile so the pin-gated Run button is enabled.
    const profiles = [{ search_profile_id: "prof-1", make: "Hyundai", model: "Tucson Hybrid", year: 2026 }];
    const client = new ApiClient({ fetchImpl: mockFetch({ posted, profiles }) });
    const r = render(<App client={client} />);
    await flush();

    // The popover-open step: trigger visible → click → panel visible (the
    // popover refetches profiles+skills on every open).
    expect(r.query("skills-popover")).toBeNull();
    click(r.get("topbar-skills"));
    await flush(); // resolve the on-open refetch.
    expect(r.query("skills-popover")).not.toBeNull();

    const runBtn = r.get("ledger-run-dealer_geosearch") as HTMLButtonElement;
    expect(runBtn.disabled).toBe(false);
    click(runBtn);
    await flush();

    // The popover closed on Run, the POST fired, and the SPA navigated.
    expect(r.query("skills-popover")).toBeNull();
    expect(posted).toHaveLength(1);
    expect(posted[0]!["skill"]).toBe("dealer_geosearch");
    expect(window.location.pathname).toBe("/runs/run-geo");
    r.unmount();
  });
});

describe("App — refresh recovery", () => {
  it("mounting at /runs/:id with no in-store turn re-binds and re-subscribes", async () => {
    window.history.pushState({}, "", "/runs/run-recovered");
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(<App client={client} />);
    await flush();

    // A fresh EventSource opened for the recovered run (server replays the backlog).
    const es = MockEventSource.instances.find((e) => e.url.includes("run-recovered"));
    expect(es).toBeDefined();

    // The replayed awaiting_user re-surfaces the form (draft restore is in the form).
    es!.emit(frame("init", { driver_kind: "deepseek_apikey" }, "t0"));
    es!.emit(
      frame("awaiting_user", { decision_id: "d9", form_kind: "data_collection", step: "collect", spec_inline: { kind: "data_collection", form_kind: "intake", seed_fields: null } }, "t1"),
    );
    await flush();
    expect(r.query("intake-form")).not.toBeNull();
    r.unmount();
  });
});
