/**
 * ApprovalPrompt — the run-level approval gate.
 * Renders on an `approval_required` decision: Approve / Deny / Cancel. Two
 * load-bearing safety rules (see CLAUDE.md):
 *
 *   - a SENSITIVE event renders the danger frame + the `data-sensitive`
 *     attribute the harness reads; there is no bulk/batch-approve affordance on
 *     this card — every action is approved one at a time.
 *   - the approval is NEVER hidden on any surface; it lives in the assistant
 *     turn's GATE zone, structurally before the prose.
 *
 * intake is read/local-write in this slice (no MutationKind) so it does NOT
 * normally trigger this — but the component is built now so a gated tool
 * surfaces correctly the moment one lands. Presentational: the parent owns
 * the resume call. Stable data-testid on every action.
 */

export interface ApprovalDecision {
  decisionId: string;
  /** The tool/action label shown to the user. */
  label: string;
  /** Sensitive (mutating) → danger frame + `data-sensitive` attribute. */
  sensitive: boolean;
}

export interface ApprovalPromptProps {
  decision: ApprovalDecision;
  submitting: boolean;
  onApprove: () => void;
  onDeny: () => void;
  onCancel: () => void;
}

export function ApprovalPrompt({
  decision,
  submitting,
  onApprove,
  onDeny,
  onCancel,
}: ApprovalPromptProps): JSX.Element {
  return (
    <div
      className={`gate-card${decision.sensitive ? " sensitive" : ""}`}
      data-testid="approval-prompt"
      data-sensitive={decision.sensitive}
      role="alertdialog"
      aria-label="Approval required"
    >
      <strong>Approval required</strong>
      <p className="muted" data-testid="approval-label">
        {decision.label}
      </p>
      <div className="gate-actions">
        <button type="button" className="btn-primary" data-testid="approval-approve" disabled={submitting} onClick={onApprove}>
          Approve
        </button>
        <button type="button" className="btn-danger" data-testid="approval-deny" disabled={submitting} onClick={onDeny}>
          Deny
        </button>
        <button type="button" data-testid="approval-cancel" disabled={submitting} onClick={onCancel}>
          Cancel run
        </button>
      </div>
    </div>
  );
}
