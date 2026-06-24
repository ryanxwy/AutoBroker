/**
 * scheduler.stub.test.ts — the Phase-2 PortfolioScheduler seam stub. TDD.
 *
 * Invariants: all-hot when under cap; first-N hot + rest deferred when over cap;
 * empty input; default maxConcurrent = all.
 *
 * Pure module — no DB, no framework.
 */

import { describe, expect, it } from "vitest";

import { createStubPortfolioScheduler } from "./scheduler.stub.js";

describe("createStubPortfolioScheduler", () => {
  it("returns a scheduler with a schedule() method", () => {
    const s = createStubPortfolioScheduler();
    expect(typeof s.schedule).toBe("function");
  });
});

describe("PortfolioScheduler.schedule() — empty input", () => {
  it("empty activeProfileIds → hot=[] deferred=[]", () => {
    const s = createStubPortfolioScheduler();
    const result = s.schedule({ activeProfileIds: [] });
    expect(result.hot).toEqual([]);
    expect(result.deferred).toEqual([]);
  });

  it("empty with maxConcurrent=0 → hot=[] deferred=[]", () => {
    const s = createStubPortfolioScheduler();
    const result = s.schedule({ activeProfileIds: [], maxConcurrent: 0 });
    expect(result.hot).toEqual([]);
    expect(result.deferred).toEqual([]);
  });
});

describe("PortfolioScheduler.schedule() — under or at cap (all hot)", () => {
  it("3 profiles with no maxConcurrent → all hot, none deferred", () => {
    const s = createStubPortfolioScheduler();
    const ids = ["p1", "p2", "p3"];
    const result = s.schedule({ activeProfileIds: ids });
    expect(result.hot).toEqual(ids);
    expect(result.deferred).toEqual([]);
  });

  it("3 profiles with maxConcurrent=3 → all hot", () => {
    const s = createStubPortfolioScheduler();
    const ids = ["p1", "p2", "p3"];
    const result = s.schedule({ activeProfileIds: ids, maxConcurrent: 3 });
    expect(result.hot).toEqual(ids);
    expect(result.deferred).toEqual([]);
  });

  it("3 profiles with maxConcurrent=5 → all hot", () => {
    const s = createStubPortfolioScheduler();
    const ids = ["p1", "p2", "p3"];
    const result = s.schedule({ activeProfileIds: ids, maxConcurrent: 5 });
    expect(result.hot).toEqual(ids);
    expect(result.deferred).toEqual([]);
  });
});

describe("PortfolioScheduler.schedule() — over cap (first-N hot)", () => {
  it("5 profiles with maxConcurrent=2 → first 2 hot, rest deferred", () => {
    const s = createStubPortfolioScheduler();
    const ids = ["p1", "p2", "p3", "p4", "p5"];
    const result = s.schedule({ activeProfileIds: ids, maxConcurrent: 2 });
    expect(result.hot).toEqual(["p1", "p2"]);
    expect(result.deferred).toEqual(["p3", "p4", "p5"]);
  });

  it("4 profiles with maxConcurrent=1 → first 1 hot, 3 deferred", () => {
    const s = createStubPortfolioScheduler();
    const ids = ["a", "b", "c", "d"];
    const result = s.schedule({ activeProfileIds: ids, maxConcurrent: 1 });
    expect(result.hot).toEqual(["a"]);
    expect(result.deferred).toEqual(["b", "c", "d"]);
  });

  it("maxConcurrent=0 → all deferred", () => {
    const s = createStubPortfolioScheduler();
    const ids = ["p1", "p2", "p3"];
    const result = s.schedule({ activeProfileIds: ids, maxConcurrent: 0 });
    expect(result.hot).toEqual([]);
    expect(result.deferred).toEqual(ids);
  });
});

describe("PortfolioScheduler.schedule() — hot+deferred union = input", () => {
  it("hot ∪ deferred == activeProfileIds for any split", () => {
    const s = createStubPortfolioScheduler();
    const ids = ["p1", "p2", "p3", "p4", "p5"];
    for (let cap = 0; cap <= 6; cap++) {
      const result = s.schedule({ activeProfileIds: ids, maxConcurrent: cap });
      expect([...result.hot, ...result.deferred]).toEqual(ids);
    }
  });
});

describe("PortfolioScheduler — multiple calls are independent", () => {
  it("calling schedule twice with same input produces same result", () => {
    const s = createStubPortfolioScheduler();
    const ids = ["p1", "p2", "p3"];
    const r1 = s.schedule({ activeProfileIds: ids, maxConcurrent: 2 });
    const r2 = s.schedule({ activeProfileIds: ids, maxConcurrent: 2 });
    expect(r1).toEqual(r2);
  });
});
