/**
 * InventoryCandidates — the READ-ONLY "Inventory candidates" projection on the
 * workbench canvas. After the inventory scans collect public-website listings,
 * the /inventory_compare ranker scores them against the active search and the
 * top candidates surface here, each with a rank-reason chip row, a match-status
 * chip, the full VIN, the stock number, the listed price, and the dealer +
 * distance.
 *
 * LISTINGS ≠ QUOTES (load-bearing): these are public-website inventory
 * candidates ranked against the profile, NOT negotiated out-the-door quotes.
 * The heading reads "Inventory candidates" — NEVER "quotes" / "offers". There is
 * NO audit pill here (audit flags belong to the quote surfaces, not listings).
 *
 * Budget red line: a candidate renders the vehicle, the full VIN, the stock
 * number, the LISTED price (a public sticker, never an internal budget), the
 * dealer + distance, and the rank reasons — NEVER a budget. A null listed_price
 * renders an "incomplete" badge, never a fabricated number; a null stock_number
 * renders an em-dash. Presentational ONLY: it takes its rows as a PROP (an
 * AsyncState the host wires from the ranker route) and knows nothing about the
 * API client. LIGHT paper skin, mirroring the threads + dealer-tiles sections.
 */

import type { AsyncState } from "../api/useApi.js";
import type { InventoryCompareResult } from "../api/wire.js";

/** One ranked candidate the section renders. Extra server fields are tolerated
 *  and ignored. */
export interface InventoryCandidate {
  listing_id: string;
  vin: string | null;
  stock_number: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  exterior_color: string | null;
  listed_price: number | null;
  dealer_name: string | null;
  distance_miles: number | null;
  reasons: string[];
  match_status: string;
  [key: string]: unknown;
}

/** "2026 Hyundai Tucson Limited"-style label from the candidate's identity
 *  fields (any null/empty part is dropped). */
function vehicleHeader(c: InventoryCandidate): string {
  return [c.year !== null ? String(c.year) : null, c.make, c.model, c.trim]
    .filter((x): x is string => x !== null && x !== "")
    .join(" ");
}

/** A "$44,175" price label from a number, or null for a missing price. */
function priceLabel(value: number | null): string | null {
  if (value === null) return null;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/** A "5.2 mi" distance label, or null when unknown. */
function distanceLabel(value: number | null): string | null {
  if (value === null) return null;
  return `${value.toFixed(1)} mi`;
}

function CandidateRow({ row }: { row: InventoryCandidate }): JSX.Element {
  const header = vehicleHeader(row) || "Inventory listing";
  const price = priceLabel(row.listed_price);
  const distance = distanceLabel(row.distance_miles);
  return (
    <div className="tile" data-testid="inventory-candidate-row">
      <div className="t-head">
        <span>{header}</span>
        <span
          className={`mini-chip inventory-match-${row.match_status}`}
          data-testid="inventory-match-status"
        >
          {row.match_status}
        </span>
      </div>
      <div className="t-addr">
        VIN <span data-testid="inventory-candidate-vin">{row.vin ?? "—"}</span>
        {" · stock "}
        {row.stock_number !== null && row.stock_number !== "" ? (
          <span data-testid="inventory-stock">{row.stock_number}</span>
        ) : (
          // A missing stock number renders an em-dash (never fabricated). A
          // dedicated testid lets a test assert the em-dash regardless of which
          // rank position the no-stock listing lands in.
          <span data-testid="inventory-stock-missing">—</span>
        )}
      </div>
      <div className="t-status">
        {price !== null ? (
          <span>{price}</span>
        ) : (
          <span className="mini-chip" data-testid="inventory-incomplete-badge">
            incomplete
          </span>
        )}
        {row.dealer_name !== null && row.dealer_name !== "" && (
          <span className="muted"> · {row.dealer_name}</span>
        )}
        {distance !== null && <span className="muted"> · {distance}</span>}
      </div>
      {row.reasons.length > 0 && (
        <div className="chip-row">
          {row.reasons.map((reason) => (
            <span className="mini-chip" key={reason} data-testid="inventory-reason-chip">
              {reason}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export interface InventoryCandidatesProps {
  /** The profile's ranked candidates (the host wires this from the ranker route). */
  inventory: AsyncState<InventoryCompareResult>;
}

export function InventoryCandidates({ inventory }: InventoryCandidatesProps): JSX.Element {
  const candidates =
    inventory.kind === "ok" ? (inventory.data.candidates as InventoryCandidate[]) : [];
  return (
    <section data-testid="canvas-inventory-candidates">
      <h2>Inventory candidates</h2>
      {inventory.kind === "loading" && <p className="muted">Loading inventory…</p>}
      {inventory.kind === "error" && (
        <p className="danger-text" role="alert">
          Couldn&apos;t load inventory: {inventory.message}
        </p>
      )}
      {inventory.kind === "ok" && candidates.length === 0 && (
        <p className="muted" data-testid="canvas-inventory-empty">
          Listed 0 inventory candidates (recommended: 0).
        </p>
      )}
      {inventory.kind === "ok" && candidates.length > 0 && (
        <div className="tile-grid">
          {candidates.map((row) => (
            <CandidateRow key={row.listing_id} row={row} />
          ))}
        </div>
      )}
    </section>
  );
}
