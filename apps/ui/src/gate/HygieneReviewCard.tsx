/**
 * HygieneReviewCard — the per-stage DESTRUCTIVE cleanup review surface for the
 * dealer_hygiene skill's three strictly-ordered batch_review suspends
 * (5a orphans → 5b CRM threads → 5c CRM contacts). Renders straight off the
 * suspend spec_inline {stage, question, targets, total}.
 *
 * This is the destructive second-confirm — approval is NEVER hidden (`sensitive`
 * styling, a destructive-tone banner). Reuses the proven batch-review row
 * machinery:
 *   - every target row defaults UNDECIDED, with explicit per-row Approve/Skip;
 *   - a "Select all" button is allowed (a user action — it still produces the
 *     full explicit id list, never an approve-all wire member);
 *   - a live decided/total counter; Submit stays disabled until EVERY row is
 *     decided AND at least one is approved (the resume requires min-1 ids, so an
 *     all-skip submit is contractually impossible — Decline is the stop verb);
 *   - Decline is always enabled and terminal (zero writes for the WHOLE run);
 *   - per-row plain-speak reason.
 *
 * Presentational only — the stage spec + the decision-submit callbacks arrive as
 * props. Submit posts ONLY the approved rows' ids; Decline posts a decline.
 */

import { useState } from "react";

import type { HygieneStage } from "./hygieneStage.js";
import { HYGIENE_STAGE_HEADINGS, readHygieneStageSpec, type HygieneStageSpec } from "./hygieneStage.js";

type RowDecision = "approve" | "skip";

export function HygieneReviewCard({
  spec,
  submitting,
  onApprove,
  onDecline,
}: {
  spec: HygieneStageSpec;
  submitting: boolean;
  /** action "accept" with {approved_ids} — only the approved rows. */
  onApprove: (approvedIds: string[]) => void;
  /** action "decline" — terminal, zero writes for the whole run. */
  onDecline: () => void;
}): JSX.Element {
  // Row decisions, keyed by id; an ABSENT key is the undecided default.
  const [decisions, setDecisions] = useState<Record<string, RowDecision>>({});

  const decide = (id: string, decision: RowDecision): void =>
    setDecisions((d) => ({ ...d, [id]: decision }));
  const selectAll = (): void =>
    setDecisions(Object.fromEntries(spec.targets.map((t) => [t.id, "approve" as const])));

  const decidedCount = spec.targets.filter((t) => decisions[t.id] !== undefined).length;
  const approvedIds = spec.targets.filter((t) => decisions[t.id] === "approve").map((t) => t.id);
  const allDecided = decidedCount === spec.targets.length;
  const canSubmit = allDecided && approvedIds.length > 0 && !submitting;

  return (
    <div className="gate-card sensitive" data-testid="hygiene-review-card" role="alertdialog" aria-label="Hygiene review">
      <p className="danger-text" data-testid="hygiene-banner">
        This permanently cleans up records — review each item before approving.
      </p>
      <strong>{spec.question}</strong>
      <p className="muted" data-testid="hygiene-stage" data-stage={spec.stage}>
        {HYGIENE_STAGE_HEADINGS[spec.stage]}
      </p>

      <div className="batch-rows">
        {spec.targets.map((t) => {
          const decision = decisions[t.id];
          return (
            <div
              className="batch-row"
              key={t.id}
              data-testid={`hygiene-row-${t.id}`}
              data-decision={decision ?? "undecided"}
            >
              <span className="batch-row-text">
                <strong>{t.name}</strong> <span className="muted">{t.reason}</span>
              </span>
              <button
                type="button"
                data-testid={`hygiene-approve-${t.id}`}
                aria-pressed={decision === "approve"}
                className={decision === "approve" ? "on" : ""}
                disabled={submitting}
                onClick={() => decide(t.id, "approve")}
              >
                Approve
              </button>
              <button
                type="button"
                data-testid={`hygiene-skip-${t.id}`}
                aria-pressed={decision === "skip"}
                className={decision === "skip" ? "on" : ""}
                disabled={submitting}
                onClick={() => decide(t.id, "skip")}
              >
                Skip
              </button>
            </div>
          );
        })}
      </div>

      <div className="gate-actions">
        <button type="button" data-testid="hygiene-select-all" disabled={submitting} onClick={selectAll}>
          Select all
        </button>
        <span className="muted" data-testid="hygiene-counter">
          {decidedCount}/{spec.targets.length} decided
        </span>
        <button
          type="button"
          className="btn-primary"
          data-testid="hygiene-submit"
          disabled={!canSubmit}
          onClick={() => onApprove(approvedIds)}
        >
          Clean up approved items
        </button>
        <button
          type="button"
          className="btn-danger"
          data-testid="hygiene-decline"
          disabled={submitting}
          onClick={onDecline}
        >
          Decline
        </button>
      </div>
      {allDecided && approvedIds.length === 0 && (
        <p className="muted" data-testid="hygiene-zero-approved-hint">
          Nothing approved — use Decline to cancel the cleanup.
        </p>
      )}
    </div>
  );
}

export { readHygieneStageSpec, type HygieneStageSpec, type HygieneStage };
