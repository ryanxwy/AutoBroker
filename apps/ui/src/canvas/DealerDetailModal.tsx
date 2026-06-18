/**
 * DealerDetailModal — the read-only "double-check" detail surface a buyer opens
 * by clicking a Dealer tile. It restates the SAME public dealer fields the tile
 * carries (name, full address, phone, rating, distance, candidate status, the
 * lead-submitted state), laid out as a calm label/value list so a non-technical
 * buyer can verify the dealer before calling or clicking through to its website.
 *
 * Budget red line: it shows only public dealer facts — NEVER a budget, NEVER a
 * bare id (dealer_id is the tile's React key only). A null/empty field omits its
 * row rather than fabricating a value. Presentational only: it takes one dealer
 * row as a prop and knows nothing about the API client.
 */

import { useId } from "react";

import type { DealerRow } from "../api/wire.js";
import { Modal } from "../shell/Modal.js";
import { num, str } from "./dealerFields.js";
import { DetailRow } from "./DetailRow.js";

export function DealerDetailModal({
  row,
  onClose,
}: {
  row: DealerRow | null;
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

  const name = str(row, "name") ?? "Dealer";
  const address = [
    str(row, "address"),
    str(row, "city"),
    str(row, "state"),
    str(row, "postal_code"),
  ]
    .filter((x): x is string => x !== null)
    .join(", ");
  const phone = str(row, "phone");
  const rating = num(row, "rating");
  const reviewCount = num(row, "review_count");
  const distance = num(row, "distance_miles");
  const leadSubmitted = (num(row, "lead_submission_count") ?? 0) > 0;
  const website = str(row, "website");
  const hasWebsite = website !== null && /^https?:\/\//i.test(website);

  return (
    <Modal open onClose={onClose} labelId={titleId} variant="dialog">
      <div data-testid="dealer-detail-modal">
        <h2 id={titleId} data-testid="dealer-detail-title">
          {name}
        </h2>
        <div className="chip-row">
          {rating !== null && (
            <span className="mini-chip" data-testid="dealer-detail-rating">
              {rating.toFixed(1)} ★{reviewCount !== null && ` · ${reviewCount} reviews`}
            </span>
          )}
          {leadSubmitted && (
            <span className="mini-chip" data-testid="dealer-detail-lead-submitted">
              lead submitted
            </span>
          )}
        </div>
        <dl className="inventory-detail-list">
          <DetailRow label="Address" value={address === "" ? null : address} />
          {phone !== null && (
            <>
              <dt>Phone</dt>
              <dd>
                <a href={`tel:${phone}`} data-testid="dealer-detail-phone">
                  {phone}
                </a>
              </dd>
            </>
          )}
          <DetailRow label="Distance" value={distance !== null ? `${distance.toFixed(1)} mi` : null} />
          <DetailRow label="Status" value={str(row, "candidate_status")} />
        </dl>
        <div className="modal-foot">
          {hasWebsite && (
            <a
              href={website}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="dealer-detail-website"
              className="btn-primary"
            >
              Visit dealer website ↗
            </a>
          )}
          <span className="spacer" />
          <button type="button" data-testid="dealer-detail-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
