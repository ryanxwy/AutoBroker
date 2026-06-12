/**
 * GateBannerHost — the app-level gate surface: a system layer mounted ABOVE the
 * workbench/rail split, so a banner-tracked gate structurally precedes the main
 * region and every prose zone in document order (the gate-before-prose
 * invariant, held by MOUNT POSITION here, by zone order in the rail).
 *
 * Which gates land here is decided by the single routing point (gateTrack):
 * run-blocking decisions that span both panes — mutation approvals, per-item
 * batch review, typed-YES destructive confirms. The batch_review kind has its
 * real decision surface (BatchReviewCard); the approval kind renders the
 * ApprovalPrompt (Approve → accept, Deny → decline, Cancel run → cancel; the
 * label is the suspend payload's `summary`, `sensitive` hides batch approval
 * — e.g. the incentive first-encounter source approval). The remaining banner
 * kinds fall back to the never-hidden pending placeholder until theirs ship —
 * as does a batch_review whose spec_inline fails the defensive parse (a
 * pending gate must always be visible, never mis-rendered).
 *
 * Presentational: the App (the single useChat host) projects the active run's
 * pending suspend + the decide() controller and passes them down; this
 * component never reads the network itself.
 */

import type { AwaitingUserPayload } from "../chat/messageModel.js";
import type { DecisionController } from "../chat/useDecision.js";
import { ApprovalPrompt } from "./ApprovalPrompt.js";
import { BatchReviewCard, readBatchReviewSpec } from "./BatchReviewCard.js";
import { gateTrack } from "./gateTrack.js";

export function GateBannerHost({
  awaiting,
  decision,
}: {
  /** The active run's pending suspend (null when not suspended). */
  awaiting: AwaitingUserPayload | null;
  /** The decide() controller bound to the active run's pending decision. */
  decision: DecisionController;
}): JSX.Element {
  const rawKind = awaiting?.specInline?.["kind"];
  const kind = typeof rawKind === "string" ? rawKind : null;
  const showBanner = awaiting !== null && gateTrack(kind) === "banner";
  const batchSpec =
    showBanner && kind === "batch_review" && awaiting.specInline !== null
      ? readBatchReviewSpec(awaiting.specInline)
      : null;
  // The approval kind needs only a human-readable summary off the payload;
  // a summary-less payload falls back to the pending placeholder (a pending
  // gate must always be visible, never mis-rendered).
  const approvalLabel =
    showBanner && kind === "approval" && typeof awaiting.specInline?.["summary"] === "string"
      ? (awaiting.specInline["summary"] as string)
      : null;

  return (
    <section className="gate-banner" data-testid="gate-banner" aria-label="Pending approval">
      {batchSpec !== null ? (
        <>
          <BatchReviewCard
            spec={batchSpec}
            submitting={decision.submitting}
            onApprove={(ids) => decision.decide("accept", { approved_dealer_ids: ids })}
            onDecline={() => decision.decide("decline")}
          />
          {decision.decisionError !== null && (
            <p className="danger-text" role="alert" data-testid="batch-decision-error">
              {decision.decisionError}
            </p>
          )}
        </>
      ) : approvalLabel !== null ? (
        <>
          <ApprovalPrompt
            decision={{
              decisionId: awaiting?.decisionId ?? "",
              label: approvalLabel,
              // Sensitive unless the payload explicitly relaxes it — a
              // banner-track approval defaults to no batch approval.
              sensitive: awaiting?.specInline?.["sensitive"] !== false,
            }}
            submitting={decision.submitting}
            onApprove={() => decision.decide("accept")}
            onApproveAll={() => decision.decide("accept")}
            onDeny={() => decision.decide("decline")}
            onCancel={() => decision.decide("cancel")}
          />
          {decision.decisionError !== null && (
            <p className="danger-text" role="alert" data-testid="approval-decision-error">
              {decision.decisionError}
            </p>
          )}
        </>
      ) : (
        showBanner && (
          <div className="gate-card sensitive" data-testid="gate-banner-pending" role="alertdialog">
            <strong>Approval required</strong>
            <p className="muted">
              This run is paused on a &quot;{kind}&quot; decision. Its decision surface mounts
              here when that gate kind ships — nothing proceeds until you decide.
            </p>
          </div>
        )
      )}
    </section>
  );
}
