/**
 * Incentives — the READ-ONLY manufacturer-incentive projection on the workbench
 * canvas. After the incentive_scrape skill captures + saves the cash incentives
 * for the active search's vehicle (the manufacturer_incentives rows keyed on the
 * profile's make/model/zip), they surface here: one row per offer with the
 * program type, the cash amount, the eligibility, an expiry, and a small
 * source-url provenance line.
 *
 * Cash incentives ONLY (the slice the audit's MISSING_REBATE check reads from):
 * these are public manufacturer offers for the vehicle, never a negotiated
 * dealer quote and never a per-dealer number — distinct from the Extracted
 * quotes and Quote compare sections above.
 *
 * Budget red line: a row renders the program type, the cash amount (formatted
 * dollars, no cents), the eligibility, the expiry and the provenance line —
 * NEVER a budget, NEVER a raw id (id is the React key only). Presentational
 * ONLY: it takes its rows as a PROP (an AsyncState the host wires from the
 * incentives route) and knows nothing about the API client. LIGHT paper skin,
 * mirroring the threads + quotes + inventory-candidates sections.
 */

import { useState } from "react";

import type { AsyncState } from "../api/useApi.js";
import type { IncentiveList, IncentiveRow } from "../api/wire.js";
import { ClickableTile } from "./ClickableTile.js";
import { IncentiveDetailModal } from "./IncentiveDetailModal.js";

/** A "$2,500" cash label from a number (no cents noise), or null for a missing
 *  amount. */
export function dollarLabel(value: number | null): string | null {
  if (value === null) return null;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/** The "expires 2026-07-31" line from a raw expiry, dropping a missing one. */
export function expiryLine(expires: string | null): string {
  return expires !== null && expires !== "" ? `expires ${expires}` : "";
}

function IncentiveRowView({
  row,
  onActivate,
}: {
  row: IncentiveRow;
  onActivate: () => void;
}): JSX.Element {
  const amount = dollarLabel(row.amount);
  const expiry = expiryLine(row.expires);
  return (
    <ClickableTile
      testid="canvas-incentive-row"
      ariaLabel={`View details for ${row.type ?? "Incentive"}`}
      onActivate={onActivate}
    >
      <div className="t-head">
        <span data-testid="canvas-incentive-type">{row.type ?? "Incentive"}</span>
        {amount !== null && (
          <span className="mini-chip" data-testid="canvas-incentive-amount">
            {amount}
          </span>
        )}
      </div>
      {row.eligibility !== null && row.eligibility !== "" && (
        <div className="t-status" data-testid="canvas-incentive-eligibility">
          {row.eligibility}
        </div>
      )}
      {expiry !== "" && (
        <div className="t-status muted" data-testid="canvas-incentive-expiry">
          {expiry}
        </div>
      )}
      {row.scrape_source_url !== null && row.scrape_source_url !== "" && (
        <div className="t-status muted" data-testid="canvas-incentive-source">
          via {row.scrape_source_url}
        </div>
      )}
    </ClickableTile>
  );
}

export interface IncentivesProps {
  /** The profile's manufacturer-incentive rows (the host wires this from the
   *  incentives route). */
  incentives: AsyncState<IncentiveList>;
}

export function Incentives({ incentives }: IncentivesProps): JSX.Element {
  // The incentive whose read-only detail modal is open (null = closed).
  const [detail, setDetail] = useState<IncentiveRow | null>(null);
  return (
    <section data-testid="canvas-incentives">
      <h2>Incentives</h2>
      {incentives.kind === "loading" && <p className="muted">Loading incentives…</p>}
      {incentives.kind === "error" && (
        <p className="danger-text" role="alert">
          Couldn&apos;t load incentives: {incentives.message}
        </p>
      )}
      {incentives.kind === "ok" && incentives.data.length === 0 && (
        <p className="muted" data-testid="canvas-incentives-empty">
          No incentives yet — check for manufacturer rebates and offers on this
          vehicle.
        </p>
      )}
      {incentives.kind === "ok" && incentives.data.length > 0 && (
        <div className="tile-grid">
          {incentives.data.map((row) => (
            <IncentiveRowView key={row.id} row={row} onActivate={() => setDetail(row)} />
          ))}
        </div>
      )}
      <IncentiveDetailModal row={detail} onClose={() => setDetail(null)} />
    </section>
  );
}
