/**
 * NegotiationDetailModal — the read-only "where does this negotiation stand"
 * detail surface a buyer opens by clicking a board card. It restates, in order:
 * the dealer title + public facts, who's contacting (with a mailto + role), the
 * status summary (the deterministic status_line, with a SUBORDINATE lazy LLM
 * "AI summary" layered on top when it resolves), the strategy, the next steps, the
 * competing-offer scalars, and the substantive replies (newest-first, absolute
 * timestamps, height-capped + scrollable).
 *
 * Budget red line: it shows only the dealer's own facts + dealer-side scalars —
 * NEVER a budget, NEVER a bare id (dealer/message/contact ids are keys only), and
 * NEVER the competing dealer's NAME (only the best_competing_otd / batna_gap_usd
 * scalars). A null/empty field drops its row rather than fabricating a value.
 * Presentational only: it takes one detail row as a prop + an optional summary
 * fetcher; the summary is fetched lazily on open and degrades silently to the
 * status_line on any failure.
 */

import { useEffect, useId, useRef, useState } from "react";

import type { DealerNegotiationDetail, DealerNegotiationSummary } from "../api/wire.js";
import { Modal } from "../shell/Modal.js";
import { DetailRow } from "./DetailRow.js";
import { absoluteTimestamp, dollarLabel } from "./format.js";
import { STATUS_LABEL } from "./ThreadsSection.js";

/** Parse a reply received_at (ISO string OR epoch-ms OR null) to a sortable ms
 *  (null/unparseable → -Infinity so it sinks to the bottom of the newest-first list). */
