// @vitest-environment happy-dom
/**
 * QuoteDetailModal.test — the read-only "double-check" quote detail surface. A
 * buyer opens it by clicking a quote card; it restates the full price breakdown,
 * the finance OR lease terms, how the quote was read (provenance), the source
 * dealer email it came from, and the audit findings. Proves: the OTD + breakdown
 * line items render, the finance/lease block renders, the source-email
 * subject/sender render, the provenance line renders, an audit pill renders, null
 * fields omit their rows, and NO budget / NO bare id leaks into the text.
 *
 * The modal portals into document.body — tests query document.body and unmount to
 * avoid portal residue.
 */

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { QuoteRow } from "../api/wire.js";
import { render } from "../test/render.js";
import { QuoteDetailModal } from "./QuoteDetailModal.js";

/** Let the open-effect's fetch + blob promises settle, inside act() so React
 *  flushes the resulting state updates (the test render helper drives act). */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function quote(over: Partial<QuoteRow> = {}): QuoteRow {
  return {
    quote_id: "q-detail-1",
    dealer_name: "Norm Reeves Hyundai",
    financing_mode: "finance",
    otd_total: 43210,
    selling_price: 39000,
    vin: "VIN123",
    quote_format: "otd",
    intent: "quote",
    extractor_provider: "deepseek",
    extraction_method: "ocr",
    quote_received_at: "2026-06-12T10:00:00.000Z",
    quote_expires_at: null,
    confidence: null,
    inventory_status: null,
    msrp: 41000,
    dealer_discount: 2000,
    doc_fee: 85,
    dealer_fee: null,
    sales_tax: 3100,
    dmv_fees: 410,
    title_fee: null,
    registration_fee: null,
    license_fee: null,
    other_fees_json: null,
    rebates_json: null,
    add_ons_json: null,
    finance_apr: 6.9,
    finance_term_months: 72,
    finance_down_payment: 3000,
    finance_monthly_payment: 560,
    finance_amount_financed: 40210,
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
    source_subject: "Your Tucson quote",
    source_body_text: "Hi,\n\nHere is your out-the-door price.\n\nThanks,\nSam",
    source_sender: "sam@normreeves.example",
    source_received_at: "2026-06-12T09:55:00.000Z",
    audit_flag_summary: ["MATH_SANITY", "MISSING_REBATE"],
    ...over,
  };
}

describe("QuoteDetailModal — closed", () => {
  it("renders nothing into the body when row is null", () => {
    const { unmount } = render(<QuoteDetailModal row={null} onClose={() => {}} />);
    expect(document.body.querySelector('[data-testid="quote-detail-modal"]')).toBeNull();
    unmount();
  });
});

describe("QuoteDetailModal — full finance quote", () => {
  afterEach(() => {
    document.body.querySelectorAll('[data-testid="modal-backdrop"]').forEach((n) => n.remove());
  });

  it("renders the dealer title, mode chip, OTD, breakdown, finance, provenance, source email and an audit pill", () => {
    const { unmount } = render(<QuoteDetailModal row={quote()} onClose={() => {}} />);
    const modal = document.body.querySelector('[data-testid="quote-detail-modal"]');
    expect(modal).not.toBeNull();
    const text = modal!.textContent ?? "";

    // Title + mode chip.
    expect(document.body.querySelector('[data-testid="quote-detail-title"]')!.textContent).toBe(
      "Norm Reeves Hyundai",
    );
    expect(document.body.querySelector('[data-testid="quote-mode-chip"]')!.textContent).toBe(
      "finance",
    );

    // OTD + a couple breakdown line items (formatted dollars, no cents).
    expect(text).toContain("$43,210"); // OTD
    expect(text).toContain("$41,000"); // MSRP
    expect(text).toContain("$39,000"); // Selling price
    expect(text).toContain("$2,000"); // Dealer discount
    expect(text).toContain("$3,100"); // Sales tax

    // Finance block.
    expect(text).toContain("6.9%"); // APR
    expect(text).toContain("72 mo"); // Term
    expect(text).toContain("$560"); // Monthly

    // Provenance — "how this was read".
    expect(text).toContain("otd");
    expect(text).toContain("ocr");
    expect(text).toContain("deepseek");

    // Source email.
    const sourceEl = document.body.querySelector('[data-testid="quote-detail-source-email"]');
    expect(sourceEl).not.toBeNull();
    expect(sourceEl!.textContent).toContain("Your Tucson quote");
    expect(sourceEl!.textContent).toContain("sam@normreeves.example");
    expect(sourceEl!.textContent).toContain("Here is your out-the-door price.");

    // Audit pill (MISSING_REBATE collapses; MATH_SANITY stays its own pill).
    expect(
      document.body.querySelector('[data-testid="quote-audit-pill-MATH_SANITY"]'),
    ).not.toBeNull();
    expect(
      document.body.querySelector('[data-testid="quote-audit-pill-MISSING_REBATE"]'),
    ).not.toBeNull();

    unmount();
  });

  it("omits null breakdown rows and never leaks a bare id or budget", () => {
    const { unmount } = render(<QuoteDetailModal row={quote()} onClose={() => {}} />);
    const modal = document.body.querySelector('[data-testid="quote-detail-modal"]');
    const text = modal!.textContent ?? "";
    // dealer_fee / title_fee / etc. are null → their labels must not appear.
    expect(text).not.toContain("Dealer fee");
    expect(text).not.toContain("Title fee");
    // No lease block when all lease_* are null.
    expect(document.body.querySelector('[data-testid="quote-detail-lease"]')).toBeNull();
    // The quote_id is a join/key only — never rendered.
    expect(text).not.toContain("q-detail-1");
    // No budget affordance anywhere.
    expect(text.toLowerCase()).not.toContain("budget");
    unmount();
  });
});

