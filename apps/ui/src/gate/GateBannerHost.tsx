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
import { ConfirmationGateCard, readConfirmationGateSpec } from "./ConfirmationGateCard.js";
import { gateTrack } from "./gateTrack.js";
import { HygieneReviewCard } from "./HygieneReviewCard.js";
import { readHygieneStageSpec } from "./hygieneStage.js";
import { InboxReviewCard, readInboxReviewSpec } from "./InboxReviewCard.js";

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
  // A batch_review carrying a hygiene `stage` is the DESTRUCTIVE per-stage
  // cleanup review (its own surface); a stage-less batch_review is the scan
  // review. Disambiguate by the presence of `stage` (defensive parse) — both
  // post through the SAME form-decision channel.
  const hygieneSpec =
    showBanner && kind === "batch_review" && awaiting.specInline !== null
      ? readHygieneStageSpec(awaiting.specInline)
      : null;
  // The inbox-check batch_review (dealer reply groups + `unrouted`, no
  // `website`/`total_in_radius`) is its own surface. Disambiguated by shape:
  // readInboxReviewSpec returns null on the hygiene + inventory payloads (and
  // vice-versa), so the three readers never misroute each other. Tried before
  // the inventory readBatchReviewSpec; both post through the SAME channel.
  const inboxSpec =
    hygieneSpec === null && showBanner && kind === "batch_review" && awaiting.specInline !== null
      ? readInboxReviewSpec(awaiting.specInline)
      : null;
  const batchSpec =
    hygieneSpec === null && inboxSpec === null && showBanner && kind === "batch_review" && awaiting.specInline !== null
      ? readBatchReviewSpec(awaiting.specInline)
      : null;
  // The approval kind needs only a human-readable summary off the payload;
  // a summary-less payload falls back to the pending placeholder (a pending
  // gate must always be visible, never mis-rendered).
  const approvalLabel =
    showBanner && kind === "approval" && typeof awaiting.specInline?.["summary"] === "string"
      ? (awaiting.specInline["summary"] as string)
      : null;
  // The pipeline_reset DESTRUCTIVE typed-YES confirm (its own surface). A
  // malformed payload yields null → the never-hidden pending placeholder (a
  // destructive gate is never silently auto-approved, never mis-rendered).
  const confirmationSpec =
    showBanner && kind === "confirmation_gate" && awaiting.specInline !== null
      ? readConfirmationGateSpec(awaiting.specInline)
      : null;

  return (
    <section className="gate-banner" data-testid="gate-banner" aria-label="Pending approval">
      {confirmationSpec !== null ? (
        <>
          <ConfirmationGateCard
            spec={confirmationSpec}
            submitting={decision.submitting}
            onConfirm={() => decision.decide("accept", { confirm_token: "YES" })}
            onCancel={() => decision.decide("decline")}
          />
          {decision.decisionError !== null && (
            <p className="danger-text" role="alert" data-testid="confirmation-decision-error">
              {decision.decisionError}
            </p>
          )}
        </>
      ) : hygieneSpec !== null ? (
        <>
          <HygieneReviewCard
            spec={hygieneSpec}
            submitting={decision.submitting}
            onApprove={(ids) => decision.decide("accept", { approved_ids: ids })}
            onDecline={() => decision.decide("decline")}
          />
          {decision.decisionError !== null && (
            <p className="danger-text" role="alert" data-testid="hygiene-decision-error">
              {decision.decisionError}
            </p>
          )}
        </>
      ) : inboxSpec !== null ? (
        <>
          <InboxReviewCard
            spec={inboxSpec}
            submitting={decision.submitting}
            onApprove={(ids) => decision.decide("accept", { approved_dealer_ids: ids })}
            onDecline={() => decision.decide("decline")}
          />
          {decision.decisionError !== null && (
            <p className="danger-text" role="alert" data-testid="inbox-decision-error">
              {decision.decisionError}
            </p>
          )}
        </>
      ) : batchSpec !== null ? (
        <>
          <BatchReviewCard
            spec={batchSpec}
            submitting={decision.submitting}
            onApprove={(ids) => decision.decide("accept", { approved_dealer_ids: ids })}
            onDecline={() => decision.decide("decline")}
            onSkipAll={() => decision.decide("accept", { skip_all: true })}
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
