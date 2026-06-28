/**
 * NegotiationsBoard — the READ-ONLY per-dealership negotiation board on the
 * canvas "Negotiations" tab. One card per bound dealer, derived each read:
 * the dealer name + a negotiation_status chip, a quote-received / lead-submitted /
 * give-up verdict chip row, and the four per-metric tallies (emails exchanged,
 * quote received, best OTD, best discount). The whole card is clickable → the
 * read-only NegotiationDetailModal.
 *
 * Cards are sorted most-actionable first (NEGOTIATION_STATUS_RANK asc, then the
 * BATNA gap desc, then name) and the top (countered / stalled) cards wear a
 * stronger "needs you now" accent. The card-vs-server sort is idempotent — the
 * grid read already orders by the same key, so re-sorting here is a no-op safety
 * net that also keeps the component deterministic in isolation.
 *
 * Budget red line: a card renders only dealer-side facts + scalars — NEVER a
 * budget, NEVER a bare id (dealer_id is the React key only), NEVER a competing
 * dealer's name. A null OTD/discount shows an honest "—", never a fabricated
 * number. Presentational: it takes its rows as a PROP (an AsyncState the host
 * wires from the dealer-negotiations route) plus optional per-dealer detail /
 * summary fetchers for the modal.
 */

import { useState } from "react";

import type { AsyncState } from "../api/useApi.js";
import { useAsync } from "../api/useApi.js";
import type {
  DealerNegotiationDetail,
  DealerNegotiationList,
  DealerNegotiationRow,
  DealerNegotiationSummary,
} from "../api/wire.js";
import { ClickableTile } from "./ClickableTile.js";
import { dollarLabel } from "./format.js";
import { NegotiationDetailModal } from "./NegotiationDetailModal.js";
import { Pager } from "./Pager.js";
import { STATUS_LABEL } from "./ThreadsSection.js";
import { usePagedList } from "./usePagedList.js";

/** Actionability rank — lower = more attention needed (the buyer should act).
 *  Mirrors the server grid sort so re-sorting here is idempotent. */
const NEGOTIATION_STATUS_RANK: Record<string, number> = {
  countered: 0,
  stalled: 1,
  quoted: 2,
  replied: 3,
  lead_sent: 4,
  dormant: 5,
  agreed: 6,
  dead: 7,
};

function rankOf(ns: string | null | undefined): number {
  return ns != null && ns in NEGOTIATION_STATUS_RANK ? NEGOTIATION_STATUS_RANK[ns]! : 99;
}

/** A "needs you now" card — the dealer is conceding (countered) or has gone
 *  quiet at the table (stalled); either way the buyer should reply. */
function needsYouNow(ns: string | null | undefined): boolean {
  return ns === "countered" || ns === "stalled";
}

/** Sort most-actionable first: rank asc → BATNA gap desc (null last) → name. */
function sortNegotiations(rows: DealerNegotiationList): DealerNegotiationList {
  return rows.slice().sort((a, b) => {
    const r = rankOf(a.negotiation_status) - rankOf(b.negotiation_status);
    if (r !== 0) return r;
    const ga = a.batna_gap_usd ?? Number.NEGATIVE_INFINITY;
    const gb = b.batna_gap_usd ?? Number.NEGATIVE_INFINITY;
    if (gb !== ga) return gb - ga;
    return (a.name ?? "").localeCompare(b.name ?? "");
  });
}

function NegotiationCard({
  row,
  onActivate,
}: {
  row: DealerNegotiationRow;
  onActivate: () => void;
}): JSX.Element {
  const name = row.name ?? "Unknown dealer";
  const statusKey = row.negotiation_status ?? null;
  const statusLabel = statusKey !== null ? (STATUS_LABEL[statusKey] ?? statusKey) : null;
  const needsYou = needsYouNow(statusKey);
  const verdict = row.verdict;
  const batnaGap = row.batna_gap_usd ?? null;
  const verdictReason = row.verdict_reason;
  const extractFailed = row.extract_failed_count > 0;
  const otd = dollarLabel(row.best_otd);
  const discount = dollarLabel(row.best_discount);

  return (
    <ClickableTile
      testid="canvas-negotiation-card"
      ariaLabel={`View the negotiation with ${name}`}
      onActivate={onActivate}
      {...(needsYou ? { className: "negotiation-needs-you" } : {})}
    >
      <div className="t-head">
        <h3 className="negotiation-card-name">{name}</h3>
        {statusLabel !== null && (
          <span className={`mini-chip thread-class-${statusKey}`} data-testid="negotiation-status-chip">
            {statusLabel}
          </span>
        )}
      </div>

      <div className="chip-row">
        {row.quote_sent && <span className="mini-chip">quote received</span>}
        {row.lead_submission_count > 0 && <span className="mini-chip">lead submitted</span>}
        {verdict === "give_up_switch" && (
          <span className="mini-chip warn" data-testid="negotiation-verdict-switch">
            consider switching
            {batnaGap !== null ? ` · ${dollarLabel(batnaGap)} cheaper elsewhere` : ""}
          </span>
        )}
        {verdict === "hold" && (
          <span className="mini-chip" data-testid="negotiation-verdict-hold">
            {verdictReason === "unanswered_cap"
              ? "paused"
              : verdictReason === "silent"
                ? "gone quiet"
                : "not moving"}
          </span>
        )}
        {/* A dealer reply failed quote extraction (the dealer_reply_extract skill
            flips messages.quote_extraction_status to 'failed', even after its
            automatic same-provider recovery hop). */}
        {extractFailed && (
          <span className="mini-chip" data-testid="message-extract-failed-badge">
            extraction failed
          </span>
        )}
      </div>

      <div className="negotiation-metrics">
        <span className="negotiation-metric" data-testid="canvas-negotiation-email-count">
          <span className="negotiation-metric-label">Emails</span> {row.email_count}
        </span>
        <span className="negotiation-metric" data-testid="canvas-negotiation-quote-sent">
          <span className="negotiation-metric-label">Quote</span> {row.quote_sent ? "yes" : "no"}
        </span>
        <span className="negotiation-metric" data-testid="canvas-negotiation-otd">
          <span className="negotiation-metric-label">Best OTD</span> {otd ?? "—"}
        </span>
        <span className="negotiation-metric" data-testid="canvas-negotiation-discount">
          <span className="negotiation-metric-label">Discount</span> {discount ?? "—"}
        </span>
      </div>
    </ClickableTile>
  );
}

