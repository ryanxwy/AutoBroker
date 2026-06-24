/**
 * multiprofile/prng — deterministic seeded PRNG (mulberry32).
 *
 * `makePrng(seed)` is PURE: two generators from the same seed emit identical
 * sequences; advancing one does NOT affect another. Determinism is load-bearing
 * — the multi-profile run skeleton (which profiles, dealer reply ordering, chaos
 * schedule) reproducibly folds from a single numeric seed.
 *
 * Algorithm: mulberry32 — a standard tiny 32-bit hash-based PRNG with excellent
 * randomness properties and a trivially auditable, well-known implementation.
 *
 * Dependency wall: harness layer. Pure — no DB, no provider, no framework,
 * no playwright, no node builtins.
 */

export interface Prng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** true with probability p (p<=0 → never, p>=1 → always). */
  bool(p: number): boolean;
  /** Uniform element from arr (throws on empty). */
  pick<T>(arr: readonly T[]): T;
  /** New array, Fisher-Yates — same multiset, possibly different order. */
  shuffle<T>(arr: readonly T[]): T[];
}

/** Create a deterministic PRNG from a numeric seed using mulberry32. */
export function makePrng(seed: number): Prng {
  // Mutable state: this instance's current generator state.
  let state = seed >>> 0; // coerce to uint32

  function next(): number {
    // mulberry32 — public domain; see: https://github.com/bryc/code/blob/master/jshash/PRNGs.md
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    z = (z ^ (z >>> 14)) >>> 0;
    // Divide by 2^32 to get [0, 1)
    return z / 0x100000000;
  }

  function int(maxExclusive: number): number {
    return Math.floor(next() * maxExclusive);
  }

  function bool(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return next() < p;
  }

  function pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("prng.pick: cannot pick from empty array");
    return arr[int(arr.length)]!;
  }

  function shuffle<T>(arr: readonly T[]): T[] {
    const out = [...arr];
    // Fisher-Yates (Knuth) shuffle
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
    return out;
  }

  return { next, int, bool, pick, shuffle };
}
