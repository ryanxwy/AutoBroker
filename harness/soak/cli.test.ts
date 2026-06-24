/**
 * cli.test.ts — unit tests for the PURE soak-cli helpers (no spawn, no provider).
 *
 * Only the pure convergence helper mpNoveltySignature is unit-tested here: the
 * live `mp` drive (boots the host + spawns the dealer actor) and `mp-replay` (runs
 * the manifest) are integration / covered by freeze.test.ts respectively — per the
 * task-5 brief, do NOT unit-test the live spawn; DO unit-test the pure helper.
 */

import { describe, expect, it } from "vitest";

import { mpNoveltySignature } from "./cli.js";

describe("mpNoveltySignature — the pure until-dry convergence helper", () => {
  it("returns null for a round with no violation (not novel → counts toward dry)", () => {
    expect(mpNoveltySignature(null)).toBeNull();
  });

  it("keys the signature on the failing invariant's assertionId", () => {
    expect(mpNoveltySignature({ assertionId: "dealership_exclusivity" })).toBe(
      "mp::dealership_exclusivity",
    );
    expect(mpNoveltySignature({ assertionId: "no_cross_profile_bleed" })).toBe(
      "mp::no_cross_profile_bleed",
    );
  });

  it("two violations of the SAME invariant produce the SAME signature (already-seen → dry)", () => {
    const a = mpNoveltySignature({ assertionId: "budget_no_leak" });
    const b = mpNoveltySignature({ assertionId: "budget_no_leak" });
    expect(a).toBe(b);
  });

  it("violations of DIFFERENT invariants produce DIFFERENT signatures (novel)", () => {
    const a = mpNoveltySignature({ assertionId: "followup_cap" });
    const b = mpNoveltySignature({ assertionId: "history_id_no_skip" });
    expect(a).not.toBe(b);
  });
});
