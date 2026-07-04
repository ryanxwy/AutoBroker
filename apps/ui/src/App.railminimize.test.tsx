// @vitest-environment happy-dom
/**
 * App.railminimize — the rail minimize → floating chat-head launcher. The rail
 * hides via a data attribute on .app-shell (display:none, never unmounted, so
 * the composer draft survives) and the launcher is the sole restore handle —
 * EXCEPT the two load-bearing restores: a rail-tracked pending gate auto-expands
 * the rail (a human-approval gate must never sit hidden), and every bindAck
 * launch re-expands it. Banner-tracked gates (GateBannerHost, above the split)
 * stay visible while minimized and must NOT force a restore.
 *
 * Driven through the REAL App with an injected ApiClient (mock fetch + a
 * hand-driven /stream-v2 SSE body), mirroring App.test.tsx's harness.
 */

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import { ApiClient } from "./api/client.js";
import { resetDataRefetchForTests } from "./api/useDataChanged.js";
import { render, change, click, type Rendered } from "./test/render.js";

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
}

/** The standard routes the App calls on mount + a launch (trimmed App.test.tsx twin). */
function mockFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/stream-v2")) return new MockStream(url).response;
    if (url.endsWith("/api/mode")) return json({ active_db: "t.db", data_dir: "/tmp/x", demo: false, mode: "buyer" });
    if (url.endsWith("/api/settings/keys"))
      return json({
        deepseek: { present: true },
        anthropic: { present: false },
        openai: { present: false },
        google_places: { present: true },
        claude_oauth: { present: false },
        gmail: { connected: false },
      });
    if (url.endsWith("/api/skills"))
      return json([
        { name: "search_profile_intake", version: "1", summary: "Create a search", inputs: ["freeform"], outputs: "profile", sensitive: false, profile_pin: "exempt", retries: 1 },
      ]);
    if (url.includes("/dealers")) return json([]);
    if (url.includes("/api/profiles")) return json([]);
    if (url.includes("/api/sessions/")) {
      const id = url.slice(url.lastIndexOf("/") + 1);
      return json({
        id,
        title: null,
        created_at: "2026-06-12T00:00:00Z",
        last_activity_at: "2026-06-12T00:00:00Z",
        pinned_profile_id: null,
        scope_notice: null,
        last_run_id: null,
        archived: false,
      });
    }
    if (url.endsWith("/api/sessions")) return json([]);
    if (url.endsWith("/api/skill-runs") && init?.method === "POST")
      return json({ run_id: "run-xyz", session_id: "sess-1", scope_notice: null }, 201);
    return json({ error: { code: "not_found", message: "no route" } }, 404);
  }) as typeof fetch;
}

beforeEach(() => {
  MockStream.instances = [];
  window.history.pushState({}, "", "/");
});
afterEach(() => {
  resetDataRefetchForTests();
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

/** The .app-shell root — the data-rail-minimized host (no testid; class query). */
function shell(r: Rendered): HTMLElement {
  const node = r.container.querySelector(".app-shell");
  if (node === null) throw new Error("no .app-shell");
  return node as HTMLElement;
}

/** A rail-tracked pending gate (data_collection → gateTrack "rail"). */
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

/** A banner-tracked pending gate (approval → GateBannerHost, above the split). */
const APPROVAL_GATE = {
  type: "data-gate",
  id: "d2",
  data: {
    decision_id: "d2",
    form_kind: "approval",
    step: "confirm",
    spec_inline: { kind: "approval", summary: "Send the lead to the dealer?", sensitive: true },
  },
};

describe("App — rail minimize → floating launcher", () => {
  it("minimize marks the shell, mounts the launcher, and keeps the rail MOUNTED", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(<App client={client} />);
    await flush();

    // Default: expanded, no launcher (fresh contexts never minimize).
    expect(shell(r).hasAttribute("data-rail-minimized")).toBe(false);
    expect(r.query("chat-launcher")).toBeNull();

    click(r.get("rail-minimize"));
    expect(shell(r).hasAttribute("data-rail-minimized")).toBe(true);
    expect(r.query("chat-launcher")).not.toBeNull();
    // Hide-not-unmount: the rail element is still in the DOM (CSS display:none
    // does the hiding — jsdom can't compute layout, the attribute is the contract).
    expect(r.query("chat-rail")).not.toBeNull();
    r.unmount();
  });

  it("clicking the launcher restores the rail and unmounts the launcher", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(<App client={client} />);
    await flush();

    click(r.get("rail-minimize"));
    expect(shell(r).hasAttribute("data-rail-minimized")).toBe(true);

    click(r.get("chat-launcher"));
    expect(shell(r).hasAttribute("data-rail-minimized")).toBe(false);
    expect(r.query("chat-launcher")).toBeNull();
    r.unmount();
  });

  it("the composer draft survives a minimize → restore round-trip (never unmounted)", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(<App client={client} />);
    await flush();

    change(r.get("chat-input-textarea") as HTMLTextAreaElement, "half-typed draft");
    click(r.get("rail-minimize"));
    click(r.get("chat-launcher"));
    expect((r.get("chat-input-textarea") as HTMLTextAreaElement).value).toBe("half-typed draft");
    r.unmount();
  });

  it("a rail-tracked pending gate AUTO-RESTORES a minimized rail (never hidden)", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(<App client={client} />);
    await flush();

    click(r.get("canvas-start-search"));
    await flush();
    const stream = MockStream.instances[0]!;
    stream.emit({ type: "start", messageId: "run-xyz" });
    await flush();

    click(r.get("rail-minimize"));
    expect(shell(r).hasAttribute("data-rail-minimized")).toBe(true);

    stream.emit(COLLECT_GATE);
    await flush();
    expect(shell(r).hasAttribute("data-rail-minimized")).toBe(false);
    expect(r.query("chat-launcher")).toBeNull();
    // The gate form is present in the restored rail.
    expect(r.query("intake-form")).not.toBeNull();
    r.unmount();
  });

  it("a banner-tracked 'approval' gate does NOT restore (its banner stays visible)", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(<App client={client} />);
    await flush();

    click(r.get("canvas-start-search"));
    await flush();
    const stream = MockStream.instances[0]!;
    stream.emit({ type: "start", messageId: "run-xyz" });
    await flush();

    click(r.get("rail-minimize"));
    stream.emit(APPROVAL_GATE);
    await flush();

    // Still minimized — the approval card renders in the GateBannerHost above
    // the workbench/rail split, which a minimized rail never hides.
    expect(shell(r).hasAttribute("data-rail-minimized")).toBe(true);
    expect(r.query("chat-launcher")).not.toBeNull();
    expect(r.query("approval-prompt")).not.toBeNull();
    r.unmount();
  });

  it("a launch (bindAck) restores a minimized rail so its run streams in view", async () => {
    const client = new ApiClient({ fetchImpl: mockFetch() });
    const r = render(<App client={client} />);
    await flush();

    click(r.get("rail-minimize"));
    expect(shell(r).hasAttribute("data-rail-minimized")).toBe(true);

    // The canvas start CTA lives in app-main (visible while minimized); its
    // launch funnels through bindAck like every launch surface.
    click(r.get("canvas-start-search"));
    await flush();
    expect(shell(r).hasAttribute("data-rail-minimized")).toBe(false);
    expect(r.query("chat-launcher")).toBeNull();
    r.unmount();
  });
});
