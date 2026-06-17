/**
 * QuoteCompare — the READ-ONLY "Quote compare" projection on the workbench
 * canvas. After dealer quotes are extracted (and optionally audited), the
 * /quote_compare ranker ranks them by out-the-door total within each financing
 * bucket and surfaces the side-by-side compare table here: one row per quote with
 * the dealer, the OTD total, the rate (APR for finance, money factor for lease),
 * the down / due-at-signing, the monthly, and the latest audit's flag pills.
 *
 * GATING (mirrors the ranker): an UNDECIDED profile shows BOTH the finance and
 * lease buckets side-by-side; a finance / lease preference shows the one bucket;
 * a CASH profile (or a profile with no quotes) shows the empty state. Both
 * buckets are always present in the payload — the empty off-mode side is the
 * contract.
 *
 * Budget red line: a row renders OTD, rate, down/DAS, monthly, and audit flag
 * codes — NEVER a budget number. A null OTD renders an "incomplete" badge (the
 * row sorts last); a null down/monthly renders an em-dash. The audit flag pills
 * iterate `audit_flag_summary` WITHOUT a null guard — it is ALWAYS a list (the
 * decoder returns [] when there is no/unparsable audit). Presentational ONLY: it
 * takes its data as a PROP (an AsyncState the host wires from the ranker route)
 * and knows nothing about the API client. LIGHT paper skin, mirroring the threads
 * + inventory-candidates sections.
 */

import type { AsyncState } from "../api/useApi.js";
import type { QuoteCompareResult, QuoteCompareRow } from "../api/wire.js";
import { collapseAuditFlags } from "./auditFlags.js";

/** A "$44,540" total label from a number, or null for a missing total. */
function dollarLabel(value: number | null): string | null {
  if (value === null) return null;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function QuoteRow({ row }: { row: QuoteCompareRow }): JSX.Element {
  const otd = dollarLabel(row.otd_total);
  const downOrDas = dollarLabel(row.down_or_das);
  const monthly = dollarLabel(row.monthly);
  return (
    <div className="tile" data-testid="quote-compare-row">
      <div className="t-head">
        <span data-testid="quote-compare-dealer">{row.dealer_name}</span>
        {otd !== null ? (
          <span data-testid="quote-compare-otd">{otd}</span>
        ) : (
          // A missing OTD renders the "incomplete" badge, never a fabricated
          // number (the ranker sorts these rows last).
          <span className="mini-chip" data-testid="quote-incomplete-badge">
            incomplete
          </span>
        )}
      </div>
      <div className="t-status">
        {row.apr_or_mf !== "" && <span data-testid="quote-compare-rate">{row.apr_or_mf}</span>}
        <span className="muted"> · down {downOrDas ?? "—"}</span>
        <span className="muted"> · /mo {monthly ?? "—"}</span>
      </div>
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
    </div>
  );
}

/** One mode bucket (finance or lease). Always rendered when its mode is in
 *  scope; an empty bucket shows a quiet line. */
function Bucket({
  testid,
  title,
  rows,
}: {
  testid: string;
  title: string;
  rows: QuoteCompareRow[];
}): JSX.Element {
  return (
    <div className="quote-compare-bucket" data-testid={testid}>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="muted">No {title.toLowerCase()} quotes to compare.</p>
      ) : (
        <div className="tile-grid">
          {rows.map((row) => (
            <QuoteRow key={`${row.dealer_id}-${row.rank}`} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

export interface QuoteCompareProps {
  /** The profile's ranked quote buckets (the host wires this from the ranker
   *  route). */
  quotes: AsyncState<QuoteCompareResult>;
}

export function QuoteCompare({ quotes }: QuoteCompareProps): JSX.Element {
  const finance = quotes.kind === "ok" ? quotes.data.finance : [];
  const lease = quotes.kind === "ok" ? quotes.data.lease : [];
  const totalRanked = finance.length + lease.length;
  // Which buckets are in scope is driven by which the payload populated: a
  // finance-only / lease-only preference leaves the other list empty AND
  // off-scope, so a non-empty list is the signal a bucket should render. When
  // BOTH are empty (cash / no quotes), the empty state stands in.
  const showFinance = finance.length > 0;
  const showLease = lease.length > 0;

  return (
    <section data-testid="quote-compare">
      <h2>Quote compare</h2>
      {quotes.kind === "loading" && <p className="muted">Loading quotes…</p>}
      {quotes.kind === "error" && (
        <p className="danger-text" role="alert">
          Couldn&apos;t load quote compare: {quotes.message}
        </p>
      )}
      {quotes.kind === "ok" && totalRanked === 0 && (
        <p className="muted" data-testid="quote-compare-empty">
          Compared 0 quotes.
        </p>
      )}
      {quotes.kind === "ok" && totalRanked > 0 && (
        <div className="quote-compare-buckets">
          {showFinance && (
            <Bucket testid="quote-compare-finance" title="Finance" rows={finance} />
          )}
          {showLease && <Bucket testid="quote-compare-lease" title="Lease" rows={lease} />}
        </div>
      )}
    </section>
  );
}
