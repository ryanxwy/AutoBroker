/**
 * InventoryDetailModal — the read-only "double-check" detail surface a buyer
 * opens by clicking an Inventory candidate tile. It restates the SAME public
 * inventory-listing fields the tile carries, laid out as a calm label/value
 * list so a non-technical buyer can verify VIN, stock number, listed price, and
 * dealer before clicking through to the dealer's VDP.
 *
 * LISTINGS ≠ QUOTES (load-bearing): every word here is "Inventory listing", NEVER
 * "quote" / "offer". Budget red line: it shows the public LISTED price (and the
 * MSRP / implied below-MSRP discount when the server supplied both) — NEVER a
 * budget, NEVER a bare id. A null/empty field omits its row rather than
 * fabricating a value. Presentational only: it takes one candidate row as a prop
 * and knows nothing about the API client.
 */

import { useId } from "react";

import { Modal } from "../shell/Modal.js";
import { DetailRow } from "./DetailRow.js";
import { distanceLabel, dollarLabel } from "./format.js";
import { type InventoryCandidate, vehicleHeader } from "./InventoryCandidates.js";

export function InventoryDetailModal({
  row,
  onClose,
}: {
  row: InventoryCandidate | null;
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

  const header = vehicleHeader(row) || "Inventory listing";
  const listed = dollarLabel(row.listed_price);
  const msrp = dollarLabel(row.msrp);
  const belowMsrp =
    row.msrp !== null && row.listed_price !== null && row.msrp > row.listed_price
      ? dollarLabel(row.msrp - row.listed_price)
      : null;
  const distance = distanceLabel(row.distance_miles);
  // Only ever link to an http(s) VDP — the same external-link discipline the
  // Dealer/Incentive modals use (defense-in-depth even though listing_url comes
  // from the trusted site-scan ranker, never free user input).
  const hasListingUrl =
    typeof row.listing_url === "string" && /^https?:\/\//i.test(row.listing_url);

  return (
    <Modal open onClose={onClose} labelId={titleId} variant="dialog">
      <div data-testid="inventory-detail-modal">
        <h2 id={titleId} data-testid="inventory-detail-title">
          {header}
        </h2>
        <div className="chip-row">
          <span
            className={`mini-chip inventory-match-${row.match_status}`}
            data-testid="inventory-detail-match-status"
          >
            {row.match_status}
          </span>
          {row.recommended && (
            <span className="mini-chip" data-testid="inventory-detail-recommended">
              recommended
            </span>
          )}
        </div>
        <dl className="inventory-detail-list">
          <DetailRow label="VIN" value={row.vin} />
          <DetailRow label="Stock #" value={row.stock_number} />
          <DetailRow label="Listed price" value={listed} />
          <DetailRow label="MSRP" value={msrp} />
          <DetailRow label="below MSRP" value={belowMsrp} />
          <DetailRow label="Color" value={row.exterior_color} />
          <DetailRow label="Status" value={row.inventory_status} />
          <DetailRow label="Dealer" value={row.dealer_name} />
          <DetailRow label="Distance" value={distance} />
        </dl>
        {row.reasons.length > 0 && (
          <div className="chip-row">
            {row.reasons.map((reason) => (
              <span
                className="mini-chip"
                key={reason}
                data-testid="inventory-detail-reason-chip"
              >
                {reason}
              </span>
            ))}
          </div>
        )}
        <div className="modal-foot">
          {hasListingUrl && (
            <a
              href={row.listing_url as string}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="inventory-detail-listing-link"
              className="btn-primary"
            >
              View listing ↗
            </a>
          )}
          <span className="spacer" />
          <button type="button" data-testid="inventory-detail-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
