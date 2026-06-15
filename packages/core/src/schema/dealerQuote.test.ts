/**
 * DealerQuote contract — Rule 1 / Rule 2 matrix + the reclass escape hatch.
 *
 * Freezes:
 *   - Rule 1 (no cross-mode leakage): cash rejects finance/lease fields;
 *     finance rejects lease fields; lease rejects finance fields; unspecified
 *     rejects both blocks.
 *   - Rule 2 (mode-required): finance requires apr + term; lease requires term +
 *     (money_factor OR residual_pct).
 *   - reclassifyRule2Failures: a Rule-2-failing finance/lease row → unspecified
 *     with both blocks nulled, which then VALIDATES; a Rule-1 bleed is NOT
 *     reclassed (still fails).
 *   - unspecified accepts both blocks empty.
 *   - The full DealerQuoteSchema accepts a complete valid row and rejects an
 *     extra key (.strict()).
 */

import { describe, expect, it } from "vitest";

import {
  DealerQuoteSchema,
  DealerReplyQuoteRowSchema,
  reclassifyRule2Failures,
  type DealerReplyQuoteRow,
} from "./dealerQuote.js";

// ---------------------------------------------------------------------------
// builders — every field explicit-null so the .strict() shape is satisfied
// ---------------------------------------------------------------------------

/** A fully-null extractable row at the given mode (extend with overrides). */
function row(over: Partial<DealerReplyQuoteRow> = {}): DealerReplyQuoteRow {
  return {
    financing_mode: "cash",
    vin: null,
    inventory_status: null,
    source_listing_id: null,
    quote_format: null,
    intent: null,
    confidence: null,
    quote_received_at: null,
    quote_expires_at: null,
    msrp: null,
    selling_price: null,
    dealer_discount: null,
    doc_fee: null,
    dealer_fee: null,
    sales_tax: null,
    dmv_fees: null,
    title_fee: null,
    registration_fee: null,
    license_fee: null,
    otd_total: null,
    rebates_json: null,
    other_fees_json: null,
    add_ons_json: null,
    taxable_rebates_json: null,
    finance_apr: null,
    finance_term_months: null,
    finance_down_payment: null,
    finance_monthly_payment: null,
    finance_amount_financed: null,
    lease_term_months: null,
    lease_money_factor: null,
    lease_residual_pct: null,
    lease_residual_value: null,
    lease_due_at_signing: null,
    lease_monthly_payment: null,
    lease_miles_per_year: null,
    lease_acquisition_fee: null,
    lease_disposition_fee: null,
    lease_cap_cost_gross: null,
    lease_cap_cost_adjusted: null,
    lease_rent_charge: null,
    ...over,
  };
}

/** A Rule-2-complete finance row. */
function validFinance(over: Partial<DealerReplyQuoteRow> = {}): DealerReplyQuoteRow {
  return row({ financing_mode: "finance", finance_apr: 3.9, finance_term_months: 60, ...over });
}

/** A Rule-2-complete lease row (term + money_factor). */
function validLease(over: Partial<DealerReplyQuoteRow> = {}): DealerReplyQuoteRow {
  return row({ financing_mode: "lease", lease_term_months: 36, lease_money_factor: 0.0015, ...over });
}

// ---------------------------------------------------------------------------
// Rule 1 — cross-mode leakage (table-driven)
// ---------------------------------------------------------------------------

