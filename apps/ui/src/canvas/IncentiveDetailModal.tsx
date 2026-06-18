/**
 * IncentiveDetailModal — the read-only "double-check" detail surface a buyer
 * opens by clicking an Incentive row. It restates the SAME public manufacturer-
 * offer fields the row carries (program type, cash amount, eligibility, expiry,
 * and when it was captured), laid out as a calm label/value list before the
 * buyer clicks through to the manufacturer's official offer page.
 *
 * Cash incentives ONLY — public manufacturer offers, never a negotiated dealer
 * quote. Budget red line: NEVER a budget, NEVER a bare id (the id is the row's
 * React key only). A null/empty field omits its row rather than fabricating a
 * value. Presentational only: it takes one incentive row as a prop and knows
 * nothing about the API client.
 */

import { useId } from "react";

import type { IncentiveRow } from "../api/wire.js";
import { Modal } from "../shell/Modal.js";
import { DetailRow } from "./DetailRow.js";
import { dollarLabel, expiryLine } from "./format.js";

export function IncentiveDetailModal({
  row,
  onClose,
}: {
  row: IncentiveRow | null;
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

  const amount = dollarLabel(row.amount);
  const expiry = expiryLine(row.expires);
  const captured = row.scraped_at !== null && row.scraped_at !== "" ? row.scraped_at : null;
  const hasSource =
    row.scrape_source_url !== null && /^https?:\/\//i.test(row.scrape_source_url);

  return (
    <Modal open onClose={onClose} labelId={titleId} variant="dialog">
      <div data-testid="incentive-detail-modal">
        <h2 id={titleId} data-testid="incentive-detail-title">
          {row.type ?? "Incentive"}
        </h2>
        {amount !== null && (
          <div className="chip-row">
            <span className="mini-chip" data-testid="incentive-detail-amount">
              {amount}
            </span>
          </div>
        )}
        <dl className="inventory-detail-list">
          <DetailRow label="Eligibility" value={row.eligibility} />
        </dl>
        {expiry !== "" && (
          <p className="t-status muted" data-testid="incentive-detail-expiry">
            {expiry}
          </p>
        )}
        {captured !== null && (
          <p className="muted" data-testid="incentive-detail-captured">
            captured {captured}
          </p>
        )}
        <div className="modal-foot">
          {hasSource && (
            <a
              href={row.scrape_source_url as string}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="incentive-detail-source"
              className="btn-primary"
            >
              View official offer ↗
            </a>
          )}
          <span className="spacer" />
          <button type="button" data-testid="incentive-detail-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
