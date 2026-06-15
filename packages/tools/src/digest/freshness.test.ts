/**
 * L1 unit tests — the freshness bucketer. Freezes the fresh ≤24h / stale ≤7d /
 * missing >7d|null contract incl. the exact window edges (inclusive on the
 * tighter bucket) and the null/future-skew cases.
 */

import { describe, expect, it } from "vitest";

import { bucketFreshness, FRESH_WINDOW_MS, STALE_WINDOW_MS } from "./freshness.js";

const NOW = 1_750_000_000_000; // a fixed epoch-ms "now"

describe("bucketFreshness", () => {
  it("null last-seen → missing (never scanned)", () => {
    expect(bucketFreshness(null, NOW)).toBe("missing");
  });

  it("just now → fresh", () => {
    expect(bucketFreshness(NOW, NOW)).toBe("fresh");
  });

  it("a future timestamp (clock skew) → fresh (age clamps at zero)", () => {
    expect(bucketFreshness(NOW + 1000, NOW)).toBe("fresh");
  });

  it("exactly 24h old → fresh (inclusive edge)", () => {
    expect(bucketFreshness(NOW - FRESH_WINDOW_MS, NOW)).toBe("fresh");
  });

  it("24h + 1ms old → stale (just past the fresh edge)", () => {
    expect(bucketFreshness(NOW - FRESH_WINDOW_MS - 1, NOW)).toBe("stale");
  });

  it("3 days old → stale", () => {
    expect(bucketFreshness(NOW - 3 * 24 * 60 * 60 * 1000, NOW)).toBe("stale");
  });

  it("exactly 7d old → stale (inclusive edge)", () => {
    expect(bucketFreshness(NOW - STALE_WINDOW_MS, NOW)).toBe("stale");
  });

  it("7d + 1ms old → missing (just past the stale edge)", () => {
    expect(bucketFreshness(NOW - STALE_WINDOW_MS - 1, NOW)).toBe("missing");
  });

  it("30 days old → missing", () => {
    expect(bucketFreshness(NOW - 30 * 24 * 60 * 60 * 1000, NOW)).toBe("missing");
  });
});
