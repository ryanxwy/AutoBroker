// @vitest-environment happy-dom
/**
 * App.test — the shell integration path. Drives the
 * real App with an injected ApiClient (mock fetch, including a hand-driven
 * /stream-v2 SSE body) so the full chain runs without a network: the canvas
 * empty state renders → "Start a new search" POSTs start → the single
 * App-level useChat opens the run's stream → the data-gate chunk surfaces the
 * intake form in the gate zone (and the empty gate-banner host precedes
 * app-main in document order). Also: launching a skill from the Skills popover
 * (open → enabled Run button → POST), and refresh recovery — mounting at
 * /runs/:id with no in-chat message reconnects (server replays).
 */

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import { ApiClient } from "./api/client.js";
import { render, change, click } from "./test/render.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --- mock /stream-v2 (one live SSE body per subscribed run) ----------------
class MockStream {
  static instances: MockStream[] = [];
  readonly url: string;
  readonly response: Response;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private readonly encoder = new TextEncoder();

  constructor(url: string) {
    this.url = url;
    const body = new ReadableStream<Uint8Array>({
      start: (c): void => {
        this.controller = c;
      },
    });
    this.response = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
    });
    MockStream.instances.push(this);
  }

  emit(chunk: Record<string, unknown>): void {
    this.controller.enqueue(this.encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  }

  end(): void {
    this.controller.enqueue(this.encoder.encode("data: [DONE]\n\n"));
    this.controller.close();
  }
}

/** A mock fetch that answers the routes the App calls. `posted` captures every
 *  POST /api/skill-runs body; `profiles` seeds the active-profile list (the
 *  Skills-popover pin gate reads it). */
