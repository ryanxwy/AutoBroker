/**
 * Unit tests — the dealer_reply_extract emit contract. Freezes the
 * structured-output-safe shape of DealerReplyExtractEmitSchema: a single flat, all-required, .strict()
 * tool schema. The LLM title-fallback field (contact_role) — these tests pin
 * that the schema accepts both a null and a value, the prompt asks for it, and
 * the strict shape stays closed.
 */

import { describe, expect, it } from "vitest";

import { DealerReplyQuoteRowSchema, reclassifyRule2Failures } from "@autobroker/core";

import {
  buildDealerReplyExtractPrompt,
  DealerReplyExtractEmitSchema,
} from "./dealerReplyExtractContracts.js";

const BASE = {
  quotes: [],
  message_intent: "stall" as const,
};

/** A fully-null extractable row at the given mode (extend with overrides). */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
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

/** A faithful $/mo-only lease emit: a Rule-2 gap (term + payment, but neither
 *  money_factor nor residual_pct) the model cannot know is refinement-invalid. */
const LEASE_GAP_ROW = row({
  financing_mode: "lease",
  lease_monthly_payment: 389,
  lease_term_months: 36,
});

describe("DealerReplyExtractEmitSchema — contact_role", () => {
  it("accepts contact_role null (no signature)", () => {
    const parsed = DealerReplyExtractEmitSchema.parse({
      ...BASE,
      contact_role: null,
    });
    expect(parsed.contact_role).toBeNull();
  });

  it("accepts a title value", () => {
    const parsed = DealerReplyExtractEmitSchema.parse({
      ...BASE,
      contact_role: "Sales Manager",
    });
    expect(parsed.contact_role).toBe("Sales Manager");
  });

  it("rejects a missing contact field (all-required)", () => {
    expect(() => DealerReplyExtractEmitSchema.parse({ ...BASE })).toThrow();
  });

  it("stays .strict() — an unknown key is rejected", () => {
    expect(() =>
      DealerReplyExtractEmitSchema.parse({
        ...BASE,
        contact_role: null,
        contact_email: "x@y.z",
      }),
    ).toThrow();
  });
});

describe("DealerReplyExtractEmitSchema — structural emit boundary (Rule2 gap)", () => {
  it("ACCEPTS a $/mo lease row missing money_factor/residual (the model-facing shape)", () => {
    const parsed = DealerReplyExtractEmitSchema.parse({
      ...BASE,
      quotes: [LEASE_GAP_ROW],
      contact_role: null,
    });
    expect(parsed.quotes).toHaveLength(1);
    expect(parsed.quotes[0]?.financing_mode).toBe("lease");
    expect(parsed.quotes[0]?.lease_monthly_payment).toBe(389);
  });

  it("the REFINED row schema still rejects the same row (Rule 2)", () => {
    expect(() => DealerReplyQuoteRowSchema.parse(LEASE_GAP_ROW)).toThrow();
  });

  it("reclassifyRule2Failures demotes the row so it passes the refined schema", () => {
    const emitted = DealerReplyExtractEmitSchema.parse({
      ...BASE,
      quotes: [LEASE_GAP_ROW],
      contact_role: null,
    });
    const demoted = reclassifyRule2Failures(emitted.quotes[0]!);
    const parsed = DealerReplyQuoteRowSchema.parse(demoted);
    expect(parsed.financing_mode).toBe("unspecified");
    expect(parsed.lease_monthly_payment).toBeNull();
    expect(parsed.lease_term_months).toBeNull();
  });

  it("a Rule 1 cross-mode bleed still fails at the refined belt after reclass", () => {
    // cash carrying a finance field is a genuine model error — reclass does NOT
    // rescue it, and the refined schema rejects it.
    const bleed = row({ financing_mode: "cash", finance_apr: 4.9 });
    const demoted = reclassifyRule2Failures(
      bleed as Parameters<typeof reclassifyRule2Failures>[0],
    );
    expect(() => DealerReplyQuoteRowSchema.parse(demoted)).toThrow();
  });
});

describe("buildDealerReplyExtractPrompt — title-fallback instruction", () => {
  it("asks for the signature job title and keeps the emit_result discipline", () => {
    const prompt = buildDealerReplyExtractPrompt("Here is your quote.", "");
    expect(prompt).toContain("contact_role");
    expect(prompt).toContain("Return via the emit_result tool.");
    // The replaced clause is gone.
    expect(prompt).not.toContain("Extract numeric facts only.");
  });

  it("grounds a monthly payment away from otd_total", () => {
    const prompt = buildDealerReplyExtractPrompt("$389/mo, 36 months.", "");
    expect(prompt).toContain("is NEVER otd_total");
    expect(prompt).toContain("finance_monthly_payment or lease_monthly_payment");
  });
});