describe("Rule 1 — no cross-financing-mode field leakage", () => {
  it("cash accepts both blocks empty", () => {
    expect(DealerReplyQuoteRowSchema.safeParse(row({ financing_mode: "cash" })).success).toBe(true);
  });

  it.each([
    ["finance_apr", { finance_apr: 2.9 }],
    ["finance_term_months", { finance_term_months: 60 }],
    ["lease_term_months", { lease_term_months: 36 }],
    ["lease_monthly_payment", { lease_monthly_payment: 399 }],
  ] as const)("cash REJECTS finance/lease field %s", (_name, over) => {
    expect(DealerReplyQuoteRowSchema.safeParse(row({ financing_mode: "cash", ...over })).success).toBe(
      false,
    );
  });

  it("finance REJECTS a lease field", () => {
    const r = validFinance({ lease_term_months: 36 });
    expect(DealerReplyQuoteRowSchema.safeParse(r).success).toBe(false);
  });

  it("lease REJECTS a finance field", () => {
    const r = validLease({ finance_apr: 3.9 });
    expect(DealerReplyQuoteRowSchema.safeParse(r).success).toBe(false);
  });

  it("unspecified REJECTS either block", () => {
    expect(
      DealerReplyQuoteRowSchema.safeParse(row({ financing_mode: "unspecified", finance_apr: 3.9 }))
        .success,
    ).toBe(false);
    expect(
      DealerReplyQuoteRowSchema.safeParse(
        row({ financing_mode: "unspecified", lease_term_months: 36 }),
      ).success,
    ).toBe(false);
  });

  it("unspecified accepts both blocks empty", () => {
    expect(
      DealerReplyQuoteRowSchema.safeParse(row({ financing_mode: "unspecified" })).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — mode-required fields
// ---------------------------------------------------------------------------

describe("Rule 2 — mode-required fields", () => {
  it("finance with apr + term is valid", () => {
    expect(DealerReplyQuoteRowSchema.safeParse(validFinance()).success).toBe(true);
  });

  it.each([
    ["missing apr", { finance_apr: null, finance_term_months: 60 }],
    ["missing term", { finance_apr: 3.9, finance_term_months: null }],
    ["missing both", { finance_apr: null, finance_term_months: null }],
  ] as const)("finance is INVALID when %s", (_name, over) => {
    expect(
      DealerReplyQuoteRowSchema.safeParse(row({ financing_mode: "finance", ...over })).success,
    ).toBe(false);
  });

  it("lease with term + money_factor is valid", () => {
    expect(DealerReplyQuoteRowSchema.safeParse(validLease()).success).toBe(true);
  });

  it("lease with term + residual_pct (no money_factor) is valid", () => {
    const r = row({ financing_mode: "lease", lease_term_months: 36, lease_residual_pct: 58 });
    expect(DealerReplyQuoteRowSchema.safeParse(r).success).toBe(true);
  });

  it.each([
    ["missing term", { lease_term_months: null, lease_money_factor: 0.0015 }],
    ["term but no MF/residual", { lease_term_months: 36 }],
    ["nothing", {}],
  ] as const)("lease is INVALID when %s", (_name, over) => {
    expect(
      DealerReplyQuoteRowSchema.safeParse(row({ financing_mode: "lease", ...over })).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reclassifyRule2Failures — the escape hatch
// ---------------------------------------------------------------------------

describe("reclassifyRule2Failures", () => {
  it("a Rule-2-failing finance row → unspecified, both blocks nulled, then VALIDATES", () => {
    // finance row with partial numbers, missing apr → fails Rule 2.
    const bad = row({
      financing_mode: "finance",
      finance_term_months: 60,
      finance_down_payment: 3000,
    });
    expect(DealerReplyQuoteRowSchema.safeParse(bad).success).toBe(false);

    const fixed = reclassifyRule2Failures(bad);
    expect(fixed.financing_mode).toBe("unspecified");
    expect(fixed.finance_term_months).toBeNull();
    expect(fixed.finance_down_payment).toBeNull();
    expect(DealerReplyQuoteRowSchema.safeParse(fixed).success).toBe(true);
  });

  it("a Rule-2-failing lease row → unspecified, both blocks nulled, then VALIDATES", () => {
    const bad = row({
      financing_mode: "lease",
      lease_monthly_payment: 399,
      // missing term + MF/residual
    });
    expect(DealerReplyQuoteRowSchema.safeParse(bad).success).toBe(false);

    const fixed = reclassifyRule2Failures(bad);
    expect(fixed.financing_mode).toBe("unspecified");
    expect(fixed.lease_monthly_payment).toBeNull();
    expect(DealerReplyQuoteRowSchema.safeParse(fixed).success).toBe(true);
  });

  it("does NOT mutate the input (returns a new object)", () => {
    const bad = row({ financing_mode: "finance", finance_term_months: 60 });
    const fixed = reclassifyRule2Failures(bad);
    expect(bad.financing_mode).toBe("finance"); // untouched
    expect(bad.finance_term_months).toBe(60);
    expect(fixed).not.toBe(bad);
  });

  it("passes a Rule-2-valid finance row through unchanged", () => {
    const ok = validFinance();
    const out = reclassifyRule2Failures(ok);
    expect(out.financing_mode).toBe("finance");
    expect(out.finance_apr).toBe(3.9);
  });

  it("does NOT reclass a Rule-1 bleed (cash + finance field still fails)", () => {
    const bleed = row({ financing_mode: "cash", finance_apr: 3.9 });
    const out = reclassifyRule2Failures(bleed);
    // cash is not a Rule-2 mode, so it passes through unchanged and STILL fails.
    expect(out.financing_mode).toBe("cash");
    expect(DealerReplyQuoteRowSchema.safeParse(out).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Full persisted DealerQuoteSchema — identity + provenance + strictness
// ---------------------------------------------------------------------------

describe("DealerQuoteSchema (full persisted row)", () => {
  function fullRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      quote_id: "q-1",
      dealer_id: "d-1",
      message_id: "m-1",
      source_gmail_message_id: "g-m-1",
      search_profile_id: "p-1",
      ...row({ financing_mode: "cash", selling_price: 33995, otd_total: 38120 }),
      extractor_provider: "deepseek",
      extraction_method: "text",
      extracted_at: "2026-06-14T00:00:00.000Z",
      raw_source_blob: "Sale price 33,995. OTD 38,120.",
      ...over,
    };
  }

  it("accepts a complete valid row", () => {
    expect(DealerQuoteSchema.safeParse(fullRow()).success).toBe(true);
  });

  it("rejects an extra key (.strict())", () => {
    expect(DealerQuoteSchema.safeParse(fullRow({ hallucinated: "x" })).success).toBe(false);
  });

  it("rejects a missing identity column", () => {
    const r = fullRow();
    delete (r as Record<string, unknown>).dealer_id;
    expect(DealerQuoteSchema.safeParse(r).success).toBe(false);
  });

  it("applies Rule 1 to the full row (cash + lease field fails)", () => {
    expect(DealerQuoteSchema.safeParse(fullRow({ lease_term_months: 36 })).success).toBe(false);
  });
});
