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

  it("opened without a url and action/error with a screenshot shape their payloads", () => {
    const ps = new RunPubSub();
    ps.attachInit("r2", "dealer_geosearch");
    const emitter = browserEmitterFor(ps, "r2");

    emitter.opened();
    emitter.action("navigate", "https://x.example/", "QUJD");
    emitter.error("boom", "QUJD");

    const [, opened, action, error] = ps.snapshot("r2"); // frame 0 is init
    expect(opened!.payload).toEqual({});
    expect(action!.payload).toEqual({
      type: "navigate",
      target: "https://x.example/",
      screenshot_b64: "QUJD",
    });
    expect(error!.payload).toEqual({ message: "boom", screenshot_b64: "QUJD" });
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
