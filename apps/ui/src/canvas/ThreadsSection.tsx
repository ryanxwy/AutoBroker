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
 * its messages) a "extraction failed, will retry" badge — NEVER a budget, NEVER
 * a raw id. LIGHT paper skin, mirroring the dealer-tiles section.
 */

import type { AsyncState } from "../api/useApi.js";

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

/** A coarse "3 days ago" relative label from an ISO/timestamp string. Never a
 *  raw id; degrades to "" when the value is unparseable. */
function relativeDate(value: string | null): string {
  if (value === null || value.trim() === "") return "";
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return "";
  const deltaDays = Math.floor((Date.now() - ms) / 86_400_000);
  if (deltaDays <= 0) return "today";
  if (deltaDays === 1) return "yesterday";
  return `${deltaDays} days ago`;
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
  /** Whether the cross-provider RETRY key (Anthropic) is configured. Gates the
   *  manual "retry failed extractions on another provider" affordance: present →
   *  the active button; absent → a disabled Settings hint. Threaded from the
   *  host the same way the canvas wires its other key-presence reads. Default
   *  false (the affordance is opt-in egress — never assume the key is there). */
  anthropicReady?: boolean;
  /** Launch the MANUAL cross-provider retry of this profile's failed
   *  extractions (escalate:true). Invoked ONLY by the user clicking the retry
   *  button — there is no auto-escalation. The host owns the actual skill launch
   *  (session/pin threading), so the section just signals the click. */
  onRetryFailedExtractions?: () => void;
}

export function ThreadsSection({
  threads,
  dealerCount,
  anthropicReady = false,
  onRetryFailedExtractions,
}: ThreadsSectionProps): JSX.Element {
  // The retry affordance shows ONLY when at least one thread carries a failed
  // extraction — there is nothing to recover otherwise.
  const hasFailed =
    threads.kind === "ok" && threads.data.some((row) => Boolean(row.extract_failed));

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
        <div className="tile-grid">
          {threads.data.map((row) => (
            <ThreadRowView key={row.thread_id} row={row} />
          ))}
        </div>
      )}

      {/* MANUAL cross-provider retry of failed extractions. The auto-path stays
          DeepSeek-only + fail-closed; this is the user's explicit, key-guarded,
          DISCLOSED escape hatch — the click sends the reply text to another
          provider (Anthropic). Shown only when (a) a thread failed extraction
          AND (b) the retry key is present; absent → a Settings hint instead. */}
      {hasFailed &&
        (anthropicReady ? (
          <button
            type="button"
            className="btn-secondary"
            data-testid="retry-failed-extractions"
            onClick={() => onRetryFailedExtractions?.()}
          >
            Retry failed extractions — sends the reply text to Anthropic
          </button>
        ) : (
          <p className="muted" data-testid="retry-failed-extractions-hint">
            Configure an Anthropic key in Settings to retry on another provider.
          </p>
        ))}
    </section>
  );
}
