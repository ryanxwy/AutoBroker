// @vitest-environment happy-dom
/**
 * Quotes.test — the presentational "Extracted quotes" canvas section. Proves the
 * empty state, the row rendering (dealer + mode chip + formatted OTD + provenance
 * line, including a CASH-mode row the ranked compare buckets would omit), the
 * loading + error states, the incomplete badge for a null OTD, and that NO budget
 * and NO raw id surface in the rendered text.
 */

import { describe, expect, it } from "vitest";

import type { AsyncState } from "../api/useApi.js";
import type { QuoteList } from "../api/wire.js";
import { render } from "../test/render.js";
import { Quotes } from "./Quotes.js";

function ok(data: QuoteList): AsyncState<QuoteList> {
  return { kind: "ok", data };
}

function quote(over: Partial<QuoteList[number]>): QuoteList[number] {
  return {
    quote_id: "q-1",
    dealer_name: "Example Hyundai",
    financing_mode: "finance",
    otd_total: 43210,
    selling_price: 39000,
    vin: "VIN123",
    quote_format: "otd",
    intent: "quote",
    extractor_provider: "deepseek",
    extraction_method: "ocr",
    quote_received_at: "2026-06-12T10:00:00.000Z",
    ...over,
  };
}

describe("Quotes — empty state", () => {
  it("renders the no-quotes copy", () => {
    const { container } = render(<Quotes quotes={ok([])} />);
    const empty = container.querySelector('[data-testid="canvas-quotes-empty"]');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toContain("No quotes extracted yet");
  });
});

describe("Quotes — rows", () => {
  const rows: QuoteList = [
    quote({ quote_id: "q-cash", financing_mode: "cash", otd_total: 39500 }),
    quote({
      quote_id: "q-fin",
      dealer_name: "Second Dealer",
      financing_mode: "finance",
      otd_total: 43210,
    }),
  ];

  it("renders one row per quote with the mode chip, formatted OTD (no cents), and provenance", () => {
    const { container } = render(<Quotes quotes={ok(rows)} />);
    const rowEls = container.querySelectorAll('[data-testid="canvas-quote-row"]');
    expect(rowEls).toHaveLength(2);
    // The cash row renders — what the ranked finance/lease compare buckets omit.
    const chips = container.querySelectorAll('[data-testid="quote-mode-chip"]');
    expect([...chips].map((c) => c.textContent)).toEqual(["cash", "finance"]);
    const otds = container.querySelectorAll('[data-testid="canvas-quote-otd"]');
    expect([...otds].map((c) => c.textContent)).toEqual(["$39,500", "$43,210"]);
    const provenance = container.querySelector('[data-testid="canvas-quote-provenance"]');
    expect(provenance!.textContent).toBe("via deepseek · ocr");
  });

  it("renders the incomplete badge for a null OTD (never a fabricated number)", () => {
    const { container } = render(<Quotes quotes={ok([quote({ otd_total: null })])} />);
    expect(container.querySelector('[data-testid="canvas-quote-incomplete"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="canvas-quote-otd"]')).toBeNull();
  });

  it("never surfaces a budget number or a raw quote id in the rendered text", () => {
    const { container } = render(<Quotes quotes={ok(rows)} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Example Hyundai");
    // The quote_id is a React key only — it must never render.
    expect(text).not.toContain("q-cash");
    expect(text).not.toContain("q-fin");
    // No "budget" affordance appears anywhere in this section.
    expect(text.toLowerCase()).not.toContain("budget");
  });

  it("does not render the empty copy when rows are present", () => {
    const { container } = render(<Quotes quotes={ok(rows)} />);
    expect(container.querySelector('[data-testid="canvas-quotes-empty"]')).toBeNull();
  });
});

describe("Quotes — embedded prop", () => {
  it("renders the h2 heading by default (embedded=false)", () => {
    const { container } = render(<Quotes quotes={ok([])} />);
    const h2 = container.querySelector("h2");
    expect(h2).not.toBeNull();
    expect(h2!.textContent).toBe("Extracted quotes");
  });

  it("suppresses the h2 heading when embedded=true", () => {
    const { container } = render(<Quotes quotes={ok([])} embedded />);
    expect(container.querySelector("h2")).toBeNull();
  });

  it("still renders canvas-quotes section and all content when embedded=true", () => {
    const { container } = render(<Quotes quotes={ok([])} embedded />);
    expect(container.querySelector('[data-testid="canvas-quotes"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="canvas-quotes-empty"]')).not.toBeNull();
  });
});

describe("Quotes — loading / error", () => {
  it("renders a loading line", () => {
    const { container } = render(<Quotes quotes={{ kind: "loading" }} />);
    expect(container.querySelector('[data-testid="canvas-quotes"]')!.textContent).toContain(
      "Loading quotes",
    );
  });

  it("renders an error line", () => {
    const { container } = render(
      <Quotes quotes={{ kind: "error", message: "boom", code: "x" }} />,
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert!.textContent).toContain("boom");
  });
});
