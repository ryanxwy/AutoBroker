/**
 * QuoteDetailModal — the read-only "double-check" detail surface a buyer opens by
 * clicking an extracted-quote card. It restates the SAME public quote facts the
 * card carries plus the full breakdown the widened read now projects: the price
 * stack (MSRP → out-the-door), the finance OR lease terms, how the quote was read
 * (provenance), the dealer email it came from (so the buyer can verify the
 * numbers against the source), and the latest audit's flag pills.
 *
 * Budget red line: it shows only the dealer's own quoted facts — NEVER a budget,
 * NEVER a bare id (quote_id / message ids are joins/keys only, never rendered). A
 * null/empty field omits its row rather than fabricating a value. The finance and
 * lease blocks render only when that mode has at least one non-null field.
 * Presentational only: it takes one QuoteRow as a prop and knows nothing about the
 * API client.
 */

import { useId } from "react";

import type { QuoteRow } from "../api/wire.js";
import { Modal } from "../shell/Modal.js";
import { collapseAuditFlags } from "./auditFlags.js";
import { DetailRow } from "./DetailRow.js";
import { dateLabel, dollarLabel } from "./format.js";

export function QuoteDetailModal({
  row,
  onClose,
}: {
  row: QuoteRow | null;
  onClose: () => void;
}): JSX.Element {
  const titleId = useId();
  if (row === null) {
    // Closed: render an inert Modal (returns null while open=false) so the hook
    // order stays stable across open/closed.
    return (
      <Modal open={false} onClose={onClose} labelId={titleId} variant="dialog">
        <></>
      </Modal>
    );
  }

  const dealer = row.dealer_name ?? "Dealer quote";
  const otd = dollarLabel(row.otd_total);
  const mode = row.financing_mode;

  const hasFinance =
    row.finance_apr !== null ||
    row.finance_term_months !== null ||
    row.finance_down_payment !== null ||
    row.finance_monthly_payment !== null ||
    row.finance_amount_financed !== null;
  const hasLease =
    row.lease_term_months !== null ||
    row.lease_money_factor !== null ||
    row.lease_residual_pct !== null ||
    row.lease_residual_value !== null ||
    row.lease_due_at_signing !== null ||
    row.lease_monthly_payment !== null ||
    row.lease_miles_per_year !== null;

  // "How this was read" provenance — "Read from a {format} via {method} (provider: {p})".
  const readParts: string[] = [];
  if (row.quote_format !== null && row.quote_format !== "") {
    readParts.push(`Read from a ${row.quote_format}`);
  }
  if (row.extraction_method !== null && row.extraction_method !== "") {
    readParts.push(`via ${row.extraction_method}`);
  }
  const readLine = readParts.join(" ");
  const provider =
    row.extractor_provider !== null && row.extractor_provider !== ""
      ? `(provider: ${row.extractor_provider})`
      : "";
  const receivedLine = dateLabel(row.quote_received_at);
  const expiresLine = dateLabel(row.quote_expires_at);

  const sourceFrom = [row.source_sender, dateLabel(row.source_received_at)]
    .filter((p): p is string => p !== null && p !== "")
    .join(" · ");
  const hasSource =
    (row.source_subject !== null && row.source_subject !== "") ||
    (row.source_body_text !== null && row.source_body_text !== "");

  const flags = collapseAuditFlags(row.audit_flag_summary);

  return (
    <Modal open onClose={onClose} labelId={titleId} variant="dialog">
      <div data-testid="quote-detail-modal">
        <h2 id={titleId} data-testid="quote-detail-title">
          {dealer}
        </h2>
        <div className="chip-row">
          {mode !== null && mode !== "" && (
            <span className={`mini-chip quote-mode-${mode}`} data-testid="quote-mode-chip">
              {mode}
            </span>
          )}
          {otd !== null ? (
            <span className="mini-chip" data-testid="quote-detail-otd">
              {otd} OTD
            </span>
          ) : (
            <span className="mini-chip" data-testid="quote-detail-incomplete">
              incomplete
            </span>
          )}
        </div>

        <h3 className="quote-detail-h3">Price breakdown</h3>
        <dl className="inventory-detail-list">
          <DetailRow label="MSRP" value={dollarLabel(row.msrp)} />
          <DetailRow label="Selling price" value={dollarLabel(row.selling_price)} />
          <DetailRow label="Dealer discount" value={dollarLabel(row.dealer_discount)} />
          <DetailRow label="Doc fee" value={dollarLabel(row.doc_fee)} />
          <DetailRow label="Dealer fee" value={dollarLabel(row.dealer_fee)} />
          <DetailRow label="Sales tax" value={dollarLabel(row.sales_tax)} />
          <DetailRow label="DMV fees" value={dollarLabel(row.dmv_fees)} />
          <DetailRow label="Title fee" value={dollarLabel(row.title_fee)} />
          <DetailRow label="Registration fee" value={dollarLabel(row.registration_fee)} />
          <DetailRow label="License fee" value={dollarLabel(row.license_fee)} />
          <DetailRow label="Out-the-door total" value={otd} emphasize />
        </dl>

        {hasFinance && (
          <div data-testid="quote-detail-finance">
            <h3 className="quote-detail-h3">Finance</h3>
            <dl className="inventory-detail-list">
              <DetailRow
                label="APR"
                value={row.finance_apr !== null ? `${row.finance_apr}%` : null}
              />
              <DetailRow
                label="Term"
                value={row.finance_term_months !== null ? `${row.finance_term_months} mo` : null}
              />
              <DetailRow label="Down" value={dollarLabel(row.finance_down_payment)} />
              <DetailRow label="Monthly" value={dollarLabel(row.finance_monthly_payment)} />
              <DetailRow
                label="Amount financed"
                value={dollarLabel(row.finance_amount_financed)}
              />
            </dl>
          </div>
        )}

        {hasLease && (
          <div data-testid="quote-detail-lease">
            <h3 className="quote-detail-h3">Lease</h3>
            <dl className="inventory-detail-list">
              <DetailRow
                label="Term"
                value={row.lease_term_months !== null ? `${row.lease_term_months} mo` : null}
              />
              <DetailRow
                label="Money factor"
                value={row.lease_money_factor !== null ? String(row.lease_money_factor) : null}
              />
              <DetailRow
                label="Residual"
                value={row.lease_residual_pct !== null ? `${row.lease_residual_pct}%` : null}
              />
              <DetailRow label="Residual value" value={dollarLabel(row.lease_residual_value)} />
              <DetailRow label="Due at signing" value={dollarLabel(row.lease_due_at_signing)} />
              <DetailRow label="Monthly" value={dollarLabel(row.lease_monthly_payment)} />
              <DetailRow
                label="Miles/year"
                value={
                  row.lease_miles_per_year !== null
                    ? row.lease_miles_per_year.toLocaleString("en-US")
                    : null
                }
              />
            </dl>
          </div>
        )}

        {(readLine !== "" || receivedLine !== null || expiresLine !== null) && (
          <div className="quote-detail-provenance" data-testid="quote-detail-provenance">
            <h3 className="quote-detail-h3">How this was read</h3>
            {readLine !== "" && (
              <p className="muted">
                {readLine}
                {provider !== "" ? ` ${provider}` : ""}
              </p>
            )}
            {receivedLine !== null && <p className="muted">received {receivedLine}</p>}
            {expiresLine !== null && <p className="muted">expires {expiresLine}</p>}
          </div>
        )}

        {hasSource && (
          <div className="quote-detail-source" data-testid="quote-detail-source-email">
            <h3 className="quote-detail-h3">Source email</h3>
            {sourceFrom !== "" && <p className="muted">From {sourceFrom}</p>}
            {row.source_subject !== null && row.source_subject !== "" && (
              <p>
                <strong>{row.source_subject}</strong>
              </p>
            )}
            {row.source_body_text !== null && row.source_body_text !== "" && (
              <details>
                <summary>Show original email</summary>
                <div className="quote-detail-source-body">{row.source_body_text}</div>
              </details>
            )}
          </div>
        )}

        {flags.length > 0 && (
          <div className="quote-detail-audit">
            <h3 className="quote-detail-h3">Checks</h3>
            <div className="chip-row">
              {flags.map((flag) => (
                <span
                  className="mini-chip"
                  key={flag.code}
                  data-testid={`quote-audit-pill-${flag.code}`}
                >
                  {flag.label}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" data-testid="quote-detail-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
