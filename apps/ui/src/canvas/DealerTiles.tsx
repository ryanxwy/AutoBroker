/**
 * DealerTiles — the READ-ONLY "Dealers" projection on the workbench canvas,
 * materialized from the profile_dealers rows. Each dealer surfaces as a tile
 * (rank, name, distance, address, candidate status, and a "lead submitted" chip
 * when a lead has been sent). The whole tile is clickable → a read-only detail
 * modal that restates the dealer's public facts (full address, phone, rating,
 * website) before the buyer calls or clicks through.
 *
 * Budget red line: a tile renders only public dealer facts — NEVER a budget,
 * NEVER a bare id (dealer_id is the React key only). A null/empty field is
 * dropped, never fabricated. Presentational ONLY: it takes its rows as a PROP
 * (an AsyncState the host wires from the dealers route) and knows nothing about
 * the API client.
 */

import { useState } from "react";

import type { AsyncState } from "../api/useApi.js";
import type { DealerList, DealerRow } from "../api/wire.js";
import { ClickableTile } from "./ClickableTile.js";
import { DealerDetailModal } from "./DealerDetailModal.js";
import { num, str } from "./dealerFields.js";
import { Pager } from "./Pager.js";
import { usePagedList } from "./usePagedList.js";

function DealerTile({
  row,
  rank,
  onActivate,
}: {
  row: DealerRow;
  rank: number;
  onActivate: () => void;
}): JSX.Element {
  const distance = num(row, "distance_miles");
  const name = str(row, "name") ?? "Unknown dealer";
  // Derived-on-read give-up advisory (present only for dealers with an active
  // thread). Budget-free: only a dealer-side "$N cheaper elsewhere" gap, no
  // competing dealer name, no budget. `continue` renders no chip (the default).
  const verdict = str(row, "verdict");
  const batnaGap = num(row, "batna_gap_usd");
  const verdictReason = str(row, "verdict_reason");
  return (
    <ClickableTile
      testid="canvas-dealer-tile"
      ariaLabel={`View details for ${name}`}
      onActivate={onActivate}
    >
      <div className="t-head">
        <span>
          {rank}. {name}
        </span>
        {distance !== null && <span className="muted">{distance.toFixed(1)} mi</span>}
      </div>
      {str(row, "address") !== null && <div className="t-addr">{str(row, "address")}</div>}
      <div className="t-status">
        {str(row, "candidate_status") ?? "candidate"}
        {(num(row, "lead_submission_count") ?? 0) > 0 && (
          <span className="mini-chip" data-testid="dealer-lead-submitted">
            {" "}
            lead submitted
          </span>
        )}
        {verdict === "give_up_switch" && (
          <span className="mini-chip warn" data-testid="dealer-verdict-switch">
            {" "}
            consider switching
            {batnaGap !== null ? ` · $${Math.round(batnaGap).toLocaleString("en-US")} cheaper elsewhere` : ""}
          </span>
        )}
        {verdict === "hold" && (
          <span className="mini-chip" data-testid="dealer-verdict-hold">
            {" "}
            {verdictReason === "unanswered_cap"
              ? "paused"
              : verdictReason === "silent"
                ? "gone quiet"
                : "not moving"}
          </span>
        )}
      </div>
    </ClickableTile>
  );
}

// A stable module-level empty list so usePagedList's items reference is stable
// while dealers are loading/errored (avoids a page reset on every render).
const NO_DEALERS: DealerList = [];
const DEALER_PAGE_SIZE = 12;

export function DealerTiles({ dealers }: { dealers: AsyncState<DealerList> }): JSX.Element {
  const rows = dealers.kind === "ok" ? dealers.data : NO_DEALERS;
  // The dealer whose read-only detail modal is open (null = closed).
  const [detail, setDetail] = useState<DealerRow | null>(null);
  // A metro at the 125mi default can surface 30+ dealers — paginate like the
  // Inventory/Replies tabs so the list stays scannable for a non-technical buyer.
  const pager = usePagedList(rows, DEALER_PAGE_SIZE);
  return (
    <section data-testid="canvas-dealer-tiles">
      <h2>Dealers</h2>
      {dealers.kind === "loading" && <p className="muted">Loading dealers…</p>}
      {dealers.kind === "error" && (
        <p className="danger-text" role="alert">
          Couldn&apos;t load dealers: {dealers.message}
        </p>
      )}
      {dealers.kind === "ok" && rows.length === 0 && (
        <p className="muted" data-testid="canvas-dealers-empty">
          No dealers yet — search for dealers near you to get started.
        </p>
      )}
      {dealers.kind === "ok" && rows.length > 0 && (
        <>
          <div className="tile-grid">
            {pager.pageItems.map((row, i) => (
              <DealerTile
                key={str(row, "dealer_id") ?? String(pager.rangeStart + i)}
                row={row}
                rank={pager.rangeStart + i}
                onActivate={() => setDetail(row)}
              />
            ))}
          </div>
          <Pager
            page={pager.page}
            pageCount={pager.pageCount}
            total={pager.total}
            rangeStart={pager.rangeStart}
            rangeEnd={pager.rangeEnd}
            onPrev={pager.prev}
            onNext={pager.next}
            canPrev={pager.canPrev}
            canNext={pager.canNext}
            noun="dealers"
          />
        </>
      )}
      <DealerDetailModal row={detail} onClose={() => setDetail(null)} />
    </section>
  );
}
