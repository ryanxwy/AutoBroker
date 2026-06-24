/**
 * Serialized DB write lane — a single-slot async mutex funnelling product-DB
 * write SEQUENCES so two concurrent pipelines' async read-modify-write spans
 * can't interleave. (Single sync better-sqlite3 .run()/.transaction() calls are
 * already serialized by the event loop and atomic; this lane is for the
 * multi-step async case + the one funnel the concurrent multi-profile world
 * routes through.)
 */

import { describe, expect, it } from "vitest";

import { withWriteLane } from "./writeLane.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("withWriteLane", () => {
  it("serializes overlapping async write-sequences — no interleave", async () => {
    const events: string[] = [];
    const blockA = deferred();
    const seq = (id: string, gate: Promise<void>) =>
      withWriteLane(async () => {
        events.push(`${id}:start`);
        await gate;
        events.push(`${id}:end`);
      });

    const a = seq("A", blockA.promise);
    const b = seq("B", Promise.resolve());
    await tick();
    // A holds the lane (parked on its gate); B must NOT have started.
    expect(events).toEqual(["A:start"]);

    blockA.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });

  it("returns the fn result (sync or async)", async () => {
    expect(await withWriteLane(() => 42)).toBe(42);
    expect(await withWriteLane(async () => "x")).toBe("x");
  });

  it("a failed sequence rejects but does NOT wedge the lane", async () => {
    await expect(withWriteLane(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(withWriteLane(async () => "after")).resolves.toBe("after");
  });

  it("preserves FIFO order across many queued writes", async () => {
    const order: number[] = [];
    const ps = Array.from({ length: 5 }, (_unused, i) =>
      withWriteLane(async () => {
        await tick();
        order.push(i);
      }),
    );
    await Promise.all(ps);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
});
