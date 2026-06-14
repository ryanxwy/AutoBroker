/**
 * browserEvents unit tests — the BrowserEmitter → SSE adapter. Asserts all
 * four browser.* kinds land on the run's channel with the {ts,kind,payload}
 * envelope, pass the closed-set validation, and that the adapter is safe to
 * fire for unknown runs and after the terminal frame.
 */

import { describe, expect, it, vi } from "vitest";

import { browserEmitterFor } from "./browserEvents.js";
import { EVENT_KINDS, RunPubSub, type SseEvent } from "./runPubSub.js";

/** Drain a live queue into an array until it closes. */
async function drain(queue: AsyncIterable<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of queue) out.push(ev);
  return out;
}

describe("browserEvents — BrowserEmitter → browser.* SSE frames", () => {
  it("publishes all four kinds with {ts,kind,payload} envelopes on the run's channel", async () => {
    const ps = new RunPubSub();
    ps.attachInit("r1", "dealer_geosearch");
    const sub = ps.subscribe("r1")!;
    const livePromise = drain(sub.queue!);

    const emitter = browserEmitterFor(ps, "r1");
    emitter.opened("https://dealer.example/inventory");
    emitter.action("navigate", "https://dealer.example/inventory");
    emitter.error("navigation timeout");
    emitter.closed();
    ps.append("r1", { kind: "done", payload: {} });

    const live = await livePromise;
    expect(live.map((e) => e.kind)).toEqual([
      "browser.opened",
      "browser.action",
      "browser.error",
      "browser.closed",
      "done",
    ]);

    // Envelope shape: ISO ts, kind from the closed set, object payload.
    for (const ev of live) {
      expect(new Date(ev.ts).toISOString()).toBe(ev.ts);
      expect(EVENT_KINDS).toContain(ev.kind);
      expect(typeof ev.payload).toBe("object");
    }

    expect(live[0]!.payload).toEqual({ url: "https://dealer.example/inventory" });
    expect(live[1]!.payload).toEqual({
      type: "navigate",
      target: "https://dealer.example/inventory",
    });
    expect(live[2]!.payload).toEqual({ message: "navigation timeout" });
    expect(live[3]!.payload).toEqual({});
  });

  it("a screenshot frame reaches LIVE subscribers but NEVER the logged backlog", async () => {
    const ps = new RunPubSub();
    ps.attachInit("r2", "dealer_geosearch");
    const sub = ps.subscribe("r2")!;
    const livePromise = drain(sub.queue!);
    const emitter = browserEmitterFor(ps, "r2");

    emitter.opened();
    emitter.action("navigate", "https://x.example/", "QUJD");
    emitter.error("boom", "QUJD");
    ps.append("r2", { kind: "done", payload: {} });

    // The LOG (legacy /stream replay + /stream-v2 reconnect backlog + GET
    // events snapshot all read it) carries only the PURE payload twins — zero
    // base64 anywhere.
    const logged = ps.snapshot("r2");
    expect(logged.map((e) => e.kind)).toEqual([
      "init",
      "browser.opened",
      "browser.action",
      "browser.error",
      "done",
    ]);
    for (const ev of logged) {
      expect(JSON.stringify(ev)).not.toContain("screenshot_b64");
    }
    expect(logged[2]!.payload).toEqual({ type: "navigate", target: "https://x.example/" });
    expect(logged[3]!.payload).toEqual({ message: "boom" });

    // The LIVE queue saw the pure twin AND the screenshot-bearing transient.
    const live = await livePromise;
    expect(live.map((e) => e.kind)).toEqual([
      "browser.opened",
      "browser.action",
      "browser.action",
      "browser.error",
      "browser.error",
      "done",
    ]);
    expect(live[2]!.payload).toEqual({
      type: "navigate",
      target: "https://x.example/",
      screenshot_b64: "QUJD",
    });
    expect(live[4]!.payload).toEqual({ message: "boom", screenshot_b64: "QUJD" });
  });

  it("a screenshotless action stays a single logged frame (no transient twin)", async () => {
    const ps = new RunPubSub();
    ps.attachInit("r2b", "dealer_geosearch");
    const sub = ps.subscribe("r2b")!;
    const livePromise = drain(sub.queue!);
    const emitter = browserEmitterFor(ps, "r2b");

    emitter.action("robots_disallowed", "https://x.example/");
    ps.append("r2b", { kind: "done", payload: {} });

    expect((await livePromise).map((e) => e.kind)).toEqual(["browser.action", "done"]);
    expect(ps.snapshot("r2b").map((e) => e.kind)).toEqual(["init", "browser.action", "done"]);
  });

  it("acquireProgress appends ONE logged browser.acquire.progress frame (replayable, not a transient screenshot)", () => {
    const ps = new RunPubSub();
    ps.attachInit("racq", "dealer_geosearch");
    const emitter = browserEmitterFor(ps, "racq");

    emitter.acquireProgress!("Downloading…", 0.42);
    emitter.acquireProgress!("Installing browser…");
    ps.append("racq", { kind: "done", payload: {} });

    // Both frames are LOGGED (present in the snapshot the reconnect backlog
    // reads) — a mid-install reconnect replays the progress, unlike a screenshot
    // transient which never enters the log.
    const logged = ps.snapshot("racq");
    expect(logged.map((e) => e.kind)).toEqual([
      "init",
      "browser.acquire.progress",
      "browser.acquire.progress",
      "done",
    ]);
    // With progress → {message, progress}; without → {message} only.
    expect(logged[1]!.payload).toEqual({ message: "Downloading…", progress: 0.42 });
    expect(logged[2]!.payload).toEqual({ message: "Installing browser…" });
    for (const ev of logged) {
      expect(EVENT_KINDS).toContain(ev.kind);
    }
  });

  it("drops events for a run with no channel instead of throwing", () => {
    const ps = new RunPubSub();
    const emitter = browserEmitterFor(ps, "ghost");
    expect(() => {
      emitter.opened("https://x.example/");
      emitter.action("navigate", "https://x.example/");
      emitter.error("e");
      emitter.closed();
    }).not.toThrow();
    expect(ps.has("ghost")).toBe(false);
  });

  it("post-terminal browser events are discarded by the pubsub (wire wins)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ps = new RunPubSub();
    ps.attachInit("r3", "dealer_geosearch");
    ps.append("r3", { kind: "done", payload: {} });

    const emitter = browserEmitterFor(ps, "r3");
    emitter.closed(); // late cleanup event after the run already finished

    expect(ps.snapshot("r3").map((e) => e.kind)).toEqual(["init", "done"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
