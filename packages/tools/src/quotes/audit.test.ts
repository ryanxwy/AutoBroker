/**
 * L1 unit tests — the 10-check quote audit + the severity classifier + helpers.
 *
 * Each check is exercised for fire AND no-fire; the dispatcher order is frozen;
 * the classifier buckets are pinned (block/warn/info + the aggregate tally).
 * All money is float dollars. Pure functions — no DB here.
 */

import { describe, expect, it } from "vitest";

import {
  auditQuote,
  classifyAuditSeverity,
  medianOrNone,
  normalizeAddOnCode,
  sumNamedAmounts,
  type AuditIncentive,
  type AuditProfile,
  type AuditQuote,
  type NamedAmount,
} from "./audit.js";

// --------------------------------------------------------------------------- //
// Builders                                                                    //
// --------------------------------------------------------------------------- //

function quote(overrides: Partial<AuditQuote> = {}): AuditQuote {
  return {
    selling_price: null,
    dealer_fee: null,
    doc_fee: null,
    sales_tax: null,
    dmv_fees: null,
    title_fee: null,
    registration_fee: null,
    license_fee: null,
    other_fees_json: [],
    add_ons_json: [],
    rebates_json: [],
    otd_total: null,
    confidence: null,
    extraction_method: null,
    financing_mode: "finance",
    finance_apr: null,
    lease_money_factor: null,
    ...overrides,
  };
}

function profile(overrides: Partial<AuditProfile> = {}): AuditProfile {
  return {
    state: null,
    make: null,
    model: null,
    postal_code: null,
    financing_preference: null,
    current_brand_owner: 0,
    military_first_responder: 0,
    ...overrides,
  };
}

function codes(findings: ReturnType<typeof auditQuote>): string[] {
  return findings.map((f) => f.code);
}

// --------------------------------------------------------------------------- //
// classifyAuditSeverity (surfacing authority)                                 //
// --------------------------------------------------------------------------- //

describe("classifyAuditSeverity", () => {
  it("buckets block / warn / add-on-warn / info", () => {
    expect(classifyAuditSeverity("UNSAFE_SALVAGE")).toBe("block");
    expect(classifyAuditSeverity("DOC_FEE_CAP")).toBe("warn");
    expect(classifyAuditSeverity("APR_MARKUP")).toBe("warn");
    expect(classifyAuditSeverity("ADD_ON_PROPACK")).toBe("warn");
    expect(classifyAuditSeverity("MISSING_BREAKDOWN")).toBe("info");
    expect(classifyAuditSeverity("LOW_CONFIDENCE")).toBe("info");
    expect(classifyAuditSeverity("BRAND_NEW_CODE")).toBe("info");
  });

  it("aggregates {info, warn, block} from a code list (q-safety probe shape)", () => {
    const probe = ["UNSAFE_SALVAGE", "DOC_FEE_CAP", "APR_MARKUP", "MISSING_BREAKDOWN"];
    const tally = { info: 0, warn: 0, block: 0 };
    for (const c of probe) tally[classifyAuditSeverity(c)] += 1;
    expect(tally).toEqual({ info: 1, warn: 2, block: 1 });
  });
});

// --------------------------------------------------------------------------- //
// Helpers                                                                     //
// --------------------------------------------------------------------------- //

describe("normalizeAddOnCode", () => {
  it("strips non-alphanumerics and uppercases", () => {
    expect(normalizeAddOnCode("ProtectionPlus")).toBe("ADD_ON_PROTECTIONPLUS");
    expect(normalizeAddOnCode("Pro Pack")).toBe("ADD_ON_PROPACK");
  });

  it("falls back to ADD_ON_UNNAMED when nothing alphanumeric remains", () => {
    expect(normalizeAddOnCode("---")).toBe("ADD_ON_UNNAMED");
  });
});

