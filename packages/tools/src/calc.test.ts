/**
 * L1 unit tests — validateOfferMath + STATE_DOC_FEE_CAP (float dollars).
 *
 * Freezes the math invariants the audit's MATH_SANITY check depends on:
 *   - computed = selling + Σfees + (tax || 0); fees accept numbers OR
 *     {amount} dicts; missing/non-numeric amounts contribute nothing;
 *   - delta is rounded to 2dp BEFORE the tolerance compare;
 *   - pass iff |delta| <= tolerance (default $1.00); == cap is PASS;
 *   - not_checked when selling OR stated is null/undefined (delta null);
 *   - the per-state cap table is the full ported set.
 */

import { describe, expect, it } from "vitest";

import { STATE_DOC_FEE_CAP, validateOfferMath } from "./calc.js";

describe("STATE_DOC_FEE_CAP", () => {
  it("carries the full ported table (capped + uncapped states)", () => {
    expect(STATE_DOC_FEE_CAP).toEqual({
      CA: 85,
      NY: 175,
      WA: 200,
      OR: null,
      TX: null,
      FL: null,
    });
  });

  it("distinguishes an uncapped state (null) from an absent state (undefined)", () => {
    expect(STATE_DOC_FEE_CAP["OR"]).toBeNull();
    expect(STATE_DOC_FEE_CAP["ZZ"]).toBeUndefined();
  });
});

describe("validateOfferMath", () => {
  it("passes when computed reconciles to stated within tolerance", () => {
    const r = validateOfferMath({
      sellingPrice: 40000,
      fees: [{ amount: 85 }],
      taxAmount: 3000,
      statedOtd: 43085,
    });
    expect(r.status).toBe("pass");
    expect(r.computedOtd).toBe(43085);
    expect(r.statedOtd).toBe(43085);
    expect(r.delta).toBe(0);
    expect(r.tolerance).toBe(1.0);
  });

  it("fails when the computed OTD diverges past tolerance", () => {
    const r = validateOfferMath({
      sellingPrice: 40000,
      fees: [{ amount: 85 }],
      taxAmount: 3000,
      statedOtd: 50000,
    });
    expect(r.status).toBe("fail");
    expect(r.computedOtd).toBe(43085);
    expect(r.delta).toBe(-6915);
  });

  it("treats a delta exactly at tolerance as a pass", () => {
    const r = validateOfferMath({
      sellingPrice: 40000,
      fees: [],
      taxAmount: 0,
      statedOtd: 39999,
    });
    expect(r.delta).toBe(1);
    expect(r.status).toBe("pass");
  });

  it("fails just past tolerance (1.01)", () => {
    const r = validateOfferMath({
      sellingPrice: 40000,
      fees: [],
      taxAmount: 0,
      statedOtd: 39998.99,
    });
    expect(r.delta).toBe(1.01);
    expect(r.status).toBe("fail");
  });

  it("returns not_checked when selling price is null", () => {
    const r = validateOfferMath({ sellingPrice: null, statedOtd: 43085 });
    expect(r.status).toBe("not_checked");
    expect(r.computedOtd).toBeNull();
    expect(r.delta).toBeNull();
    expect(r.statedOtd).toBe(43085);
  });

  it("returns not_checked when stated OTD is null", () => {
    const r = validateOfferMath({ sellingPrice: 40000, statedOtd: null });
    expect(r.status).toBe("not_checked");
    expect(r.statedOtd).toBeNull();
  });

  it("sums raw-number fees and {amount} dicts together", () => {
    const r = validateOfferMath({
      sellingPrice: 40000,
      fees: [85, { amount: 500 }, { name: "x" }, { amount: "bad" }],
      taxAmount: 3000,
      statedOtd: 43585,
    });
    expect(r.computedOtd).toBe(43585);
    expect(r.status).toBe("pass");
  });

  it("treats a null/undefined tax as zero", () => {
    const r = validateOfferMath({ sellingPrice: 40000, fees: [], statedOtd: 40000 });
    expect(r.computedOtd).toBe(40000);
    expect(r.status).toBe("pass");
  });

  it("rounds the delta to 2dp before the tolerance compare", () => {
    const r = validateOfferMath({
      sellingPrice: 100.014,
      fees: [],
      taxAmount: 0,
      statedOtd: 100,
    });
    // raw delta 0.014 → round2 → 0.01 (sub-cent rounded to penny resolution)
    expect(r.delta).toBe(0.01);
    expect(r.status).toBe("pass");
  });

  it("collapses float-noise sums to a clean penny delta", () => {
    const r = validateOfferMath({
      sellingPrice: 0.1,
      fees: [{ amount: 0.2 }],
      taxAmount: 0,
      statedOtd: 0.3,
    });
    // 0.1 + 0.2 = 0.30000000000000004 raw; round2 → delta 0
    expect(r.delta).toBe(0);
    expect(r.status).toBe("pass");
  });
});
