/**
 * InboxReviewCard — the per-dealer batch-review decision surface for the
 * dealer_inbox_check skill's batch_review suspend (the human gate BEFORE any
 * reply is ingested). Renders straight off the suspend spec_inline
 * {question, targets, unrouted, total_targets}.
 *
 * The inbox suspend groups discovered replies BY DEALER (each target = one
 * routed dealer with its thread count, a quoted/replied classification, and a
 * snippet). It also carries an `unrouted` list — threads the deterministic
 * router could NOT bind to a dealer; those are surfaced as a collapsed,
 * NON-interactive backstop ("couldn't match — from {sender}") so the human can
 * see them, but they are never an approve/reject target (the human either
 * approves the matched dealers or declines the whole batch).
 *
 * Row-level contract (mirrors the proven batch-review machinery):
 *   - every dealer row defaults UNDECIDED, with explicit per-row Approve/Skip;
 *   - an explicit "Select all" button is allowed (a user action — it still
 *     produces the full explicit id list, never an approve-all wire member);
 *   - a live decided/total counter; Submit stays disabled until EVERY row is
 *     decided AND at least one is approved (the resume requires min-1 ids, so an
 *     all-skip submit is contractually impossible — Decline is the stop verb);
 *   - Decline is always enabled and terminal (zero writes).
 *
 * Submit posts through the EXISTING form-decision channel as action "accept"
 * with content {approved_dealer_ids: [...]} (only the approved rows' ids); the
 * server descriptor maps it onto the workflow's approve resume. No budget, no
 * raw run id surfaced.
 */

import { ReviewDecisionList } from "./ReviewDecisionList.js";

type InboxClassification = "quoted" | "replied";

/** The parsed inbox suspend spec_inline this card renders. */
export interface InboxReviewSpec {
  question: string;
  targets: Array<{
    dealer_id: string;
    name: string;
    thread_ids: string[];
    classification: InboxClassification;
    snippet: string;
  }>;
  unrouted: Array<{ thread_id: string; sender_email: string; snippet: string }>;
  totalTargets: number;
}

function isClassification(v: unknown): v is InboxClassification {
  return v === "quoted" || v === "replied";
}

/**
 * Defensively read an inbox batch_review spec_inline off the wire. Returns null
 * on a malformed payload — and, crucially, returns null on the INVENTORY
 * batch_review (which carries `website`/`total_in_radius`) and the HYGIENE
 * batch_review (which carries `stage`), so the three readers are MUTUALLY
 * EXCLUSIVE by shape. The inbox shape is identified by `unrouted` (an array) +
 * `total_targets` (a number) + `targets[].thread_ids`/`classification`, and the
 * explicit ABSENCE of the inventory markers. The banner host falls back to its
 * never-hidden pending placeholder when this returns null (a gate is never
 * silently hidden, never mis-rendered).
 */
export function readInboxReviewSpec(spec: Record<string, unknown>): InboxReviewSpec | null {
  if (spec["kind"] !== "batch_review") return null;
  // Mutual-exclusivity guards: a hygiene payload has `stage`; an inventory
  // payload has `website` (per target) + `total_in_radius`. Either marker means
  // this is NOT the inbox shape — bail so the right reader claims it.
  if (spec["stage"] !== undefined) return null;
  if (spec["total_in_radius"] !== undefined) return null;
  const targetsRaw = spec["targets"];
  const unroutedRaw = spec["unrouted"];
  // `unrouted` MUST be present + an array — it is the inbox shape's positive
  // marker (neither the inventory nor the hygiene payload carries it).
  if (!Array.isArray(targetsRaw) || !Array.isArray(unroutedRaw)) return null;
  const targets: InboxReviewSpec["targets"] = [];
  for (const t of targetsRaw) {
    const row = t as {
      dealer_id?: unknown;
      name?: unknown;
      thread_ids?: unknown;
      classification?: unknown;
      snippet?: unknown;
    };
    if (
      typeof row.dealer_id !== "string" ||
      typeof row.name !== "string" ||
      !Array.isArray(row.thread_ids) ||
      !row.thread_ids.every((id) => typeof id === "string") ||
      !isClassification(row.classification) ||
      typeof row.snippet !== "string"
    ) {
      return null;
    }
    targets.push({
      dealer_id: row.dealer_id,
      name: row.name,
      thread_ids: row.thread_ids as string[],
      classification: row.classification,
      snippet: row.snippet,
    });
  }
  const unrouted: InboxReviewSpec["unrouted"] = [];
  for (const u of unroutedRaw) {
    const row = u as { thread_id?: unknown; sender_email?: unknown; snippet?: unknown };
    if (
      typeof row.thread_id !== "string" ||
      typeof row.sender_email !== "string" ||
      typeof row.snippet !== "string"
    ) {
      return null;
    }
    unrouted.push({ thread_id: row.thread_id, sender_email: row.sender_email, snippet: row.snippet });
  }
  const totalTargets = spec["total_targets"];
  if (typeof totalTargets !== "number") return null;
  return {
    question: typeof spec["question"] === "string" ? spec["question"] : "Ingest these dealer replies?",
    targets,
    unrouted,
    totalTargets,
  };
}

/** The thread-count label for a dealer row ("1 thread" / "3 threads"). */
function threadCountLabel(n: number): string {
  return n === 1 ? "1 thread" : `${n} threads`;
}

export function InboxReviewCard({
  spec,
  submitting,
  onApprove,
  onDecline,
}: {
  spec: InboxReviewSpec;
  submitting: boolean;
  /** action "accept" with {approved_dealer_ids} — only the approved rows. */
  onApprove: (approvedDealerIds: string[]) => void;
  /** action "decline" — terminal, zero writes. */
  onDecline: () => void;
}): JSX.Element {
  return (
    <ReviewDecisionList
      cardTestId="inbox-review-card"
      ariaLabel="Inbox review"
      testidPrefix="inbox"
      submitLabel="Ingest approved replies"
      zeroApprovedHint="Nothing approved — use Decline to cancel ingest."
      submitting={submitting}
      onApprove={onApprove}
      onDecline={onDecline}
      beforeRows={<strong>{spec.question}</strong>}
      rows={spec.targets.map((t) => ({
        id: t.dealer_id,
        body: (
          <span className="batch-row-text">
            <strong>{t.name}</strong>{" "}
            <span className="muted" data-testid={`inbox-class-${t.dealer_id}`} data-classification={t.classification}>
              {t.classification === "quoted" ? "quoted" : "replied"}
            </span>{" "}
            <span className="muted">{threadCountLabel(t.thread_ids.length)}</span>
            <br />
            <span className="muted">{t.snippet}</span>
          </span>
        ),
      }))}
      afterRows={
        spec.unrouted.length > 0 ? (
          <details className="muted" data-testid="inbox-unrouted">
            <summary>{spec.unrouted.length} couldn&apos;t match to a dealer</summary>
            <ul>
              {spec.unrouted.map((u) => (
                <li key={u.thread_id} data-testid={`inbox-unrouted-row-${u.thread_id}`}>
                  Couldn&apos;t match to a dealer — from {u.sender_email}: {u.snippet}
                </li>
              ))}
            </ul>
          </details>
        ) : undefined
      }
    />
  );
}