describe("QuoteDetailModal — lease quote", () => {
  afterEach(() => {
    document.body.querySelectorAll('[data-testid="modal-backdrop"]').forEach((n) => n.remove());
  });

  it("renders the lease block and omits the finance block when finance_* are null", () => {
    const lease = quote({
      financing_mode: "lease",
      finance_apr: null,
      finance_term_months: null,
      finance_down_payment: null,
      finance_monthly_payment: null,
      finance_amount_financed: null,
      lease_term_months: 36,
      lease_money_factor: 0.00125,
      lease_residual_pct: 58,
      lease_due_at_signing: 2500,
      lease_monthly_payment: 410,
      lease_miles_per_year: 12000,
    });
    const { unmount } = render(<QuoteDetailModal row={lease} onClose={() => {}} />);
    const leaseEl = document.body.querySelector('[data-testid="quote-detail-lease"]');
    expect(leaseEl).not.toBeNull();
    const text = leaseEl!.textContent ?? "";
    expect(text).toContain("36 mo");
    expect(text).toContain("0.00125"); // money factor (raw)
    expect(text).toContain("$410"); // monthly
    // No finance block.
    expect(document.body.querySelector('[data-testid="quote-detail-finance"]')).toBeNull();
    unmount();
  });
});

describe("QuoteDetailModal — original source document embed", () => {
  afterEach(() => {
    document.body.querySelectorAll('[data-testid="modal-backdrop"]').forEach((n) => n.remove());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fetches and embeds the original image, with an Open-original link, when quote_format is image", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(["png-bytes"], { type: "image/png" }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const createObjectURL = vi.fn(() => "blob:obj-image");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    } as unknown as typeof URL);

    const { unmount } = render(
      <QuoteDetailModal
        row={quote({ quote_format: "image" })}
        sourceDocUrl="/api/profiles/p1/quotes/q-detail-1/source"
        onClose={() => {}}
      />,
    );
    await flush();

    expect(fetchMock).toHaveBeenCalledWith("/api/profiles/p1/quotes/q-detail-1/source");
    const img = document.body.querySelector('[data-testid="quote-source-image"]');
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("blob:obj-image");

    const open = document.body.querySelector('[data-testid="quote-source-open"]');
    expect(open).not.toBeNull();
    expect(open!.getAttribute("href")).toBe("/api/profiles/p1/quotes/q-detail-1/source");
    expect(open!.getAttribute("target")).toBe("_blank");
    expect(open!.getAttribute("rel")).toBe("noopener noreferrer");

    // The source-email text remains the floor below the embed.
    expect(
      document.body.querySelector('[data-testid="quote-detail-source-email"]')!.textContent,
    ).toContain("Your Tucson quote");

    unmount();
  });

  it("embeds a pdf <embed> when quote_format is pdf", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(["%PDF-bytes"], { type: "application/pdf" }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:obj-pdf"),
      revokeObjectURL: vi.fn(),
    } as unknown as typeof URL);

    const { unmount } = render(
      <QuoteDetailModal
        row={quote({ quote_format: "pdf" })}
        sourceDocUrl="/api/profiles/p1/quotes/q-detail-1/source"
        onClose={() => {}}
      />,
    );
    await flush();

    const embed = document.body.querySelector('[data-testid="quote-source-pdf"]');
    expect(embed).not.toBeNull();
    expect(embed!.getAttribute("src")).toBe("blob:obj-pdf");
    expect(document.body.querySelector('[data-testid="quote-source-image"]')).toBeNull();
    unmount();
  });

  it("renders NO embed and keeps the source-email floor when the fetch is a 404", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      blob: async () => new Blob([]),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:never"),
      revokeObjectURL: vi.fn(),
    } as unknown as typeof URL);

    const { unmount } = render(
      <QuoteDetailModal
        row={quote({ quote_format: "image" })}
        sourceDocUrl="/api/profiles/p1/quotes/q-detail-1/source"
        onClose={() => {}}
      />,
    );
    await flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[data-testid="quote-source-image"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="quote-source-pdf"]')).toBeNull();
    // The source-email text still renders — the fallback floor, never a broken box.
    expect(
      document.body.querySelector('[data-testid="quote-detail-source-email"]')!.textContent,
    ).toContain("Your Tucson quote");
    unmount();
  });

  it("does not fetch and renders no embed when quote_format is text (kind null)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob([]),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const { unmount } = render(
      <QuoteDetailModal
        row={quote({ quote_format: "text" })}
        sourceDocUrl="/api/profiles/p1/quotes/q-detail-1/source"
        onClose={() => {}}
      />,
    );
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="quote-source-image"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="quote-source-pdf"]')).toBeNull();
    unmount();
  });
});

describe("QuoteDetailModal — incomplete OTD", () => {
  afterEach(() => {
    document.body.querySelectorAll('[data-testid="modal-backdrop"]').forEach((n) => n.remove());
  });

  it("renders the incomplete chip when otd_total is null", () => {
    const { unmount } = render(
      <QuoteDetailModal row={quote({ otd_total: null })} onClose={() => {}} />,
    );
    expect(
      document.body.querySelector('[data-testid="quote-detail-incomplete"]'),
    ).not.toBeNull();
    unmount();
  });
});
