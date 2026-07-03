/**
 * NeedsYouInbox — the global, floating "Needs you" widget that follows the user
 * across pages. It consumes the consolidated approval queue (GET /api/approvals
 * → ApprovalItem[], already ranked action-required first by the server) and
 * surfaces every PARKED gate across ALL pipelines. A gate item's "Review" ROUTES
 * to that run (navigate /runs/:runId) where the existing per-run GateBannerHost
 * renders the actual BatchReviewCard / ConfirmationGateCard and the user approves
 * there.
 *
 * The widget NEVER approves inline and NEVER batch-approves — destructive /
 * irreversible items stay strictly action-required (you go to the gate). This is
 * the "attention" layer of the four-layer interruption rule: ONLY a parked gate
 * surfaces here. Read-only auto-scans never park, so they never appear. Budget
 * never appears (#9).
 *
 * Dependency wall: app/ui layer.
 */

import type { ApprovalItem } from "../api/wire.js";

/** A short human label for an approval reason (the server's reasonFor vocab). */
function reasonLabel(reason: string): string {
  switch (reason) {
    case "lead_submit":
      return "review before sending";
    case "email_fallback":
      return "confirm email fallback";
    case "negotiation":
      return "review follow-up";
    case "contact_flip":
      return "confirm phone follow-up";
    case "closeout":
      return "confirm closeout";
    case "inbox":
      return "review inbox replies";
    case "link_scan":
      return "review sources";
    default:
      return "needs your approval";
  }
}

/** The item's display name: the budget-free summary heading when present, else a
 *  prettified skill name. */
function itemName(item: ApprovalItem): string {
  if (item.summary !== undefined && item.summary.heading !== "") return item.summary.heading;
  return item.skill.replace(/_/g, " ");
}

export function NeedsYouInbox({
  items,
  onReview,
}: {
  /** The consolidated approval queue (server-ranked action-required first). */
  items: readonly ApprovalItem[];
  /** Route to a parked gate's run (App navigates to /runs/:runId). */
  onReview: (runId: string) => void;
}): JSX.Element | null {
  if (items.length === 0) return null;

  return (
    <aside className="needsyou-widget" data-testid="needs-you-widget" aria-label="Needs you">
      <div className="needsyou-head">
        Needs you
        <span className="needsyou-count" data-testid="needs-you-count">
          {items.length}
        </span>
      </div>
      <ul className="needsyou-list">
        {items.map((item) => (
          <li key={`${item.runId}:${item.decisionId}`}>
            <button
              type="button"
              className="needsyou-item"
              data-testid={`needs-you-item-${item.runId}`}
              data-reason={item.reason}
              data-action-required={item.actionRequired}
              onClick={() => onReview(item.runId)}
            >
              <span className="needsyou-item-vehicle">{itemName(item)}</span>
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
