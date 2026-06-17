// @vitest-environment happy-dom
/**
 * QuotesPanel.test — the Quotes tab composition: canonical ranked compare
 * (always visible) + collapsed raw-extractions foldout.
 *
 * Proves: compare section always renders; foldout is present and collapsed by
 * default (no `open` attr); summary shows the raw count; toggling open reveals
 * canvas-quote-row elements.
 */

import { describe, expect, it } from "vitest";

import type { AsyncState } from "../api/useApi.js";
import type { QuoteCompareResult, QuoteList } from "../api/wire.js";
import { render } from "../test/render.js";
import { QuotesPanel } from "./QuotesPanel.js";

function okCompare(data: QuoteCompareResult): AsyncState<QuoteCompareResult> {
  return { kind: "ok", data };
}
function okRaw(data: QuoteList): AsyncState<QuoteList> {
  return { kind: "ok", data };
}

const emptyCompare: QuoteCompareResult = {
  financingPreference: null,
  finance: [],
  lease: [],
  totalRanked: 0,
};

function rawQuote(overrides: Partial<QuoteList[number]> = {}): QuoteList[number] {
  return {
    quote_id: "q-1",
    dealer_name: "Test Dealer",
    financing_mode: "finance",
    otd_total: 40000,
    selling_price: 37000,
    vin: "VIN001",
    quote_format: "otd",
    intent: "quote",
    extractor_provider: "deepseek",
    extraction_method: "ocr",
    quote_received_at: "2026-06-17T00:00:00.000Z",
    audit_flag_summary: [],
    ...overrides,
  };
}

describe("QuotesPanel — compare section always visible", () => {
  it("renders the quote-compare section even when empty", () => {
    const { container } = render(
      <QuotesPanel quotes={okCompare(emptyCompare)} quotesRaw={okRaw([])} />,
    );
    expect(container.querySelector('[data-testid="quote-compare"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="quote-compare-empty"]')).not.toBeNull();
  });

  it("renders quote-compare section with rows when populated", () => {
    const row = {
      rank: 1,
      dealer_id: "d-1",
      dealer_name: "Dealer A",
      otd_total: 42000,
      apr_or_mf: "6.9%",
      down_or_das: 3000,
      monthly: 550,
      audit_flag_summary: [] as string[],
      financing_mode: "finance",
    };
    const compare: QuoteCompareResult = {
      financingPreference: "finance",
      finance: [row],
      lease: [],
      totalRanked: 1,
    };
    const { container } = render(
      <QuotesPanel quotes={okCompare(compare)} quotesRaw={okRaw([])} />,
    );
    expect(container.querySelector('[data-testid="quote-compare"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="quote-compare-row"]')).not.toBeNull();
  });
});

describe("QuotesPanel — raw foldout", () => {
  it("renders the foldout summary with testid canvas-quotes-foldout", () => {
    const { container } = render(
      <QuotesPanel quotes={okCompare(emptyCompare)} quotesRaw={okRaw([])} />,
    );
    const summary = container.querySelector('[data-testid="canvas-quotes-foldout"]');
    expect(summary).not.toBeNull();
  });

  it("foldout is collapsed by default (details has no open attribute)", () => {
    const { container } = render(
      <QuotesPanel quotes={okCompare(emptyCompare)} quotesRaw={okRaw([])} />,
    );
    const details = container.querySelector("details.quotes-rawfold");
    expect(details).not.toBeNull();
    expect(details!.hasAttribute("open")).toBe(false);
  });

  it("summary shows the raw quote count when quotesRaw is ok", () => {
    const rows = [
      rawQuote({ quote_id: "q-1", financing_mode: "cash" }),
      rawQuote({ quote_id: "q-2", financing_mode: "finance" }),
    ];
    const { container } = render(
      <QuotesPanel quotes={okCompare(emptyCompare)} quotesRaw={okRaw(rows)} />,
    );
    const summary = container.querySelector('[data-testid="canvas-quotes-foldout"]');
    expect(summary!.textContent).toContain("2");
  });

  it("summary omits count when quotesRaw is loading", () => {
    const { container } = render(
      <QuotesPanel quotes={okCompare(emptyCompare)} quotesRaw={{ kind: "loading" }} />,
    );
    const summary = container.querySelector('[data-testid="canvas-quotes-foldout"]');
    expect(summary!.textContent).toContain("Raw extractions");
    // No parenthetical count when loading
    expect(summary!.textContent).not.toMatch(/\(\d+\)/);
  });

  it("canvas-quotes section is inside the foldout details", () => {
    const { container } = render(
      <QuotesPanel quotes={okCompare(emptyCompare)} quotesRaw={okRaw([])} />,
    );
    const details = container.querySelector("details.quotes-rawfold");
    const quotesSection = details!.querySelector('[data-testid="canvas-quotes"]');
    expect(quotesSection).not.toBeNull();
  });

  it("canvas-quote-row elements appear inside the foldout when rows are present", () => {
    const rows = [
      rawQuote({ quote_id: "q-a", financing_mode: "cash" }),
      rawQuote({ quote_id: "q-b", financing_mode: "finance" }),
    ];
    const { container } = render(
      <QuotesPanel quotes={okCompare(emptyCompare)} quotesRaw={okRaw(rows)} />,
    );
    const details = container.querySelector("details.quotes-rawfold");
    const rowEls = details!.querySelectorAll('[data-testid="canvas-quote-row"]');
    expect(rowEls).toHaveLength(2);
  });

  it("embedded prop suppresses the h2 heading inside the foldout", () => {
    const rows = [rawQuote()];
    const { container } = render(
      <QuotesPanel quotes={okCompare(emptyCompare)} quotesRaw={okRaw(rows)} />,
    );
    const details = container.querySelector("details.quotes-rawfold");
    // The Quotes section inside the foldout must NOT render "Extracted quotes" h2
    const headings = [...details!.querySelectorAll("h2")].map((h) => h.textContent);
    expect(headings).not.toContain("Extracted quotes");
  });
});
