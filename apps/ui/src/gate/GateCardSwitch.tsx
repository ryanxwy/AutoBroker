/**
 * GateCardSwitch — the surface-agnostic gate dispatch. Given a pending suspend +
 * the decide() controller, it renders the ONE right decision card for the
 * payload: the destructive typed-YES confirm (ConfirmationGateCard), the
 * per-stage hygiene cleanup (HygieneReviewCard), the inbox-check review
 * (InboxReviewCard), the inventory batch review (BatchReviewCard), the mutation
 * approval (ApprovalPrompt), or — for any unmatched / malformed payload — the
 * never-hidden pending placeholder (a pending gate is always visible, never
 * mis-rendered).
 *
 * The three batch_review shapes (hygiene / inbox / inventory) arrive under the
 * SAME kind="batch_review" and are disambiguated by SHAPE via the defensive
 * readers (readHygieneStageSpec / readInboxReviewSpec / readBatchReviewSpec),
 * which return null on each other's payloads so they never misroute. All post
 * through the SAME form-decision channel (decision.decide).
 *
 * It does NOT consult gateTrack — it has no opinion on which surface mounts it.
 * The banner host (GateBannerHost) renders it for approval/confirmation_gate; the
 * chat rail's assistant turn renders it for the batch_review family.
 *
 * Presentational: it never reads the network; the host passes the projected
 * suspend + the decide() controller bound to the run's (runId, decisionId).
 */

import type { AwaitingUserPayload } from "../chat/messageModel.js";
import type { DecisionController } from "../chat/useDecision.js";
import { ApprovalPrompt } from "./ApprovalPrompt.js";
import { BatchReviewCard, readBatchReviewSpec } from "./BatchReviewCard.js";
import { ConfirmationGateCard, readConfirmationGateSpec } from "./ConfirmationGateCard.js";
import { HygieneReviewCard } from "./HygieneReviewCard.js";
import { readHygieneStageSpec } from "./hygieneStage.js";
import { InboxReviewCard, readInboxReviewSpec } from "./InboxReviewCard.js";

export function GateCardSwitch({
  awaiting,
  decision,
}: {
  /** The run's pending suspend (the host renders this component only when set). */
  awaiting: AwaitingUserPayload;
  /** The decide() controller bound to this run's pending decision. */
  decision: DecisionController;
}): JSX.Element {
  const rawKind = awaiting.specInline?.["kind"];
  const kind = typeof rawKind === "string" ? rawKind : null;
  // A batch_review carrying a hygiene `stage` is the DESTRUCTIVE per-stage
  // cleanup review (its own surface); a stage-less batch_review is the scan
  // review. Disambiguate by the presence of `stage` (defensive parse) — both
  // post through the SAME form-decision channel.
  const hygieneSpec =
    kind === "batch_review" && awaiting.specInline !== null
      ? readHygieneStageSpec(awaiting.specInline)
      : null;
  // The inbox-check batch_review (dealer reply groups + `unrouted`, no
  // `website`/`total_in_radius`) is its own surface. Disambiguated by shape:
  // readInboxReviewSpec returns null on the hygiene + inventory payloads (and
  // vice-versa), so the three readers never misroute each other. Tried before
  // the inventory readBatchReviewSpec; both post through the SAME channel.
  const inboxSpec =
    hygieneSpec === null && kind === "batch_review" && awaiting.specInline !== null
      ? readInboxReviewSpec(awaiting.specInline)
      : null;
  const batchSpec =
    hygieneSpec === null && inboxSpec === null && kind === "batch_review" && awaiting.specInline !== null
      ? readBatchReviewSpec(awaiting.specInline)
      : null;
  // The approval kind needs only a human-readable summary off the payload;
  // a summary-less payload falls back to the pending placeholder (a pending
  // gate must always be visible, never mis-rendered).
  const approvalLabel =
    kind === "approval" && typeof awaiting.specInline?.["summary"] === "string"
      ? (awaiting.specInline["summary"] as string)
      : null;
  // The pipeline_reset DESTRUCTIVE typed-YES confirm (its own surface). A
  // malformed payload yields null → the never-hidden pending placeholder (a
  // destructive gate is never silently auto-approved, never mis-rendered).
  const confirmationSpec =
    kind === "confirmation_gate" && awaiting.specInline !== null
      ? readConfirmationGateSpec(awaiting.specInline)
      : null;

  return confirmationSpec !== null ? (
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
          decisionId: awaiting.decisionId ?? "",
          label: approvalLabel,
          // Sensitive unless the payload explicitly relaxes it — defaults to
          // no batch approval.
          sensitive: awaiting.specInline?.["sensitive"] !== false,
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
    <div className="gate-card sensitive" data-testid="gate-banner-pending" role="alertdialog">
      <strong>Approval required</strong>
      <p className="muted">
        This run is paused on a &quot;{kind}&quot; decision. Its decision surface mounts
        here when that gate kind ships — nothing proceeds until you decide.
      </p>
    </div>
  );
}
