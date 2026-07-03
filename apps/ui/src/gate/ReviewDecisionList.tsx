/**
 * ReviewDecisionList — the shared per-item decision surface behind the three
 * batch-review cards (BatchReviewCard / InboxReviewCard / HygieneReviewCard).
 * It owns the load-bearing row machinery those three used to triplicate:
 *
 *   - every row defaults UNDECIDED, with explicit per-row Approve/Skip;
 *   - an explicit "Select all" button (a user action — it still produces the
 *     full explicit id list, never an approve-all wire member);
 *   - a live decided/total counter; Submit stays disabled until EVERY row is
 *     decided AND at least one is approved (the resume schemas require min-1
 *     ids, so an all-skip submit is contractually impossible — Decline stops);
 *   - Decline is always enabled and terminal (zero writes);
 *   - a zero-approved hint once every row is decided but none is approved.
 *
 * The three cards stay THIN wrappers: each maps its targets onto {id, body},
 * passes its own card testid / aria-label / testid prefix / submit label /
 * hint, and slots its card-specific chrome into `beforeRows` (header/banner),
 * `afterRows` (skipped/unrouted details), and `footerExtra` (the closeout
 * "Skip all & reset"). The rendered DOM is byte-identical to the pre-extraction
 * cards, so every per-card testid/aria/className/nesting the harness drives is
 * preserved.
 */

import { type ReactNode, useState } from "react";

type RowDecision = "approve" | "skip";

/** One decision row: a stable id (keys the decision + the per-row testids) and
 *  the card-specific body node (rendered before the Approve/Skip buttons). */
export interface ReviewRow {
  id: string;
  body: ReactNode;
}

export function ReviewDecisionList({
  cardTestId,
  ariaLabel,
  testidPrefix,
  rows,
  submitLabel,
  zeroApprovedHint,
  submitting,
  onApprove,
  onDecline,
  rowsTestId,
  beforeRows,
  afterRows,
  footerExtra,
}: {
  /** data-testid on the outer gate-card (e.g. "batch-review-card"). */
  cardTestId: string;
  /** aria-label on the outer alertdialog (e.g. "Batch review"). */
  ariaLabel: string;
  /** Per-row/footer testid prefix (e.g. "batch" → "batch-approve-<id>"). */
  testidPrefix: string;
  rows: ReviewRow[];
  submitLabel: string;
  zeroApprovedHint: string;
  submitting: boolean;
  /** action "accept" with the approved rows' ids (in row order). */
  onApprove: (approvedIds: string[]) => void;
  /** action "decline" — terminal, zero writes. */
  onDecline: () => void;
  /** Optional data-testid on the .batch-rows container (only BatchReviewCard
   *  carries "batch-rows"; absent ⇒ no attribute, preserving byte-identity). */
  rowsTestId?: string;
  /** Card chrome rendered between the card open and the rows (header/banner). */
  beforeRows?: ReactNode;
  /** Card chrome rendered between the rows and the footer (skipped/unrouted). */
  afterRows?: ReactNode;
  /** Extra footer control after Decline (the closeout "Skip all & reset"). */
  footerExtra?: ReactNode;
}): JSX.Element {
  // Row decisions, keyed by row id; an ABSENT key is the undecided default.
  const [decisions, setDecisions] = useState<Record<string, RowDecision>>({});

  const decide = (id: string, decision: RowDecision): void =>
    setDecisions((d) => ({ ...d, [id]: decision }));
  const selectAll = (): void =>
    setDecisions(Object.fromEntries(rows.map((r) => [r.id, "approve" as const])));

  const decidedCount = rows.filter((r) => decisions[r.id] !== undefined).length;
  const approvedIds = rows.filter((r) => decisions[r.id] === "approve").map((r) => r.id);
  const allDecided = decidedCount === rows.length;
  // Submit needs every row decided AND >=1 approve (the resume schema's min-1:
  // an all-skip batch has nothing to act on — Decline is the stop verb).
  const canSubmit = allDecided && approvedIds.length > 0 && !submitting;

  return (
    <div className="gate-card sensitive" data-testid={cardTestId} role="alertdialog" aria-label={ariaLabel}>
      {beforeRows}

      <div className="batch-rows" data-testid={rowsTestId}>
        {rows.map((row) => {
          const decision = decisions[row.id];
          return (
            <div
              className="batch-row"
              key={row.id}
              data-testid={`${testidPrefix}-row-${row.id}`}
              data-decision={decision ?? "undecided"}
            >
              {row.body}
              <button
                type="button"
                data-testid={`${testidPrefix}-approve-${row.id}`}
                aria-pressed={decision === "approve"}
                className={decision === "approve" ? "on" : ""}
                disabled={submitting}
                onClick={() => decide(row.id, "approve")}
              >
                Approve
              </button>
              <button
                type="button"
                data-testid={`${testidPrefix}-skip-${row.id}`}
                aria-pressed={decision === "skip"}
                className={decision === "skip" ? "on" : ""}
                disabled={submitting}
                onClick={() => decide(row.id, "skip")}
              >
                Skip
              </button>
            </div>
          );
        })}
      </div>

      {afterRows}

      <div className="gate-actions">
        <button type="button" data-testid={`${testidPrefix}-select-all`} disabled={submitting} onClick={selectAll}>
          Select all
        </button>
        <span className="muted" data-testid={`${testidPrefix}-counter`}>
          {decidedCount}/{rows.length} decided
        </span>
        <button
          type="button"
          className="btn-primary"
          data-testid={`${testidPrefix}-submit`}
          disabled={!canSubmit}
          onClick={() => onApprove(approvedIds)}
        >
          {submitLabel}
        </button>
        <button
          type="button"
          className="btn-danger"
          data-testid={`${testidPrefix}-decline`}
          disabled={submitting}
          onClick={onDecline}
        >
          Decline
        </button>
        {footerExtra}
      </div>
      {allDecided && approvedIds.length === 0 && (
        <p className="muted" data-testid={`${testidPrefix}-zero-approved-hint`}>
          {zeroApprovedHint}
        </p>
      )}
    </div>
  );
}
