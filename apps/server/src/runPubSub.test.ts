/**
 * runPubSub unit tests — the per-run SSE log + fan-out invariants: init
 * driver_kind injection, replay-on-subscribe ordering, the single-terminal-frame
 * discard ("wire wins"), and unknown-kind rejection. Pure in-memory.
 */

import { describe, expect, it, vi } from "vitest";

import { RunPubSub, INIT_DRIVER_KIND, type SseEvent } from "./runPubSub.js";

/** Drain a live queue into an array until it closes. */
async function drain(queue: AsyncIterable<SseEvent>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of queue) out.push(ev);
  return out;
}

describe("runPubSub — init frame (driver_kind injection)", () => {
  it("attachInit emits init{run_id, skill, driver_kind='deepseek_apikey'} as frame 0", () => {
    const ps = new RunPubSub();
    ps.attachInit("r1", "search_profile_intake");
    const snap = ps.snapshot("r1");
    expect(snap).toHaveLength(1);
    expect(snap[0]!.kind).toBe("init");
    expect(snap[0]!.payload).toMatchObject({
      run_id: "r1",
      skill: "search_profile_intake",
      driver_kind: INIT_DRIVER_KIND,
    });
    expect(INIT_DRIVER_KIND).toBe("deepseek_apikey");
  });

  it("attachInit is idempotent (a second call does not re-emit init)", () => {
    const ps = new RunPubSub();
    ps.attachInit("r1", "search_profile_intake");
    ps.attachInit("r1", "search_profile_intake");
    expect(ps.snapshot("r1")).toHaveLength(1);
  });

  it("every frame carries an ISO ts and an object payload", () => {
    const ps = new RunPubSub();
    ps.attachInit("r1", "search_profile_intake");
    const ev = ps.snapshot("r1")[0]!;
    expect(() => new Date(ev.ts).toISOString()).not.toThrow();
    expect(typeof ev.payload).toBe("object");
  });
});

describe("runPubSub — replay-on-subscribe ordering", () => {
  it("a late subscriber gets the FULL ordered backlog then live events", async () => {
    const ps = new RunPubSub();
    ps.attachInit("r1", "search_profile_intake");
    ps.append("r1", { kind: "awaiting_user", payload: { decision_id: "d1" } });
    ps.append("r1", { kind: "text", payload: { text: "hi" } });

    // Subscribe AFTER three frames already landed.
    const sub = ps.subscribe("r1");
    expect(sub).not.toBeNull();
    expect(sub!.snapshot.map((e) => e.kind)).toEqual(["init", "awaiting_user", "text"]);
    expect(sub!.isTerminal).toBe(false);

    // A live frame after subscribe arrives on the queue, not the snapshot.
    const livePromise = drain(sub!.queue!);
    ps.append("r1", { kind: "done", payload: {} });
    const live = await livePromise;
    expect(live.map((e) => e.kind)).toEqual(["done"]);
  });

  it("subscribing AFTER terminal returns snapshot incl. terminal + null queue", () => {
    const ps = new RunPubSub();
    ps.attachInit("r1", "search_profile_intake");
    ps.append("r1", { kind: "done", payload: {} });

    const sub = ps.subscribe("r1");
    expect(sub!.isTerminal).toBe(true);
    expect(sub!.queue).toBeNull();
    expect(sub!.snapshot.map((e) => e.kind)).toEqual(["init", "done"]);
  });

  it("subscribe to an unknown run returns null (route → 404)", () => {
    const ps = new RunPubSub();
    expect(ps.subscribe("nope")).toBeNull();
  });
});

describe("runPubSub — single-terminal-frame invariant (wire wins)", () => {
  it("appends after a terminal frame are DISCARDED with a warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ps = new RunPubSub();
    ps.attachInit("r1", "search_profile_intake");
    expect(ps.append("r1", { kind: "done", payload: {} })).toBe(true);
    // A later append (even another terminal) is discarded.
    expect(ps.append("r1", { kind: "text", payload: { text: "late" } })).toBe(false);
    expect(ps.append("r1", { kind: "error", payload: {} })).toBe(false);
    expect(ps.snapshot("r1").map((e) => e.kind)).toEqual(["init", "done"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("isTerminal flips on the first terminal frame", () => {
    const ps = new RunPubSub();
    ps.attachInit("r1", "search_profile_intake");
    expect(ps.isTerminal("r1")).toBe(false);
    ps.append("r1", { kind: "aborted", payload: { reason: "user_declined" } });
    expect(ps.isTerminal("r1")).toBe(true);
  });

  it("a live subscriber's queue closes when the terminal frame lands", async () => {
    const ps = new RunPubSub();
    ps.attachInit("r1", "search_profile_intake");
    const sub = ps.subscribe("r1")!;
    const livePromise = drain(sub.queue!);
    ps.append("r1", { kind: "text", payload: { text: "x" } });
    ps.append("r1", { kind: "done", payload: {} });
    const live = await livePromise; // resolves because the queue closed.
    expect(live.map((e) => e.kind)).toEqual(["text", "done"]);
  });
});

describe("runPubSub — unknown kind rejection (no drift)", () => {
  it("append with an unknown kind throws", () => {
    const ps = new RunPubSub();
    ps.attachInit("r1", "search_profile_intake");
    expect(() => ps.append("r1", { kind: "bogus" as never, payload: {} })).toThrow(/unknown event kind/);
  });

  it("append to a run with no channel throws (attachInit first)", () => {
    const ps = new RunPubSub();
    expect(() => ps.append("ghost", { kind: "text", payload: {} })).toThrow(/no channel/);
  });
});
