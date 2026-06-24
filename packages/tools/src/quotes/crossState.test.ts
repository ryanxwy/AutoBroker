/**
 * L1 pure tests — cross-state OTD normalization + attribution. ZERO DB, zero LLM.
 *
 * Freezes the Phase-5 cross-state correctness contract:
 *   - sales/use tax follows the BUYER's home (registration) state, never the
 *     dealer's purchase state — two dealers in different states quoting the same
 *     vehicle to the same buyer compute IDENTICAL normalized tax;
 *   - an OTD is re-derived by swapping the dealer-stated tax for the home-state
 *     tax (everything else held);
 *   - an OTD delta decomposes into sale-price / doc-fee / tax / incentive / other
 *     components that sum back to the delta EXACTLY (other = reconciling residual).
 */

import { describe, expect, it } from "vitest";

import {
  STATE_SALES_TAX_RATE,
  homeStateTaxRate,
  normalizeQuoteTax,
  attributeOtdDelta,
  type OtdComponents,
} from "./crossState.js";

// --------------------------------------------------------------------------- //
// homeStateTaxRate                                                            //
// --------------------------------------------------------------------------- //

describe("homeStateTaxRate", () => {
  it("returns the table rate (case-insensitive)", () => {
    expect(homeStateTaxRate("CA")).toBe(0.0725);
    expect(homeStateTaxRate("ca")).toBe(0.0725);
    expect(homeStateTaxRate("WA")).toBe(0.065);
  });

  it("returns 0 for a no-sales-tax state (Oregon)", () => {
    expect(homeStateTaxRate("OR")).toBe(0);
  });

  it("returns null for an unknown / missing state", () => {
    expect(homeStateTaxRate("ZZ")).toBeNull();
    expect(homeStateTaxRate(null)).toBeNull();
    expect(homeStateTaxRate(undefined)).toBeNull();
    expect(homeStateTaxRate("")).toBeNull();
  });

  it("the table is non-empty and covers CA/NY/WA/OR at minimum", () => {
    for (const s of ["CA", "NY", "WA", "OR"]) {
      expect(STATE_SALES_TAX_RATE[s]).not.toBeUndefined();
    }
  });
});

// --------------------------------------------------------------------------- //
// normalizeQuoteTax — the cross-state correctness keystone                    //
// --------------------------------------------------------------------------- //