describe("medianOrNone", () => {
  it("returns null for empty input", () => {
    expect(medianOrNone([])).toBeNull();
  });

  it("odd length → middle", () => {
    expect(medianOrNone([3, 1, 2])).toBe(2);
  });

  it("even length → mean of the two middles (not lower-middle)", () => {
    expect(medianOrNone([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("sumNamedAmounts", () => {
  it("sums numeric amounts, skips non-dicts and non-numeric amounts", () => {
    expect(
      sumNamedAmounts([
        { amount: 100 },
        { amount: "x" },
        { name: "y" },
        5 as unknown as NamedAmount,
      ]),
    ).toBe(100);
  });

  it("empty / null → 0", () => {
    expect(sumNamedAmounts([])).toBe(0);
    expect(sumNamedAmounts(null)).toBe(0);
  });
});

// --------------------------------------------------------------------------- //
// (1) MATH_SANITY                                                             //
// --------------------------------------------------------------------------- //

describe("MATH_SANITY", () => {
  it("fires when computed OTD diverges past $1", () => {
    const q = quote({ selling_price: 40000, sales_tax: 3000, doc_fee: 85, otd_total: 50000 });
    const findings = auditQuote(q, [], [], profile());
    expect(codes(findings)).toContain("MATH_SANITY");
    expect(findings.find((f) => f.code === "MATH_SANITY")!.severity).toBe("warn");
  });

  it("does not fire when the quote reconciles", () => {
    const q = quote({ selling_price: 40000, sales_tax: 3000, doc_fee: 85, otd_total: 43085 });
    expect(codes(auditQuote(q, [], [], profile()))).not.toContain("MATH_SANITY");
  });

  it("does not fire when selling price is missing (not_checked)", () => {
    const q = quote({ selling_price: null, sales_tax: 3000, doc_fee: 85, otd_total: 50000 });
    expect(codes(auditQuote(q, [], [], profile()))).not.toContain("MATH_SANITY");
  });
});

// --------------------------------------------------------------------------- //
// (2) DOC_FEE_CAP                                                             //
// --------------------------------------------------------------------------- //

describe("DOC_FEE_CAP", () => {
  it("fires when doc fee exceeds the state cap", () => {
    const q = quote({ doc_fee: 599 });
    const findings = auditQuote(q, [], [], profile({ state: "CA" }));
    expect(codes(findings)).toContain("DOC_FEE_CAP");
  });

  it("does not fire when at/under the cap", () => {
    const q = quote({ doc_fee: 85 });
    expect(codes(auditQuote(q, [], [], profile({ state: "CA" })))).not.toContain("DOC_FEE_CAP");
  });

  it("does not fire for an uncapped state (null cap)", () => {
    const q = quote({ doc_fee: 999 });
    expect(codes(auditQuote(q, [], [], profile({ state: "TX" })))).not.toContain("DOC_FEE_CAP");
  });

  it("does not fire with no profile state", () => {
    const q = quote({ doc_fee: 999 });
    expect(codes(auditQuote(q, [], [], profile({ state: null })))).not.toContain("DOC_FEE_CAP");
  });

  it("is case-insensitive on the state key", () => {
    const q = quote({ doc_fee: 599 });
    expect(codes(auditQuote(q, [], [], profile({ state: "ca" })))).toContain("DOC_FEE_CAP");
  });
});

// --------------------------------------------------------------------------- //
// (3) APR_MARKUP                                                              //
// --------------------------------------------------------------------------- //

describe("APR_MARKUP", () => {
  const peers: AuditQuote[] = [
    quote({ financing_mode: "finance", finance_apr: 5.0 }),
    quote({ financing_mode: "finance", finance_apr: 5.0 }),
  ];

  it("fires when APR is >1.5pp above the peer median", () => {
    const q = quote({ financing_mode: "finance", finance_apr: 7.0 });
    expect(codes(auditQuote(q, peers, [], profile()))).toContain("APR_MARKUP");
  });

  it("does not fire at the threshold (median + 1.5)", () => {
    const q = quote({ financing_mode: "finance", finance_apr: 6.5 });
    expect(codes(auditQuote(q, peers, [], profile()))).not.toContain("APR_MARKUP");
  });

  it("skips silently on an empty peer set", () => {
    const q = quote({ financing_mode: "finance", finance_apr: 30 });
    expect(codes(auditQuote(q, [], [], profile()))).not.toContain("APR_MARKUP");
  });

  it("does not fire for a non-finance quote", () => {
    const q = quote({ financing_mode: "lease", finance_apr: 30 });
    expect(codes(auditQuote(q, peers, [], profile()))).not.toContain("APR_MARKUP");
  });
});

// --------------------------------------------------------------------------- //
// (4) MF_MARKUP                                                               //
// --------------------------------------------------------------------------- //

describe("MF_MARKUP", () => {
  const peers: AuditQuote[] = [
    quote({ financing_mode: "lease", lease_money_factor: 0.001 }),
    quote({ financing_mode: "lease", lease_money_factor: 0.001 }),
  ];

  it("fires when MF is more than 2x the peer median", () => {
    const q = quote({ financing_mode: "lease", lease_money_factor: 0.0025 });
    expect(codes(auditQuote(q, peers, [], profile()))).toContain("MF_MARKUP");
  });

  it("does not fire at exactly 2x", () => {
    const q = quote({ financing_mode: "lease", lease_money_factor: 0.002 });
    expect(codes(auditQuote(q, peers, [], profile()))).not.toContain("MF_MARKUP");
  });

  it("skips silently on an empty peer set", () => {
    const q = quote({ financing_mode: "lease", lease_money_factor: 0.05 });
    expect(codes(auditQuote(q, [], [], profile()))).not.toContain("MF_MARKUP");
  });
});

// --------------------------------------------------------------------------- //
// (5) DEALER_FEE_OUTLIER                                                      //
// --------------------------------------------------------------------------- //

describe("DEALER_FEE_OUTLIER", () => {
  const peers: AuditQuote[] = [
    quote({ dealer_fee: 200, other_fees_json: [] }),
    quote({ dealer_fee: 200, other_fees_json: [] }),
  ];

  it("fires when dealer+other fees exceed 2x the peer median", () => {
    const q = quote({ dealer_fee: 500, other_fees_json: [] });
    expect(codes(auditQuote(q, peers, [], profile()))).toContain("DEALER_FEE_OUTLIER");
  });

  it("does not fire at exactly 2x", () => {
    const q = quote({ dealer_fee: 400, other_fees_json: [] });
    expect(codes(auditQuote(q, peers, [], profile()))).not.toContain("DEALER_FEE_OUTLIER");
  });

  it("skips when the quote has neither dealer_fee nor other fees", () => {
    const q = quote({ dealer_fee: null, other_fees_json: [] });
    expect(codes(auditQuote(q, peers, [], profile()))).not.toContain("DEALER_FEE_OUTLIER");
  });

  it("skips silently on an empty peer set", () => {
    const q = quote({ dealer_fee: 5000, other_fees_json: [] });
    expect(codes(auditQuote(q, [], [], profile()))).not.toContain("DEALER_FEE_OUTLIER");
  });
});

// --------------------------------------------------------------------------- //
// (6) MISSING_REBATE (Probe-6)                                                //
// --------------------------------------------------------------------------- //

describe("MISSING_REBATE", () => {
  const prof = profile({ make: "Hyundai", model: "Tucson", postal_code: "92614" });

  function inc(overrides: Partial<AuditIncentive> = {}): AuditIncentive {
    return { make: "Hyundai", eligibility: "all", type: "customer_cash", amount: 1500, ...overrides };
  }

  it("fires for an eligible, unapplied incentive matching the brand", () => {
    const q = quote({ rebates_json: [] });
    const findings = auditQuote(q, [], [inc()], prof);
    expect(codes(findings)).toContain("MISSING_REBATE");
  });

  it("does not fire when the rebate is already applied (substring match on type/name)", () => {
    const q = quote({ rebates_json: [{ type: "customer_cash rebate", amount: 1500 }] });
    expect(codes(auditQuote(q, [], [inc()], prof))).not.toContain("MISSING_REBATE");
  });

  it("does not fire for a different brand", () => {
    const q = quote({ rebates_json: [] });
    expect(codes(auditQuote(q, [], [inc({ make: "Toyota" })], prof))).not.toContain("MISSING_REBATE");
  });

  it("does not fire for an eligibility the profile does not qualify for", () => {
    const q = quote({ rebates_json: [] });
    expect(
      codes(auditQuote(q, [], [inc({ eligibility: "military_first_responder" })], prof)),
    ).not.toContain("MISSING_REBATE");
  });

  it("fires for a military rebate when the profile qualifies", () => {
    const q = quote({ rebates_json: [] });
    const milProf = profile({ make: "Hyundai", military_first_responder: 1 });
    expect(
      codes(auditQuote(q, [], [inc({ eligibility: "military_first_responder" })], milProf)),
    ).toContain("MISSING_REBATE");
  });

  it("does not fire when there are no incentives at all", () => {
    const q = quote({ rebates_json: [] });
    expect(codes(auditQuote(q, [], [], prof))).not.toContain("MISSING_REBATE");
  });
});

// --------------------------------------------------------------------------- //
// (7) ADD_ON_<NAME>                                                           //
// --------------------------------------------------------------------------- //

describe("ADD_ON checks", () => {
  it("fires one finding per matched add-on keyword", () => {
    const q = quote({
      add_ons_json: [{ name: "Pro Pack", amount: 1499 }, { name: "Nitrogen Fill", amount: 199 }],
    });
    const c = codes(auditQuote(q, [], [], profile()));
    expect(c).toContain("ADD_ON_PROPACK");
    expect(c).toContain("ADD_ON_NITROGENFILL");
  });

  it("dedups the same add-on appearing in both source lists by code", () => {
    const q = quote({
      other_fees_json: [{ name: "ProtectionPlus", amount: 800 }],
      add_ons_json: [{ name: "ProtectionPlus", amount: 800 }],
    });
    const c = codes(auditQuote(q, [], [], profile()));
    expect(c.filter((x) => x === "ADD_ON_PROTECTIONPLUS")).toHaveLength(1);
  });

  it("does not fire for an unrecognized line item", () => {
    const q = quote({ add_ons_json: [{ name: "Floor Mats", amount: 120 }] });
    expect(codes(auditQuote(q, [], [], profile())).some((x) => x.startsWith("ADD_ON_"))).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// (8) MODE_MISMATCH                                                           //
// --------------------------------------------------------------------------- //

describe("MODE_MISMATCH", () => {
  it("fires when the quote mode differs from a concrete preference", () => {
    const q = quote({ financing_mode: "lease" });
    expect(codes(auditQuote(q, [], [], profile({ financing_preference: "finance" })))).toContain(
      "MODE_MISMATCH",
    );
  });

  it("does not fire when modes match", () => {
    const q = quote({ financing_mode: "finance" });
    expect(
      codes(auditQuote(q, [], [], profile({ financing_preference: "finance" }))),
    ).not.toContain("MODE_MISMATCH");
  });

  it("does not fire for an undecided / empty preference", () => {
    const q = quote({ financing_mode: "lease" });
    expect(
      codes(auditQuote(q, [], [], profile({ financing_preference: "undecided" }))),
    ).not.toContain("MODE_MISMATCH");
  });
});

// --------------------------------------------------------------------------- //
// (9) LOW_CONFIDENCE                                                          //
// --------------------------------------------------------------------------- //

describe("LOW_CONFIDENCE", () => {
  it("fires for OCR extraction (one flag, OCR branch wins)", () => {
    const q = quote({ extraction_method: "ocr", confidence: 0.9 });
    const c = codes(auditQuote(q, [], [], profile()));
    expect(c.filter((x) => x === "LOW_CONFIDENCE")).toHaveLength(1);
  });

  it("fires when confidence < 0.60", () => {
    const q = quote({ extraction_method: "vision", confidence: 0.5 });
    expect(codes(auditQuote(q, [], [], profile()))).toContain("LOW_CONFIDENCE");
  });

  it("does not fire at confidence >= 0.60 with native vision", () => {
    const q = quote({ extraction_method: "vision", confidence: 0.6 });
    expect(codes(auditQuote(q, [], [], profile()))).not.toContain("LOW_CONFIDENCE");
  });

  it("classifies LOW_CONFIDENCE as info via the classifier (even though emitted)", () => {
    const q = quote({ extraction_method: "ocr" });
    const finding = auditQuote(q, [], [], profile()).find((f) => f.code === "LOW_CONFIDENCE")!;
    expect(finding.severity).toBe("info");
  });
});

// --------------------------------------------------------------------------- //
// (10) MISSING_BREAKDOWN                                                      //
// --------------------------------------------------------------------------- //

describe("MISSING_BREAKDOWN", () => {
  it("fires when OTD is present but a breakdown field is missing", () => {
    const q = quote({ otd_total: 43085, selling_price: 40000, doc_fee: null, sales_tax: 3000 });
    const finding = auditQuote(q, [], [], profile()).find((f) => f.code === "MISSING_BREAKDOWN")!;
    expect(finding).toBeDefined();
    expect(finding.severity).toBe("info");
  });

  it("does not fire when the full breakdown is present", () => {
    const q = quote({ otd_total: 43085, selling_price: 40000, doc_fee: 85, sales_tax: 3000 });
    expect(codes(auditQuote(q, [], [], profile()))).not.toContain("MISSING_BREAKDOWN");
  });

  it("does not fire when OTD itself is missing", () => {
    const q = quote({ otd_total: null, selling_price: 40000 });
    expect(codes(auditQuote(q, [], [], profile()))).not.toContain("MISSING_BREAKDOWN");
  });
});

// --------------------------------------------------------------------------- //
// Dispatcher                                                                  //
// --------------------------------------------------------------------------- //

describe("auditQuote dispatcher", () => {
  it("returns zero findings for a clean reconciled quote", () => {
    const q = quote({
      selling_price: 40000,
      sales_tax: 3000,
      doc_fee: 85,
      otd_total: 43085,
      financing_mode: "finance",
    });
    expect(auditQuote(q, [], [], profile({ state: "CA", make: "Hyundai" }))).toEqual([]);
  });

  it("emits findings in dispatcher order (math before doc-fee before add-on before breakdown)", () => {
    const q = quote({
      selling_price: 40000,
      sales_tax: 3000,
      doc_fee: 599,
      otd_total: 99999,
      add_ons_json: [{ name: "Pro Pack", amount: 1499 }],
    });
    const c = codes(auditQuote(q, [], [], profile({ state: "CA", make: "Hyundai" })));
    expect(c.indexOf("MATH_SANITY")).toBeLessThan(c.indexOf("DOC_FEE_CAP"));
    expect(c.indexOf("DOC_FEE_CAP")).toBeLessThan(c.indexOf("ADD_ON_PROPACK"));
  });

  it("does not crash on a fully-empty quote with empty peers/incentives", () => {
    expect(() => auditQuote(quote(), [], [], profile())).not.toThrow();
  });
});
