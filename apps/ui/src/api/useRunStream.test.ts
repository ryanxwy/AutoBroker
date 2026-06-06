// @vitest-environment happy-dom
/**
 * useRunStream.test — the single SSE hook against a MOCK EventSource (no network,
 * no server). Covers the load-bearing invariants:
 *   - replay: the server re-sends the full backlog on subscribe → the hook
 *     accumulates the ordered events.
 *   - dedupe: a reconnect re-delivers already-seen frames (no seq on the wire) →
 *     content-keyed dedupe drops the duplicates.
 *   - terminal close: a done|error|aborted frame closes the EventSource and the
 *     hook reports terminal (no reconnect after).
 *   - dual-subscribe warning: a second live consumer for the same runId warns
 *     LOUD (the defect this hook exists to prevent).
 *
 * Renders the hook in a real React tree under happy-dom via a tiny renderHook
 * helper (act from react) — no @testing-library dep needed for a hook this small.
 */

import { act } from "react";
import { createElement, type FC } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetRunStreamRegistryForTests, useRunStream, type RunStreamState } from "./useRunStream.js";
import type { SseEvent } from "./wire.js";

// React 18 act() console warning suppressor flag.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A controllable mock EventSource: tests drive onmessage/onerror by hand. */
class MockEventSource {
  static instances: MockEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;

  url: string;
  readyState = MockEventSource.CONNECTING;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onopen: ((ev: Event) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    this.readyState = MockEventSource.OPEN;
    MockEventSource.instances.push(this);
  }

  /** Deliver one SSE frame (as the route serializes it: JSON in `data`). */
  emit(ev: SseEvent): void {
    this.onmessage?.({ data: JSON.stringify(ev) } as MessageEvent);
  }

  /** Simulate the browser giving up (readyState CLOSED) → hook reconnect path. */
  fail(): void {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.(new Event("error"));
  }

  close(): void {
    this.closed = true;
    this.readyState = MockEventSource.CLOSED;
  }
}

// happy-dom provides no EventSource constants; the hook reads EventSource.CLOSED.
// Point the global at our mock so `EventSource.CLOSED` resolves in onerror.
(globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;

function frame(kind: string, payload: Record<string, unknown>, ts: string): SseEvent {
  return { ts, kind, payload };
}

/** Render the hook and expose its latest value + an unmount fn. */
function renderHook(runId: string | null): { latest: () => RunStreamState; unmount: () => void } {
  let latest: RunStreamState | undefined;
  const Harness: FC = () => {
    latest = useRunStream(runId, {
      eventSourceFactory: (url) => new MockEventSource(url) as unknown as EventSource,
      reconnectDelayMs: 10,
    });
    return null;
  };
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  act(() => {
    root.render(createElement(Harness));
  });
  return {
    latest: () => latest as RunStreamState,
    unmount: () => act(() => root.unmount()),
  };
}

beforeEach(() => {
  MockEventSource.instances = [];
  __resetRunStreamRegistryForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useRunStream — replay + reducer", () => {
  it("accumulates the replayed backlog in order and projects status", () => {
    const h = renderHook("run-1");
    const es = MockEventSource.instances[0]!;

    act(() => {
      es.emit(frame("init", { run_id: "run-1", skill: "search_profile_intake", driver_kind: "deepseek_apikey" }, "t0"));
      es.emit(frame("awaiting_user", { decision_id: "d1", form_kind: "data_collection", step: "collect", spec_inline: {} }, "t1"));
    });

    const s = h.latest();
    expect(s.events.map((e) => e.kind)).toEqual(["init", "awaiting_user"]);
    expect(s.driverKind).toBe("deepseek_apikey");
    expect(s.status).toBe("awaiting_approval");
    expect(s.currentSuspend?.decisionId).toBe("d1");
    expect(s.currentSuspend?.step).toBe("collect");
    expect(s.terminal).toBe(false);
    h.unmount();
  });

  it("dedupes replayed frames on reconnect (content key, no seq on the wire)", () => {
    const h = renderHook("run-1");
    const es1 = MockEventSource.instances[0]!;
    act(() => {
      es1.emit(frame("init", { driver_kind: "deepseek_apikey" }, "t0"));
      es1.emit(frame("text", { text: "Hi" }, "t1"));
    });

    // Browser drops → hook schedules a reconnect; the new ES replays the SAME
    // backlog (server re-sends full snapshot). Dedupe must drop the repeats.
    act(() => {
      es1.fail();
      vi.advanceTimersByTime(20);
    });
    const es2 = MockEventSource.instances[1]!;
    expect(es2).toBeDefined();
    act(() => {
      es2.emit(frame("init", { driver_kind: "deepseek_apikey" }, "t0"));
      es2.emit(frame("text", { text: "Hi" }, "t1"));
      es2.emit(frame("text", { text: " there" }, "t2")); // a genuinely new frame
    });

    const s = h.latest();
    // Only 3 distinct frames despite the duplicate replay of t0/t1.
    expect(s.events.map((e) => e.ts)).toEqual(["t0", "t1", "t2"]);
    h.unmount();
  });

  it("a terminal done frame closes the EventSource and reports terminal", () => {
    const h = renderHook("run-1");
    const es = MockEventSource.instances[0]!;
    act(() => {
      es.emit(frame("init", { driver_kind: "deepseek_apikey" }, "t0"));
      es.emit(frame("text", { text: "Created." }, "t1"));
      es.emit(frame("done", {}, "t2"));
    });

    const s = h.latest();
    expect(s.terminal).toBe(true);
    expect(s.terminalKind).toBe("done");
    expect(s.status).toBe("done");
    expect(es.closed).toBe(true);

    // After terminal, an onerror must NOT spawn a reconnect.
    act(() => {
      es.fail();
      vi.advanceTimersByTime(50);
    });
    expect(MockEventSource.instances).toHaveLength(1);
    h.unmount();
  });

  it("an aborted{reason:user_declined} frame projects status declined", () => {
    const h = renderHook("run-1");
    const es = MockEventSource.instances[0]!;
    act(() => {
      es.emit(frame("init", {}, "t0"));
      es.emit(frame("aborted", { reason: "user_declined" }, "t1"));
    });
    const s = h.latest();
    expect(s.terminal).toBe(true);
    expect(s.terminalKind).toBe("aborted");
    expect(s.status).toBe("declined");
    h.unmount();
  });

  it("an error frame surfaces the reason and projects status error", () => {
    const h = renderHook("run-1");
    const es = MockEventSource.instances[0]!;
    act(() => {
      es.emit(frame("init", {}, "t0"));
      es.emit(frame("error", { reason: "workflow_failed" }, "t1"));
    });
    const s = h.latest();
    expect(s.status).toBe("error");
    expect(s.error).toBe("workflow_failed");
    h.unmount();
  });
});

describe("useRunStream — single-consumer registry (the dual-consumer defect)", () => {
  it("warns LOUD when a second consumer mounts for the same runId", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = renderHook("run-1");
    // A second live consumer for the SAME run — the defect this hook prevents.
    const b = renderHook("run-1");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("second consumer");
    expect(warn.mock.calls[0]![0]).toContain("run-1");

    a.unmount();
    b.unmount();
    warn.mockRestore();
  });

  it("does NOT warn for a single consumer, and frees the slot on unmount", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = renderHook("run-1");
    a.unmount();
    // After unmount the slot is free → a fresh consumer must not warn.
    const b = renderHook("run-1");
    expect(warn).not.toHaveBeenCalled();
    b.unmount();
    warn.mockRestore();
  });
});
