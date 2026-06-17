/**
 * QuotesPanel — the Quotes tab content: the canonical ranked compare (always
 * visible) followed by a collapsed foldout for the raw per-mode extractions.
 *
 * Layout:
 *   <QuoteCompare>  ← always visible, canonical ranked view
 *   <details class="quotes-rawfold">
 *     <summary data-testid="canvas-quotes-foldout">Raw extractions (N)</summary>
 *     <Quotes embedded>  ← collapsed by default; expand to inspect raw rows
 *   </details>
 *
 * The foldout is collapsed by default (no `open` attr) — progressive disclosure.
 * The <summary> is the heading for the raw section when expanded.
 * Presentational only: takes its data as props.
 */

import type { AsyncState } from "../api/useApi.js";
import type { QuoteCompareResult, QuoteList } from "../api/wire.js";
import { QuoteCompare } from "./QuoteCompare.js";
import { Quotes } from "./Quotes.js";

export interface QuotesPanelProps {
  quotes: AsyncState<QuoteCompareResult>;
  quotesRaw: AsyncState<QuoteList>;
}

export function QuotesPanel({ quotes, quotesRaw }: QuotesPanelProps): JSX.Element {
  const rawCount = quotesRaw.kind === "ok" ? quotesRaw.data.length : null;
  const summaryLabel =
    rawCount !== null ? `Raw extractions (${rawCount})` : "Raw extractions";

  return (
    <>
      <QuoteCompare quotes={quotes} />
      <details className="quotes-rawfold">
        <summary data-testid="canvas-quotes-foldout">{summaryLabel}</summary>
        <Quotes quotes={quotesRaw} embedded />
      </details>
    </>
  );
}
