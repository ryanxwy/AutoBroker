/**
 * boot — unit coverage for the stale-run age policy (the pure decision; the
 * restart/cancel glue itself is exercised by the workflows-layer crash-resume
 * spike against a real mastra.db).
 */

import { describe, expect, it } from "vitest";

import { STALE_RESTART_MAX_AGE_MS, staleDisposition } from "./boot.js";

describe("staleDisposition — restart young, cancel old/unknown", () => {
  const NOW = 1_750_000_000_000;

  it("a run updated moments ago restarts", () => {
    expect(staleDisposition(NOW - 5_000, NOW)).toBe("restart");
  });

  it("exactly at the age limit still restarts (inclusive boundary)", () => {
    expect(staleDisposition(NOW - STALE_RESTART_MAX_AGE_MS, NOW)).toBe("restart");
  });

  it("one ms past the limit cancels", () => {
    expect(staleDisposition(NOW - STALE_RESTART_MAX_AGE_MS - 1, NOW)).toBe("cancel");
  });

  it("unknown age cancels (never auto-re-execute work of unknown staleness)", () => {
    expect(staleDisposition(undefined, NOW)).toBe("cancel");
  });
});