// A stable module-level empty list so usePagedList's items reference is stable
// while rows are loading/errored (avoids a page reset on every render).
const NO_ROWS: DealerNegotiationList = [];
const PAGE_SIZE = 12;

export function NegotiationsBoard({
  negotiations,
  dealerCount,
  fetchDetail,
  fetchSummary,
}: {
  negotiations: AsyncState<DealerNegotiationList>;
  /** Contacted-dealer count for the empty wait-state copy. */
  dealerCount: number;
  /** Fetch the one-dealer detail the modal renders (bound to the active profile
   *  by the host). Absent in isolation tests → the card opens nothing. */
  fetchDetail?: (dealerId: string) => Promise<DealerNegotiationDetail>;
  /** Fetch the lazy LLM summary for the open dealer (bound to the active profile). */
  fetchSummary?: (dealerId: string) => Promise<DealerNegotiationSummary>;
}): JSX.Element {
  const sorted = negotiations.kind === "ok" ? sortNegotiations(negotiations.data) : NO_ROWS;
  // The dealer whose detail modal is open (null = closed).
  const [openId, setOpenId] = useState<string | null>(null);
  const pager = usePagedList(sorted, PAGE_SIZE);

  // The open dealer's detail, fetched on demand. Idle (loading) until a card is
  // activated; the modal stays closed until the detail resolves.
  const detail = useAsync<DealerNegotiationDetail>(
    () => fetchDetail!(openId!),
    [openId],
    openId !== null && fetchDetail !== undefined,
  );

  // The modal is open IFF the user has a card open (`openId`) AND we hold THAT
  // dealer's detail — `openId` (user intent) is authoritative, never the fetch
  // cache. useAsync is stale-while-revalidate: it KEEPS the last `ok` data after
  // a card closes (a disabled re-run does not reset it), and a data.changed pulse
  // can refetch it — so gating the modal on `detail.kind === "ok"` alone left
  // Close/Escape/backdrop unable to dismiss it and let a background refresh
  // re-open it. Requiring `openId !== null` makes close truly close; the
  // `dealer_id === openId` match also avoids briefly showing a prior dealer's
  // stale detail when reopening a different card before its fetch resolves.
  const openDetail =
    openId !== null && detail.kind === "ok" && detail.data.dealer_id === openId
      ? detail.data
      : null;

  return (
    <section data-testid="canvas-negotiations">
      <h2>Negotiations</h2>
      {negotiations.kind === "loading" && <p className="muted">Loading negotiations…</p>}
      {negotiations.kind === "error" && (
        <p className="danger-text" role="alert">
          Couldn&apos;t load negotiations: {negotiations.message}
        </p>
      )}
      {negotiations.kind === "ok" && negotiations.data.length === 0 && (
        <p className="muted" data-testid="canvas-negotiations-empty">
          No negotiations yet — you&apos;ve contacted {dealerCount} dealers; replies usually arrive
          in 1–3 days.
        </p>
      )}
      {negotiations.kind === "ok" && negotiations.data.length > 0 && (
        <>
          <div className="tile-grid" data-testid="canvas-negotiation-grid">
            {pager.pageItems.map((row) => (
              <NegotiationCard key={row.dealer_id} row={row} onActivate={() => setOpenId(row.dealer_id)} />
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
      <NegotiationDetailModal
        detail={openDetail}
        {...(openDetail !== null && fetchSummary !== undefined
          ? { fetchSummary: (): Promise<DealerNegotiationSummary> => fetchSummary(openDetail.dealer_id) }
          : {})}
        onClose={() => setOpenId(null)}
      />
    </section>
  );
}
