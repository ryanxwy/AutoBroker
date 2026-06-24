/**
 * prng.test.ts — deterministic seeded PRNG (mulberry32). TDD.
 *
 * Invariants: same seed → identical sequences; different seeds → different;
 * shuffle is a permutation; bool/int boundaries; pick edge cases.
 *
 * Pure module — no DB, no framework.
 */

import { describe, expect, it } from "vitest";

import { makePrng } from "./prng.js";

describe("prng — same seed → identical sequences", () => {
  it("next() reproduces identically from the same seed", () => {
    const a = makePrng(42);
    const b = makePrng(42);
    for (let i = 0; i < 20; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it("int() reproduces identically from the same seed", () => {
    const a = makePrng(7);
    const b = makePrng(7);
    for (let i = 0; i < 20; i++) {
      expect(a.int(100)).toBe(b.int(100));
    }
  });

  it("pick() reproduces identically from the same seed", () => {
    const arr = ["x", "y", "z", "w"] as const;
    const a = makePrng(99);
    const b = makePrng(99);
    for (let i = 0; i < 10; i++) {
      expect(a.pick(arr)).toBe(b.pick(arr));
    }
  });

  it("shuffle() reproduces identically from the same seed", () => {
    const arr = [1, 2, 3, 4, 5] as const;
    const a = makePrng(13);
    const b = makePrng(13);
    expect(a.shuffle(arr)).toEqual(b.shuffle(arr));
  });

  it("advancing one generator does NOT affect an independent one from the same seed", () => {
    const a = makePrng(1);
    const b = makePrng(1);
    // Advance a by 5 steps, b untouched
    for (let i = 0; i < 5; i++) a.next();
    // b's first value is still the same as a's first (b is fresh)
    const bFirst = b.next();
    const fresh = makePrng(1);
    expect(bFirst).toBe(fresh.next());
  });
});

describe("prng — different seeds → different sequences", () => {
  it("seeds 42 and 43 produce different first values", () => {
    const a = makePrng(42);
    const b = makePrng(43);
    // Very unlikely both produce same sequence for 10 draws
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });
});

describe("prng.next()", () => {
  it("values are in [0, 1)", () => {
    const p = makePrng(17);
    for (let i = 0; i < 1000; i++) {
      const v = p.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("prng.int()", () => {
  it("values are in [0, n) for various n", () => {
    const p = makePrng(5);
    for (let i = 0; i < 500; i++) {
      const v = p.int(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it("int(1) always returns 0", () => {
    const p = makePrng(3);
    for (let i = 0; i < 20; i++) {
      expect(p.int(1)).toBe(0);
    }
  });
});

describe("prng.bool()", () => {
  it("bool(0) always returns false", () => {
    const p = makePrng(1);
    for (let i = 0; i < 50; i++) {
      expect(p.bool(0)).toBe(false);
    }
  });

  it("bool(1) always returns true", () => {
    const p = makePrng(2);
    for (let i = 0; i < 50; i++) {
      expect(p.bool(1)).toBe(true);
    }
  });

  it("bool(0.5) is approximately half (deterministic count with seed 77)", () => {
    const p = makePrng(77);
    const n = 1000;
    let trues = 0;
    for (let i = 0; i < n; i++) {
      if (p.bool(0.5)) trues++;
    }
    // Deterministic with seed 77; loose bound: between 400 and 600
    expect(trues).toBeGreaterThan(400);
    expect(trues).toBeLessThan(600);
  });

  it("bool(-1) always returns false (p<=0)", () => {
    const p = makePrng(4);
    for (let i = 0; i < 20; i++) {
      expect(p.bool(-1)).toBe(false);
    }
  });

  it("bool(2) always returns true (p>=1)", () => {
    const p = makePrng(4);
    for (let i = 0; i < 20; i++) {
      expect(p.bool(2)).toBe(true);
    }
  });
});

describe("prng.pick()", () => {
  it("pick on single-element array always returns that element", () => {
    const p = makePrng(1);
    for (let i = 0; i < 20; i++) {
      expect(p.pick(["only"])).toBe("only");
    }
  });

  it("pick on empty array throws", () => {
    const p = makePrng(1);
    expect(() => p.pick([])).toThrow();
  });

  it("pick values are always within the array", () => {
    const arr = ["a", "b", "c", "d"] as const;
    const p = makePrng(9);
    for (let i = 0; i < 50; i++) {
      expect(arr).toContain(p.pick(arr));
    }
  });
});

describe("prng.shuffle()", () => {
  it("shuffle of empty array returns empty array", () => {
    const p = makePrng(1);
    expect(p.shuffle([])).toEqual([]);
  });

  it("shuffle returns a new array (not mutating input)", () => {
    const input = [1, 2, 3, 4, 5] as const;
    const p = makePrng(1);
    const result = p.shuffle(input);
    // Original is unchanged (readonly, but the ref should differ)
    expect(result).not.toBe(input);
  });

  it("shuffle is a permutation — same multiset, possibly different order", () => {
    const input = [1, 2, 3, 4, 5, 6] as const;
    const p = makePrng(100);
    const result = p.shuffle(input);
    expect([...result].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("shuffle does not always return the same order (with a long enough array)", () => {
    // With a 6-element array, a trivially ordered result would be suspicious
    const input = [1, 2, 3, 4, 5, 6] as const;
    const p = makePrng(8);
    // Run 10 shuffles; at least one must differ from the sorted order
    const results = Array.from({ length: 10 }, () => p.shuffle(input));
    const allSorted = results.every((r) => JSON.stringify(r) === JSON.stringify([1, 2, 3, 4, 5, 6]));
    expect(allSorted).toBe(false);
  });
});