function receivedMs(value: string | number | null): number {
  if (value === null) return Number.NEGATIVE_INFINITY;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

export function NegotiationDetailModal({
  detail,
  fetchSummary,
  onClose,
}: {
  detail: DealerNegotiationDetail | null;
  /** Lazy LLM summary fetcher (bound to the open dealer by the board). When
   *  omitted the section shows only the deterministic status_line. */
  fetchSummary?: () => Promise<DealerNegotiationSummary>;
  onClose: () => void;
}): JSX.Element {
  const titleId = useId();
  // The lazily-fetched LLM summary, fetched on open. Null until/unless it
  // resolves to a non-null string; any failure degrades to null (→ status_line).
  // Fetched in an effect so the hook order stays stable across the open/closed
  // return. Keyed on the open dealer id so reopening a different card refetches.
  const dealerId = detail?.dealer_id ?? null;
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const fetchRef = useRef(fetchSummary);
  fetchRef.current = fetchSummary;
  useEffect(() => {
    const fetcher = fetchRef.current;
    if (dealerId === null || fetcher === undefined) {
      setSummary(null);
      setSummaryLoading(false);
      return;
    }
    let cancelled = false;
    setSummary(null);
    setSummaryLoading(true);
    void (async () => {
      try {
        const res = await fetcher();
        if (!cancelled) setSummary(res.summary ?? null);
      } catch {
        if (!cancelled) setSummary(null);
      } finally {
        if (!cancelled) setSummaryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dealerId]);

  if (detail === null) {
    // Closed: render an inert Modal (returns null while open=false) so the hook
    // order stays stable across open/closed.
    return (
      <Modal open={false} onClose={onClose} labelId={titleId} variant="dialog">
        <></>
      </Modal>
    );
  }

  const name = detail.name;
  const location = [detail.city, detail.state].filter((p): p is string => p !== null && p !== "").join(", ");
  const statusKey = detail.negotiation_status;
  const statusLabel = statusKey !== null ? (STATUS_LABEL[statusKey] ?? statusKey) : null;

  const contacts = detail.contacts.filter((c) => c.display_name !== null || c.email !== null);
  const replies = detail.replies
    .filter(
      (m) =>
        m.sender_name !== null ||
        m.sender_email !== null ||
        (m.subject !== null && m.subject !== "") ||
        (m.body_excerpt !== null && m.body_excerpt !== ""),
    )
    .slice()
    .sort((a, b) => receivedMs(b.received_at) - receivedMs(a.received_at));

  const hasCompeting = detail.best_competing_otd !== null || detail.batna_gap_usd !== null;
  const website = detail.website;
  const hasWebsite = website !== null && /^https?:\/\//i.test(website);

  return (
    <Modal open onClose={onClose} labelId={titleId} variant="dialog">
      <div data-testid="negotiation-detail-modal">
        {/* (1) title + public facts */}
        {name !== null ? (
          <h2 id={titleId} data-testid="negotiation-detail-title">
            {name}
          </h2>
        ) : (
          <h2 id={titleId} className="muted">
            Dealer negotiation
          </h2>
        )}
        <dl className="inventory-detail-list">
          <DetailRow label="Location" value={location === "" ? null : location} />
          <DetailRow label="Status" value={statusLabel} />
          <DetailRow label="Emails exchanged" value={String(detail.email_count)} />
          <DetailRow label="Quote received" value={detail.quote_sent ? "yes" : "no"} />
        </dl>

        {/* (2) who's contacting */}
        {contacts.length > 0 && (
          <div className="negotiation-section">
            <h3 className="quote-detail-h3">Who&apos;s contacting you</h3>
            {contacts.map((c) => (
              <div key={c.contact_id} data-testid="negotiation-contact-row" className="negotiation-contact-row">
                <span>{c.display_name ?? "Contact"}</span>
                {c.email !== null && c.email !== "" && (
                  <a href={`mailto:${c.email}`} className="negotiation-contact-email">
                    {c.email}
                  </a>
                )}
                {c.role !== null && c.role !== "" && <span className="muted">· {c.role}</span>}
              </div>
            ))}
          </div>
        )}

        {/* (3) status summary — the deterministic status_line is the always-present
            floor; the lazy LLM "AI summary" layers on subordinate so a null summary
            never leaves a hole. */}
        <div className="negotiation-section" data-testid="negotiation-status-summary">
          <h3 className="quote-detail-h3">Where this stands</h3>
          <p>{detail.status_line}</p>
          {summaryLoading && <p className="muted negotiation-ai-summary">summarizing…</p>}
          {summary !== null && summary !== "" && (
            <p className="muted negotiation-ai-summary" data-testid="negotiation-ai-summary">
              <span className="negotiation-ai-tag">AI summary</span> {summary}
            </p>
          )}
        </div>

        {/* (4) strategy */}
        {detail.strategy !== "" && (
          <div className="negotiation-section">
            <h3 className="quote-detail-h3">Suggested approach</h3>
            <p data-testid="negotiation-strategy">{detail.strategy}</p>
          </div>
        )}

        {/* (5) next steps */}
        {detail.next_steps.length > 0 && (
          <div className="negotiation-section">
            <h3 className="quote-detail-h3">Next steps</h3>
            <ol data-testid="negotiation-next-steps">
              {detail.next_steps.map((s, i) => (
                <li key={`${i}-${s}`}>{s}</li>
              ))}
            </ol>
          </div>
        )}

        {/* (6) competing — scalar $ figures ONLY, never the competitor's name */}
        {hasCompeting && (
          <div className="negotiation-section" data-testid="negotiation-competing-quote">
            <h3 className="quote-detail-h3">Best competing offer</h3>
            {detail.best_competing_otd !== null && (
              <p>Best competing out-the-door: {dollarLabel(detail.best_competing_otd)}</p>
            )}
            {detail.batna_gap_usd !== null && detail.batna_gap_usd > 0 && (
              <p className="muted">You&apos;re {dollarLabel(detail.batna_gap_usd)} above it.</p>
            )}
          </div>
        )}

        {/* (7) replies — newest first, absolute timestamps, height-capped + scroll */}
        {replies.length > 0 && (
          <div className="negotiation-section">
            <h3 className="quote-detail-h3">Dealer replies</h3>
            <div className="negotiation-replies-scroll">
              {replies.map((m) => {
                const when = absoluteTimestamp(m.received_at);
                const who = m.sender_name ?? m.sender_email ?? "Dealer";
                return (
                  <div key={m.message_id} data-testid="negotiation-reply-row" className="negotiation-reply-row">
                    <div className="negotiation-reply-head">
                      <span>{who}</span>
                      {when !== "" && <span className="muted">{when}</span>}
                    </div>
                    {m.subject !== null && m.subject !== "" && (
                      <div className="negotiation-reply-subject">{m.subject}</div>
                    )}
                    {m.body_excerpt !== null && m.body_excerpt !== "" && (
                      <div className="negotiation-reply-body muted">{m.body_excerpt}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* (8) footer — website link + Close */}
        <div className="modal-foot">
          {hasWebsite && (
            <a
              href={website}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="negotiation-detail-website"
              className="btn-primary"
            >
              Visit dealer website ↗
            </a>
          )}
          <span className="spacer" />
          <button type="button" data-testid="negotiation-detail-close" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
