/**
 * ThreadsSection — the READ-ONLY "Dealer replies" projection on the workbench
 * canvas. The first email/threads surface: after the inbox-pull skill syncs and
 * the user approves a batch, the saved dealer replies surface here with a
 * quoted/replied classification chip and a relative date.
 *
 * Presentational ONLY: it takes its thread rows as a PROP (an AsyncState the
 * host wires from the profile threads route) plus the contacted-dealer count
 * for the empty wait-state copy. It opens no connection and knows nothing about
 * the API client.
 *
 * Budget red line: a thread row renders the dealer name, a subject snippet, the
 * classification chip, a relative date and (when extraction failed for any of
 * its messages, even after the skill's automatic same-provider recovery hop) a
 * "extraction failed, will retry" badge — NEVER a budget, NEVER a raw id. LIGHT
 * paper skin, mirroring the dealer-tiles section.
 */

import type { AsyncState } from "../api/useApi.js";
import { relativeDate } from "./format.js";
import { Pager } from "./Pager.js";
import { usePagedList } from "./usePagedList.js";

/** One thread row the section renders. A local row type — the section never
 *  imports the wire schema (that lands when the route is wired). Extra server
 *  fields are tolerated and ignored. `extract_failed` rides through the
 *  passthrough wire as the SQLite EXISTS result (0|1 over the wire, true in a
 *  hand-built test row) — the render coerces it truthily. */
export interface ThreadRow {
  thread_id: string;
  dealer_name: string | null;
  subject: string | null;
  state: string | null;
  updated_at: string | null;
  extract_failed?: boolean;
  [key: string]: unknown;
}

export type ThreadRowList = ThreadRow[];

/** A reply is "quoted" when its stored state names a price/quote signal, else
 *  "replied". The inbox skill stamps the thread state with the classification. */
function classificationOf(row: ThreadRow): "quoted" | "replied" {
  return row.state === "quoted" ? "quoted" : "replied";
}

function ThreadRowView({ row }: { row: ThreadRow }): JSX.Element {
  const cls = classificationOf(row);
  const when = relativeDate(row.updated_at);
  return (
    <div className="tile" data-testid="canvas-thread-row">
      <div className="t-head">
        <span>{row.dealer_name ?? "Unknown dealer"}</span>
        <span className={`mini-chip thread-class-${cls}`} data-testid="thread-class-chip">
          {cls}
        </span>
      </div>
      {row.subject !== null && row.subject !== "" && <div className="t-addr">{row.subject}</div>}
      {when !== "" && <div className="t-status muted">{when}</div>}
      {/* A message in this thread failed quote extraction (the dealer_reply_extract
          skill flips messages.quote_extraction_status to 'failed'). The flag rides
          the passthrough wire as a 0|1 int, so coerce truthily. */}
      {Boolean(row.extract_failed) && (
        <span className="mini-chip" data-testid="message-extract-failed-badge">
          extraction failed, will retry
        </span>
      )}
    </div>
  );
}

export interface ThreadsSectionProps {
  /** The profile's thread rows (the host wires this from the threads route). */
  threads: AsyncState<ThreadRowList>;
  /** How many dealers the user has contacted (for the empty wait-state copy). */
  dealerCount: number;
}

const PAGE_SIZE = 10;

export function ThreadsSection({ threads, dealerCount }: ThreadsSectionProps): JSX.Element {
  const allThreads = threads.kind === "ok" ? threads.data : [];
  const pager = usePagedList(allThreads, PAGE_SIZE);

  return (
    <section data-testid="canvas-threads">
      <h2>Dealer replies</h2>
      {threads.kind === "loading" && <p className="muted">Loading replies…</p>}
      {threads.kind === "error" && (
        <p className="danger-text" role="alert">
          Couldn&apos;t load replies: {threads.message}
        </p>
      )}
      {threads.kind === "ok" && threads.data.length === 0 && (
        <p className="muted" data-testid="canvas-threads-empty">
          No replies yet — you&apos;ve contacted {dealerCount} dealers; replies usually arrive in
          1–3 days.
        </p>
      )}
      {threads.kind === "ok" && threads.data.length > 0 && (
        <>
          <div className="tile-grid">
            {pager.pageItems.map((row) => (
              <ThreadRowView key={row.thread_id} row={row} />
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
            noun="replies"
          />
        </>
      )}
    </section>
  );
}
