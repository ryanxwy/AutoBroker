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

import type { HygieneStage } from "./hygieneStage.js";
import { HYGIENE_STAGE_HEADINGS, readHygieneStageSpec, type HygieneStageSpec } from "./hygieneStage.js";
import { ReviewDecisionList } from "./ReviewDecisionList.js";

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
  return (
    <ReviewDecisionList
      cardTestId="hygiene-review-card"
      ariaLabel="Hygiene review"
      testidPrefix="hygiene"
      submitLabel="Clean up approved items"
      zeroApprovedHint="Nothing approved — use Decline to cancel the cleanup."
      submitting={submitting}
      onApprove={onApprove}
      onDecline={onDecline}
      beforeRows={
        <>
          <p className="danger-text" data-testid="hygiene-banner">
            This permanently cleans up records — review each item before approving.
          </p>
          <strong>{spec.question}</strong>
          <p className="muted" data-testid="hygiene-stage" data-stage={spec.stage}>
            {HYGIENE_STAGE_HEADINGS[spec.stage]}
          </p>
        </>
      }
      rows={spec.targets.map((t) => ({
        id: t.id,
        body: (
          <span className="batch-row-text">
            <strong>{t.name}</strong> <span className="muted">{t.reason}</span>
          </span>
        ),
      }))}
    />
  );
}

export { readHygieneStageSpec, type HygieneStageSpec, type HygieneStage };