describe("normalizeQuoteTax", () => {
  it("applies the buyer's home-state rate to the selling price", () => {
    const out = normalizeQuoteTax({
      homeState: "CA",
      sellingPrice: 40000,
      statedTax: 2900,
      statedOtd: 42985,
    });
    expect(out.homeStateRate).toBe(0.0725);
    expect(out.normalizedTax).toBe(2900); // 0.0725 * 40000
    expect(out.normalizedOtd).toBe(42985); // 42985 - 2900 + 2900 (no change in-state)
  });

  it("TWO dealers in DIFFERENT states, same vehicle + same buyer → IDENTICAL tax", () => {
    // Buyer registers in CA. Dealer A sits in CA and quoted CA tax; dealer B sits
    // in OR (no sales tax) and quoted $0 tax. The buyer owes CA use tax either
    // way, so the normalized tax must be identical — the dealer's state is
    // irrelevant to the buyer's tax.
    const dealerA = normalizeQuoteTax({
      homeState: "CA",
      sellingPrice: 40000,
      statedTax: 2900, // CA dealer collected CA tax
      statedOtd: 42985,
    });
    const dealerB = normalizeQuoteTax({
      homeState: "CA",
      sellingPrice: 40000,
      statedTax: 0, // OR dealer collected no tax
      statedOtd: 40085,
    });
    expect(dealerA.normalizedTax).toBe(dealerB.normalizedTax);
    expect(dealerA.normalizedTax).toBe(2900);
    // And the OR dealer's normalized OTD picks up the CA use tax it had omitted:
    expect(dealerB.normalizedOtd).toBe(42985); // 40085 - 0 + 2900
  });

  it("a no-sales-tax home state (Oregon) yields zero normalized tax", () => {
    const out = normalizeQuoteTax({
      homeState: "OR",
      sellingPrice: 40000,
      statedTax: 2900, // even if a dealer wrongly quoted tax
      statedOtd: 42985,
    });
    expect(out.normalizedTax).toBe(0);
    expect(out.normalizedOtd).toBe(40085); // 42985 - 2900 + 0
  });

  it("unknown home state → all-null (cannot normalize)", () => {
    const out = normalizeQuoteTax({
      homeState: "ZZ",
      sellingPrice: 40000,
      statedTax: 2900,
      statedOtd: 42985,
    });
    expect(out.homeStateRate).toBeNull();
    expect(out.normalizedTax).toBeNull();
    expect(out.normalizedOtd).toBeNull();
  });

  it("missing selling price → null tax + null OTD (no taxable base)", () => {
    const out = normalizeQuoteTax({
      homeState: "CA",
      sellingPrice: null,
      statedTax: 2900,
      statedOtd: 42985,
    });
    expect(out.normalizedTax).toBeNull();
    expect(out.normalizedOtd).toBeNull();
  });

  it("missing stated tax or OTD → null normalized OTD (cannot swap the component)", () => {
    expect(
      normalizeQuoteTax({ homeState: "CA", sellingPrice: 40000, statedTax: null, statedOtd: 42985 })
        .normalizedOtd,
    ).toBeNull();
    expect(
      normalizeQuoteTax({ homeState: "CA", sellingPrice: 40000, statedTax: 2900, statedOtd: null })
        .normalizedOtd,
    ).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// attributeOtdDelta — decompose WHY two OTDs differ                           //
// --------------------------------------------------------------------------- //

const BASE: OtdComponents = {
  sellingPrice: 40000,
  docFee: 85,
  tax: 2900,
  incentives: 0,
  otd: 42985,
};

describe("attributeOtdDelta", () => {
  it("a pure sale-price win is attributed entirely to sale price", () => {
    const candidate: OtdComponents = { ...BASE, sellingPrice: 38000, otd: 40985 };
    const a = attributeOtdDelta(BASE, candidate)!;
    expect(a.otdDelta).toBe(-2000);
    expect(a.salePriceDelta).toBe(-2000);
    expect(a.docFeeDelta).toBe(0);
    expect(a.taxDelta).toBe(0);
    expect(a.incentiveDelta).toBe(0);
    expect(a.otherDelta).toBe(0);
  });

  it("a pure doc-fee win is attributed to doc fee", () => {
    const candidate: OtdComponents = { ...BASE, docFee: 600, otd: 43500 };
    const a = attributeOtdDelta(BASE, candidate)!;
    expect(a.otdDelta).toBe(515);
    expect(a.docFeeDelta).toBe(515);
    expect(a.salePriceDelta).toBe(0);
    expect(a.otherDelta).toBe(0);
  });

  it("a pure incentive win lowers OTD and is attributed to incentive (negative contribution)", () => {
    const candidate: OtdComponents = { ...BASE, incentives: 1500, otd: 41485 };
    const a = attributeOtdDelta(BASE, candidate)!;
    expect(a.otdDelta).toBe(-1500);
    expect(a.incentiveDelta).toBe(-1500); // +1500 rebate REDUCES OTD by 1500
    expect(a.salePriceDelta).toBe(0);
    expect(a.otherDelta).toBe(0);
  });

  it("components ALWAYS sum back to the OTD delta exactly (residual reconciles)", () => {
    // A messy candidate where extra dealer/other fees live only inside the OTD,
    // not in the four named components — the residual must absorb them.
    const candidate: OtdComponents = {
      sellingPrice: 37000,
      docFee: 600,
      tax: 2682.5,
      incentives: 1000,
      otd: 41000, // includes ~$1718 of unnamed fees vs the named-component sum
    };
    const a = attributeOtdDelta(BASE, candidate)!;
    const sum =
      a.salePriceDelta + a.docFeeDelta + a.taxDelta + a.incentiveDelta + a.otherDelta;
    expect(sum).toBeCloseTo(a.otdDelta, 6);
    expect(a.otherDelta).not.toBe(0); // unnamed fees landed in the residual
  });

  it("returns null when either OTD is unknown (cannot attribute)", () => {
    expect(attributeOtdDelta(BASE, { ...BASE, otd: null })).toBeNull();
    expect(attributeOtdDelta({ ...BASE, otd: null }, BASE)).toBeNull();
  });
});
