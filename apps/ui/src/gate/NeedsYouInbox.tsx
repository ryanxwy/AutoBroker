/**
 * NeedsYouInbox — the global, floating "Needs you" widget that follows the user
 * across pages. It aggregates every PARKED gate across ALL pipelines (the
 * approval-inbox), sorted ERROR-FIRST (a #1244 fail-closed before a normal
 * approval). Each item NAMES its profile + reason; "Review" ROUTES to that run
 * (navigate /runs/:runId) where the existing per-run GateBannerHost renders the
 * actual BatchReviewCard / ConfirmationGateCard and the user approves there.
 *
 * The widget NEVER approves inline and NEVER batch-approves — destructive /
 * irreversible items stay strictly action-required (you go to the gate). This is
 * the "attention" layer of the four-layer interruption rule: ONLY a parked gate
 * or a fail-closed surfaces here. Read-only auto-scans never park, so they never
 * appear. Budget never appears (#9).
 *
 * Dependency wall: app/ui layer.
 */

import type { ApprovalInboxItem } from "../api/wire.js";

/** Fail-closed items sort before normal approvals (error-first), otherwise
 *  inbox order is preserved (a stable partition). */
function errorFirst(items: readonly ApprovalInboxItem[]): ApprovalInboxItem[] {
  const fail = items.filter((i) => i.reason === "fail_closed");
  const rest = items.filter((i) => i.reason !== "fail_closed");
  return [...fail, ...rest];
}

/** A short human label for a gate reason. */
function reasonLabel(reason: string): string {
  switch (reason) {
    case "fail_closed":
      return "needs a fix (fail-closed)";
    case "batch_review":
      return "review before sending";
    case "confirmation_gate":
      return "confirm to proceed";
    case "hygiene_review":
      return "review cleanup";
    case "approval":
      return "approve to send";
    default:
      return "needs your approval";
  }
}

export function NeedsYouInbox({
  items,
  onReview,
}: {
  items: readonly ApprovalInboxItem[];
  /** Route to the parked run (App navigates to /runs/:runId). */
  onReview: (runId: string) => void;
}): JSX.Element | null {
  if (items.length === 0) return null;
  const sorted = errorFirst(items);

  return (
    <aside className="needsyou-widget" data-testid="needs-you-widget" aria-label="Needs you">
      <div className="needsyou-head">
        Needs you
        <span className="needsyou-count" data-testid="needs-you-count">
          {sorted.length}
        </span>
      </div>
      <ul className="needsyou-list">
        {sorted.map((item) => (
          <li key={`${item.runId}:${item.decisionId}`}>
            <button
              type="button"
              className="needsyou-item"
              data-testid={`needs-you-item-${item.runId}`}
              data-reason={item.reason}
              onClick={() => onReview(item.runId)}
            >
              <span className="needsyou-item-vehicle">{item.vehicle ?? "A search"}</span>
              <span className="needsyou-item-reason">{reasonLabel(item.reason)}</span>
              <span className="needsyou-item-go" aria-hidden="true">
                Review →
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
