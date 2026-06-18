/**
 * Quotes — the READ-ONLY "Extracted quotes" projection on the workbench canvas.
 * After the dealer_reply_extract skill parses a dealer reply, the extracted
 * quote rows surface here: the RAW per-quote extraction results across ALL
 * financing modes (incl. cash / unspecified), each with the dealer, a
 * financing-mode chip, the out-the-door total, and a small provenance line
 * (the extractor provider + method).
 *
 * DISTINCT FROM "Quote compare" (load-bearing): QuoteCompare shows the RANKED
 * finance/lease buckets (the deterministic compare ranker, gated by preference);
 * this section shows the raw extraction output for every mode — a cash /
 * unspecified quote that the ranker's finance/lease buckets would omit still
 * shows here. The heading reads "Extracted quotes"; there is NO ranking. It DOES
 * render each quote's audit flag pills (the same collapsed flags as the compare
 * view) so a flagged off-mode quote — excluded from the ranked buckets — still
 * surfaces its findings (e.g. MODE_MISMATCH / MISSING_BREAKDOWN) somewhere.
 *
 * Budget red line: a quote row renders the dealer name, the financing-mode chip,
 * the OTD (formatted dollars, no cents), the provenance line, and audit flag
 * codes — NEVER a budget, NEVER a raw id (quote_id is the React key only).
 * Presentational ONLY:
 * it takes its rows as a PROP (an AsyncState the host wires from the quotes
 * route) and knows nothing about the API client. LIGHT paper skin, mirroring the
 * threads + quote-compare + inventory-candidates sections.
 */

import type { AsyncState } from "../api/useApi.js";
import type { QuoteList, QuoteRow } from "../api/wire.js";
import { collapseAuditFlags } from "./auditFlags.js";
import { ClickableTile } from "./ClickableTile.js";

/** A "$43,210" total label from a number (no cents noise), or null for a
 *  missing total. */
function dollarLabel(value: number | null): string | null {
  if (value === null) return null;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/** The provenance line — "via deepseek · ocr", dropping any missing part. An
 *  all-missing provenance yields "" (the line is then omitted). */
function provenanceLine(row: QuoteRow): string {
  const parts = [row.extractor_provider, row.extraction_method].filter(
    (p): p is string => p !== null && p !== "",
  );
  return parts.length > 0 ? `via ${parts.join(" · ")}` : "";
}

function QuoteRowView({
  row,
  onOpenQuote,
}: {
  row: QuoteRow;
  onOpenQuote: ((row: QuoteRow) => void) | undefined;
}): JSX.Element {
  const otd = dollarLabel(row.otd_total);
  const provenance = provenanceLine(row);
  return (
    <ClickableTile
      testid="canvas-quote-row"
      ariaLabel={`View quote details for ${row.dealer_name ?? "Unknown dealer"}`}
      onActivate={() => onOpenQuote?.(row)}
    >
      <div className="t-head">
        <span data-testid="canvas-quote-dealer">{row.dealer_name ?? "Unknown dealer"}</span>
        {row.financing_mode !== null && row.financing_mode !== "" && (
          <span
            className={`mini-chip quote-mode-${row.financing_mode}`}
            data-testid="quote-mode-chip"
          >
            {row.financing_mode}
          </span>
        )}
      </div>
      <div className="t-status">
        {otd !== null ? (
          <span data-testid="canvas-quote-otd">{otd}</span>
        ) : (
          // A missing OTD renders the "incomplete" badge, never a fabricated
          // number (mirrors the quote-compare row's null-OTD handling).
          <span className="mini-chip" data-testid="canvas-quote-incomplete">
            incomplete
          </span>
        )}
      </div>
      {provenance !== "" && (
        <div className="t-status muted" data-testid="canvas-quote-provenance">
          {provenance}
        </div>
      )}
      {row.audit_flag_summary.length > 0 && (
        <div className="chip-row">
          {collapseAuditFlags(row.audit_flag_summary).map((flag) => (
            <span
              className="mini-chip"
              key={flag.code}
              data-testid={`quote-audit-pill-${flag.code}`}
            >
              {flag.label}
            </span>
          ))}
        </div>
      )}
    </ClickableTile>
  );
}

export interface QuotesProps {
  /** The profile's raw extracted-quote rows (the host wires this from the quotes
   *  route). */
  quotes: AsyncState<QuoteList>;
  /** When true, suppress the <h2> heading (the foldout <summary> acts as the
   *  heading). Default false — standalone renders the heading as usual. */
  embedded?: boolean;
  /** Open the full-breakdown detail modal for a clicked quote card. Optional —
   *  a standalone render without it leaves the card a harmless no-op tile. */
  onOpenQuote?: (row: QuoteRow) => void;
}

export function Quotes({ quotes, embedded = false, onOpenQuote }: QuotesProps): JSX.Element {
  return (
    <section data-testid="canvas-quotes">
      {!embedded && <h2>Extracted quotes</h2>}
      {quotes.kind === "loading" && <p className="muted">Loading quotes…</p>}
      {quotes.kind === "error" && (
        <p className="danger-text" role="alert">
          Couldn&apos;t load quotes: {quotes.message}
        </p>
      )}
      {quotes.kind === "ok" && quotes.data.length === 0 && (
        <p className="muted" data-testid="canvas-quotes-empty">
          No quotes extracted yet — they appear here as dealer replies are parsed.
        </p>
      )}
      {quotes.kind === "ok" && quotes.data.length > 0 && (
        <div className="tile-grid">
          {quotes.data.map((row) => (
            <QuoteRowView key={row.quote_id} row={row} onOpenQuote={onOpenQuote} />
          ))}
        </div>
      )}
    </section>
  );
}