function mockFetch(opts: { posted?: Array<Record<string, unknown>>; profiles?: unknown[] } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/stream-v2")) return new MockStream(url).response;
    if (url.endsWith("/api/mode")) return json({ active_db: "test.db", data_dir: "/tmp/x" });
    if (url.endsWith("/api/skills"))
      return json([
        { name: "search_profile_intake", version: "1", summary: "Create a search", inputs: ["freeform"], outputs: "profile", sensitive: false, retries: 1 },
        { name: "dealer_geosearch", version: "1", summary: "Find dealers", inputs: ["search_profile_id"], outputs: "dealers", sensitive: false, retries: 1 },
      ]);
    if (url.includes("/dealers")) return json([]);
    if (url.includes("/api/profiles")) return json(opts.profiles ?? []);
    if (url.includes("/api/sessions/")) {
      const id = url.slice(url.lastIndexOf("/") + 1);
      return json({
        id,
        title: null,
        created_at: "2026-06-12T00:00:00Z",
        last_activity_at: "2026-06-12T00:00:00Z",
        pinned_profile_id: null,
        scope_notice: null,
        archived: false,
      });
    }
    if (url.endsWith("/api/sessions")) return json([]);
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
  MockStream.instances = [];
  window.history.pushState({}, "", "/");
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Flush microtasks AND the stream read loop (macrotask turns). */
function flush(): Promise<void> {
  return act(async () => {
    for (let i = 0; i < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
  });
}

const COLLECT_GATE = {
  type: "data-gate",
  id: "d1",
  data: {
    decision_id: "d1",
    form_kind: "data_collection",
    step: "collect",
    spec_inline: { kind: "data_collection", form_kind: "intake", seed_fields: null },
  },
};

describe("App — launch → rail bind → gate render", () => {
  it("Start a new search launches intake and the streamed gate surfaces in the gate zone", async () => {
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
    await flush(); // resolve the POST start + open the stream + navigate.

    // Navigated to the run view; the single chat opened the run's stream.
    expect(window.location.pathname).toBe("/runs/run-xyz");
    const stream = MockStream.instances[0];
    expect(stream).toBeDefined();
    expect(stream!.url).toContain("/api/skill-runs/run-xyz/stream-v2");

    // Drive the protocol chunks → the gate zone shows the intake form.
    stream!.emit({ type: "start", messageId: "run-xyz" });
    stream!.emit({
      type: "data-frame",
      id: "frame-0",
      data: { kind: "init", payload: { run_id: "run-xyz", driver_kind: "deepseek_apikey" } },
    });
    stream!.emit(COLLECT_GATE);
    await flush();

    expect(r.query("turn-zone-gate")).not.toBeNull();
    expect(r.query("intake-form")).not.toBeNull();
    // The turn carries the projected awaiting status (the stable DOM contract).
    expect(r.get("assistant-turn").getAttribute("data-status")).toBe("awaiting_approval");
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
    // The typed slash renders as the user turn in the rail.
    expect(r.get("user-turn").textContent).toBe("/dealer_geosearch");
    r.unmount();
  });

  it("slash key=value args spread into the start body (parsed args reach the POST)", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const client = new ApiClient({ fetchImpl: mockFetch({ posted }) });
    const r = render(<App client={client} />);
    await flush();

    change(r.get("chat-input-textarea") as HTMLTextAreaElement, "/dealer_geosearch search_profile_id=prof-7");
    click(r.get("chat-send"));
    await flush();

    expect(posted).toHaveLength(1);
    expect(posted[0]!["skill"]).toBe("dealer_geosearch");
    expect(posted[0]!["search_profile_id"]).toBe("prof-7");
    r.unmount();
  });

  it("an unknown slash renders an inline hint and NEVER falls through to freeform→intake", async () => {
    const posted: Array<Record<string, unknown>> = [];
    const client = new ApiClient({ fetchImpl: mockFetch({ posted }) });
    const r = render(<App client={client} />);
    await flush();

    change(r.get("chat-input-textarea") as HTMLTextAreaElement, "/definitely_not_a_skill now");
    click(r.get("chat-send"));
    await flush();

    expect(posted).toHaveLength(0); // no start fired — not intake, not anything.
    const hint = r.get("slash-unknown-hint");
    expect(hint.textContent).toContain("Unknown command /definitely_not_a_skill");
    // The text stays for correction.
    expect((r.get("chat-input-textarea") as HTMLTextAreaElement).value).toContain(
      "/definitely_not_a_skill",
    );
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
    // A button launch sends the SILENT stream carrier — no user turn renders.
    expect(r.query("user-turn")).toBeNull();
    r.unmount();
  });
});

describe("App — refresh recovery", () => {
  it("mounting at /runs/:id with no in-chat message re-binds and re-subscribes", async () => {
    window.history.pushState({}, "", "/runs/run-recovered");
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(<App client={client} />);
    await flush();

    // A fresh stream opened for the recovered run (server replays the backlog).
    const stream = MockStream.instances.find((s) => s.url.includes("run-recovered"));
    expect(stream).toBeDefined();

    // The replayed gate re-surfaces the form (draft restore is in the form).
    stream!.emit({ type: "start", messageId: "run-recovered" });
    stream!.emit({
      type: "data-frame",
      id: "frame-0",
      data: { kind: "init", payload: { driver_kind: "deepseek_apikey" } },
    });
    stream!.emit({ ...COLLECT_GATE, id: "d9", data: { ...COLLECT_GATE.data, decision_id: "d9" } });
    await flush();
    expect(r.query("intake-form")).not.toBeNull();
    r.unmount();
  });
});

describe("App — zone-4 browser trail + live screenshot (transient)", () => {
  it("transient data-browser parts render the trail/open-count/thumbnail on the active turn, all gone after terminal", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(<App client={client} />);
    await flush();

    click(r.get("canvas-start-search"));
    await flush();
    const stream = MockStream.instances[0]!;
    stream.emit({ type: "start", messageId: "run-xyz" });
    stream.emit({
      type: "data-frame",
      id: "frame-0",
      data: { kind: "init", payload: { run_id: "run-xyz", driver_kind: "deepseek_apikey" } },
    });
    // Two isolated browsers open concurrently (the parallel-geosearch reality),
    // one navigate carries the live screenshot twin, one viewport errors.
    const t = (kind: string, payload: Record<string, unknown>): Record<string, unknown> => ({
      type: "data-browser",
      data: { kind, payload },
      transient: true,
    });
    stream.emit(t("browser.opened", { url: "https://www.google.com/maps/a" }));
    stream.emit(t("browser.opened", { url: "https://www.google.com/maps/b" }));
    stream.emit(t("browser.action", { type: "navigate", target: "https://www.google.com/maps/a" }));
    stream.emit(
      t("browser.action", {
        type: "navigate",
        target: "https://www.google.com/maps/a",
        screenshot_b64: "QUJD",
      }),
    );
    stream.emit(t("browser.error", { message: "viewport N timed out" }));
    await flush();

    // The trail renders on the active turn: entries + 2-browsers-open count +
    // the latest live thumbnail; the error entry is visibly distinct.
    const trail = r.get("turn-browser-trail");
    expect(trail.textContent).toContain("navigate www.google.com");
    expect(r.get("turn-browser-open-count").textContent).toContain("2 browsers active");
    const errorEntry = trail.querySelector('[data-kind="error"]');
    expect(errorEntry).not.toBeNull();
    expect(errorEntry!.className).toContain("danger-text");
    const img = r.get("turn-browser-screenshot") as HTMLImageElement;
    expect(img.src).toBe("data:image/jpeg;base64,QUJD");
    // Transient: the parts never persisted into the assistant message.
    expect(r.get("assistant-turn").getAttribute("data-status")).toBe("running");

    // Terminal → trail and thumbnail are GONE (transient semantics).
    stream.emit({ type: "data-frame", id: "frame-9", data: { kind: "done", payload: {} } });
    stream.emit({ type: "finish" });
    stream.end();
    await flush();
    expect(r.get("assistant-turn").getAttribute("data-status")).toBe("done");
    expect(r.query("turn-browser-trail")).toBeNull();
    expect(r.query("turn-browser-screenshot")).toBeNull();
    r.unmount();
  });
});

describe("App — declined terminal renders the cancelled line", () => {
  it("an aborted{user_declined} data-frame + abort chunk projects data-status declined", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(<App client={client} />);
    await flush();

    click(r.get("canvas-start-search"));
    await flush();
    const stream = MockStream.instances[0]!;
    stream.emit({ type: "start", messageId: "run-xyz" });
    stream.emit(COLLECT_GATE);
    await flush();
    expect(r.query("intake-form")).not.toBeNull();

    // The decline lands as the persisted aborted data-frame + the abort chunk.
    stream.emit({
      type: "data-frame",
      id: "frame-9",
      data: { kind: "aborted", payload: { reason: "user_declined" } },
    });
    stream.emit({ type: "abort", reason: "user_declined" });
    stream.end();
    await flush();

    expect(r.get("assistant-turn").getAttribute("data-status")).toBe("declined");
    expect(r.query("turn-declined")).not.toBeNull();
    expect(r.query("intake-form")).toBeNull();
    r.unmount();
  });
});
