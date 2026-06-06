/**
 * ApprovalPrompt — the run-level approval gate.
 * Renders on an `approval_required` decision: Approve / Approve all / Deny /
 * Cancel. Two load-bearing safety rules (see CLAUDE.md):
 *
 *   - "Approve all" is HIDDEN for a SENSITIVE event (no batch-approval of a
 *     mutating/sensitive tool) — `sensitive` also renders the danger frame.
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
  /** Sensitive (mutating) → hide "Approve all" + danger frame. */
  sensitive: boolean;
}

export interface ApprovalPromptProps {
  decision: ApprovalDecision;
  submitting: boolean;
  onApprove: () => void;
  onApproveAll: () => void;
  onDeny: () => void;
  onCancel: () => void;
}

export function ApprovalPrompt({
  decision,
  submitting,
  onApprove,
  onApproveAll,
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
        {/* Hidden for sensitive events — no batch-approval of a mutating tool. */}
        {!decision.sensitive && (
          <button type="button" data-testid="approval-approve-all" disabled={submitting} onClick={onApproveAll}>
            Approve all
          </button>
        )}
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
