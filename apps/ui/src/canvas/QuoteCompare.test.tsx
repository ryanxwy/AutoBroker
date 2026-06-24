// @vitest-environment happy-dom
/**
 * QuoteCompare.test — the ranked finance/lease/cash compare buckets. Proves the
 * cash bucket renders (preserved alongside finance/lease) and that clicking a
 * compare row calls onOpenCompare with the row's quote_id (the lookup key the
 * host resolves to the full raw QuoteRow for the detail modal).
 */

import { describe, expect, it, vi } from "vitest";

import type { AsyncState } from "../api/useApi.js";
import type { QuoteCompareResult, QuoteCompareRow } from "../api/wire.js";
import { click, render } from "../test/render.js";
import { QuoteCompare } from "./QuoteCompare.js";

function ok(data: QuoteCompareResult): AsyncState<QuoteCompareResult> {
  return { kind: "ok", data };
}

function compareRow(over: Partial<QuoteCompareRow> = {}): QuoteCompareRow {
  return {
    rank: 1,
    quote_id: "q-cmp-1",
    dealer_id: "d-1",
    dealer_name: "Dealer A",
    otd_total: 42000,
    apr_or_mf: "6.9%",
    down_or_das: 3000,
    monthly: 550,
    audit_flag_summary: [],
    financing_mode: "finance",
    ...over,
  };
}

describe("QuoteCompare — cash bucket preserved", () => {
  it("renders the cash bucket when cash rows are present", () => {
    const data: QuoteCompareResult = {
      financingPreference: "cash",
      finance: [],
      lease: [],
      cash: [compareRow({ quote_id: "q-cash", financing_mode: "cash", apr_or_mf: "" })],
      totalRanked: 1,
    };
    const { container } = render(<QuoteCompare quotes={ok(data)} />);
    expect(container.querySelector('[data-testid="quote-compare-cash"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="quote-compare-row"]')).not.toBeNull();
  });
});

describe("QuoteCompare — cross-state tax note", () => {
  it("shows the home-state tax-normalization note when a home state is known", () => {
    const data: QuoteCompareResult = {
      financingPreference: "finance",
      finance: [compareRow()],
      lease: [],
      totalRanked: 1,
      homeState: "CA",
      homeStateTaxRate: 0.0725,
    };
    const { container } = render(<QuoteCompare quotes={ok(data)} />);
    const note = container.querySelector('[data-testid="quote-compare-tax-note"]');
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain("CA");
    expect(note!.textContent).toContain("7.25%");
    // Honest framing: crossing state lines does NOT win on tax.
    expect(note!.textContent?.toLowerCase()).toContain("not tax");
  });

  it("omits the note when no home state is known", () => {
    const data: QuoteCompareResult = {
      financingPreference: "finance",
      finance: [compareRow()],
      lease: [],
      totalRanked: 1,
    };
    const { container } = render(<QuoteCompare quotes={ok(data)} />);
    expect(container.querySelector('[data-testid="quote-compare-tax-note"]')).toBeNull();
  });
});

describe("QuoteCompare — clickable rows", () => {
  it("calls onOpenCompare with the row's quote_id when a compare row is clicked", () => {
    const onOpenCompare = vi.fn<(quoteId: string) => void>();
    const data: QuoteCompareResult = {
      financingPreference: "finance",
      finance: [compareRow({ quote_id: "q-fin-7" })],
      lease: [],
      totalRanked: 1,
    };
    const { container } = render(
      <QuoteCompare quotes={ok(data)} onOpenCompare={onOpenCompare} />,
    );
    const row = container.querySelector('[data-testid="quote-compare-row"]') as HTMLElement;
    click(row);
    expect(onOpenCompare).toHaveBeenCalledTimes(1);
    expect(onOpenCompare).toHaveBeenCalledWith("q-fin-7");
  });
});
