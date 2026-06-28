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

import { Fragment, useId } from "react";

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
  // LABELED markup only (>0). 0/null = "scanned, none" → no row, never a flag.
  const markup =
    typeof row.dealer_markup === "number" && row.dealer_markup > 0 ? row.dealer_markup : null;
  // LABELED dealer discount (>0), recovered by the folded LLM price-block read —
  // the dealer's OWN stated savings off MSRP, distinct from the implied below-MSRP
  // delta. 0/null → no row.
  const dealerDiscount =
    typeof row.dealer_discount === "number" && row.dealer_discount > 0 ? row.dealer_discount : null;
  // A short manufacturer-incentive phrase the LLM read off the price block.
  const incentivesText =
    typeof row.incentives_text === "string" && row.incentives_text.trim() !== ""
      ? row.incentives_text.trim()
      : null;
  // The price stack is shown when there is any price/discount to anchor the
  // (static) rebate caveat to — OR a labeled markup/discount/incentive, so a
  // price-gated VDP that still exposes a "Market Adjustment" renders the RED
  // markup row (the card flags it RED; the modal must not hide the very thing).
  const hasPriceInfo =
    listed !== null ||
    msrp !== null ||
    belowMsrp !== null ||
    markup !== null ||
    dealerDiscount !== null ||
    incentivesText !== null;
  const addOns = Array.isArray(row.add_ons) ? row.add_ons : [];
  const addonsTotal = typeof row.addons_total === "number" ? row.addons_total : null;
  // Severity → token: add-ons are AMBER caution, escalating to RED at a heavy
  // total (the ~$2k/veh benchmark). A labeled markup is always RED.
  const addonsSevere = addonsTotal !== null && addonsTotal >= 2000;
  // Availability reframe: "unknown" is scanner-side uncertainty, NOT a defective
  // car — show a muted "not confirmed by scan" rather than the bare word. Keep
  // in_stock / in_transit / ordered verbatim; never drop the row.
  const availabilityUnknown = row.inventory_status === "unknown";
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
          <DetailRow label="Exterior color" value={row.exterior_color} />
          {row.interior_color !== null && row.interior_color !== "" && (
            <>
              <dt>Interior color</dt>
              <dd data-testid="inventory-detail-interior-color">{row.interior_color}</dd>
            </>
          )}
          <DetailRow label="Dealer" value={row.dealer_name} />
          <DetailRow label="Distance" value={distance} />
          {availabilityUnknown ? (
            <>
              <dt>Availability</dt>
              <dd className="breakdown-soft" data-testid="inventory-detail-availability">
                not confirmed by scan
              </dd>
            </>
          ) : (
            <>
              <dt>Status</dt>
              <dd data-testid="inventory-detail-availability">{row.inventory_status}</dd>
            </>
          )}
        </dl>

        {hasPriceInfo && (
          <>
            <h3 className="quote-detail-h3">Price breakdown</h3>
            <dl className="inventory-detail-list">
              <DetailRow label="MSRP" value={msrp} />
              <DetailRow label="below MSRP" value={belowMsrp} />
              <DetailRow label="Selling price" value={listed} />
              {dealerDiscount !== null && (
                <>
                  <dt>Dealer discount</dt>
                  <dd data-testid="inventory-detail-discount">−{dollarLabel(dealerDiscount)}</dd>
                </>
              )}
              {markup !== null && (
                <>
                  <dt className="breakdown-flag-red">Dealer market adjustment</dt>
                  <dd className="breakdown-flag-red" data-testid="inventory-detail-markup">
                    +{dollarLabel(markup)}
                  </dd>
                </>
              )}
            </dl>
            {incentivesText !== null && (
              <p className="breakdown-note muted" data-testid="inventory-detail-incentives">
                Incentive noted on the listing: {incentivesText}. Confirm eligibility.
              </p>
            )}
            {/* Static rebate caveat — NON-muted (WCAG AA), shown whenever a price
                or discount is shown. Not per-listing detection: advertised prices
                routinely assume rebates most buyers can't claim. */}
            <p className="breakdown-caveat" data-testid="inventory-detail-rebate-caveat">
              Advertised prices often assume rebates (military / loyalty / financing)
              most buyers don&apos;t qualify for. Confirm your real quote.
            </p>
          </>
        )}

        {/* Add-on coverage state — an empty section must NEVER imply a clean car.
            couldn't-read (conspicuous) vs none-detected vs the itemized list. */}
        {row.breakdown_parsed === false ? (
          <p className="breakdown-unknown" data-testid="inventory-detail-breakdown-unknown">
            Couldn&apos;t read a price breakdown: markup and add-ons UNKNOWN. Verify on
            the dealer&apos;s site.
          </p>
        ) : addOns.length === 0 ? (
          <p className="breakdown-note muted" data-testid="inventory-detail-no-addons">
            No dealer add-ons detected.
          </p>
        ) : (
          <div
            className={`breakdown-addons ${addonsSevere ? "sev-red" : "sev-amber"}`}
            data-testid="inventory-detail-addons"
          >
            <h3 className="quote-detail-h3">Dealer add-ons</h3>
            <dl className="inventory-detail-list breakdown-addon-list">
              {addOns.map((addOn, i) => (
                <Fragment key={`${addOn.label}-${i}`}>
                  <dt>{addOn.label}</dt>
                  <dd data-testid="inventory-detail-addon">{dollarLabel(addOn.amount)}</dd>
                </Fragment>
              ))}
              {addonsTotal !== null && (
                <>
                  <dt>Add-ons total</dt>
                  <dd data-testid="inventory-detail-addons-total">
                    <strong>{dollarLabel(addonsTotal)}</strong>
                  </dd>
                </>
              )}
            </dl>
          </div>
        )}

        {row.price_gated === true && (
          <p className="breakdown-note" data-testid="inventory-detail-price-gated">
            Price hidden behind a &quot;Get your price&quot; CTA.
          </p>
        )}
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
