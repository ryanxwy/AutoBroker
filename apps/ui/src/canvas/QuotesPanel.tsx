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
 *   <QuoteDetailModal>  ← portalled "double-check" detail for the clicked card
 *
 * The foldout is collapsed by default (no `open` attr) — progressive disclosure.
 * The <summary> is the heading for the raw section when expanded.
 *
 * Clicking either a ranked compare row or a raw extraction card opens the
 * full-breakdown detail modal. The raw foldout cards already carry the full
 * QuoteRow, so they open it directly; the compare rows carry only a thin
 * projection + quote_id, so the panel resolves that id to the full raw QuoteRow
 * (the lookup map) before opening. Presentational only: takes its data as props.
 */

import { useMemo, useState } from "react";

import type { AsyncState } from "../api/useApi.js";
import type { QuoteCompareResult, QuoteList, QuoteRow } from "../api/wire.js";
import { QuoteCompare } from "./QuoteCompare.js";
import { QuoteDetailModal } from "./QuoteDetailModal.js";
import { Quotes } from "./Quotes.js";

export interface QuotesPanelProps {
  quotes: AsyncState<QuoteCompareResult>;
  quotesRaw: AsyncState<QuoteList>;
  /** Builds the GET …/quotes/:quoteId/source URL for the open quote so the detail
   *  modal can embed the dealer's original document. Omitted (no active profile) →
   *  the modal shows only the source-email text floor. */
  quoteSourceUrl?: (quoteId: string) => string;
}

export function QuotesPanel({
  quotes,
  quotesRaw,
  quoteSourceUrl,
}: QuotesPanelProps): JSX.Element {
  const [detail, setDetail] = useState<QuoteRow | null>(null);

  const rawCount = quotesRaw.kind === "ok" ? quotesRaw.data.length : null;
  const summaryLabel =
    rawCount !== null ? `Raw extractions (${rawCount})` : "Raw extractions";

  // quote_id → full raw QuoteRow, so a compare row (which only carries quote_id +
  // a thin projection) can resolve to the full breakdown for the detail modal.
  const byId = useMemo(() => {
    const map = new Map<string, QuoteRow>();
    if (quotesRaw.kind === "ok") {
      for (const row of quotesRaw.data) map.set(row.quote_id, row);
    }
    return map;
  }, [quotesRaw]);

  return (
    <>
      <QuoteCompare
        quotes={quotes}
        onOpenCompare={(quoteId) => {
          const full = byId.get(quoteId);
          if (full !== undefined) setDetail(full);
        }}
      />
      <details className="quotes-rawfold">
        <summary data-testid="canvas-quotes-foldout">{summaryLabel}</summary>
        <Quotes quotes={quotesRaw} embedded onOpenQuote={(row) => setDetail(row)} />
      </details>
      <QuoteDetailModal
        row={detail}
        sourceDocUrl={
          detail !== null && quoteSourceUrl ? quoteSourceUrl(detail.quote_id) : null
        }
        onClose={() => setDetail(null)}
      />
    </>
  );
}
