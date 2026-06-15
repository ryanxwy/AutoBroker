/**
 * BatchReviewCard — the per-item batch-review decision surface for the
 * banner-tracked "batch_review" suspend (inventory_site_scan's human gate
 * before ANY dealer-site navigation). Renders straight off the suspend
 * spec_inline {targets, skipped, total_targets, total_in_radius}.
 *
 * Row-level contract (load-bearing):
 *   - every target row defaults UNDECIDED, with explicit per-row Approve/Skip;
 *   - an explicit "Select all" button is allowed (a user action — it still
 *     produces the full explicit id list, never an approve-all wire member);
 *   - a live decided/total counter; Submit stays disabled until EVERY row is
 *     decided (and at least one row is approved — the resume schema requires
 *     min-1 ids, so an all-skip submit is contractually impossible: Decline is
 *     the way to stop);
 *   - Decline is always enabled and terminal (zero writes);
 *   - skipped rows render collapsed/muted with their reason — visible, never
 *     interactive.
 *
 * Submit posts through the EXISTING form-decision channel as action "accept"
 * with content {approved_dealer_ids: [...]} (only the approved rows' ids);
 * the server descriptor maps it onto the workflow's {action:"approve"} resume.
 */

import { useState } from "react";

/** The parsed suspend spec_inline this card renders. */
export interface BatchReviewSpec {
  question: string;
  targets: Array<{ dealer_id: string; name: string; website: string }>;
  skipped: Array<{ dealer_id: string; name: string; reason: string }>;
  totalTargets: number;
  totalInRadius: number;
  /** Opt-in (closeout-only): render a "Skip all & reset" action. Absent/false on
   *  every other batch_review payload → that button never renders there. */
  allowSkipAll: boolean;
}

/** Defensively read a batch_review spec_inline off the wire. Returns null on a
 *  malformed payload — the banner host then falls back to its never-hidden
 *  pending placeholder (a gate is never silently hidden, never mis-rendered). */
export function readBatchReviewSpec(spec: Record<string, unknown>): BatchReviewSpec | null {
  if (spec["kind"] !== "batch_review") return null;
  const targetsRaw = spec["targets"];
  const skippedRaw = spec["skipped"];
  if (!Array.isArray(targetsRaw) || !Array.isArray(skippedRaw)) return null;
  const targets: BatchReviewSpec["targets"] = [];
  for (const t of targetsRaw) {
    const row = t as { dealer_id?: unknown; name?: unknown; website?: unknown };
    if (typeof row.dealer_id !== "string" || typeof row.name !== "string" || typeof row.website !== "string") {
      return null;
    }
    targets.push({ dealer_id: row.dealer_id, name: row.name, website: row.website });
  }
  const skipped: BatchReviewSpec["skipped"] = [];
  for (const s of skippedRaw) {
    const row = s as { dealer_id?: unknown; name?: unknown; reason?: unknown };
    if (typeof row.dealer_id !== "string" || typeof row.name !== "string" || typeof row.reason !== "string") {
      return null;
    }
    skipped.push({ dealer_id: row.dealer_id, name: row.name, reason: row.reason });
  }
  const totalTargets = spec["total_targets"];
  const totalInRadius = spec["total_in_radius"];
  if (typeof totalTargets !== "number" || typeof totalInRadius !== "number") return null;
  // Optional opt-in flag; absent ⇒ false ⇒ no skip-all button (closeout-scoped).
  const allowSkipAll = spec["allow_skip_all"] === true;
  return {
    question: typeof spec["question"] === "string" ? spec["question"] : "Scan these dealers' inventory now?",
    targets,
    skipped,
    totalTargets,
    totalInRadius,
    allowSkipAll,
  };
}

/** The header line: full-radius default vs the max_targets-truncated form. */
export function batchHeaderLine(spec: Pick<BatchReviewSpec, "totalTargets" | "totalInRadius">): string {
  return spec.totalTargets === spec.totalInRadius
    ? `${spec.totalTargets} of ${spec.totalInRadius} in radius`
    : `${spec.totalTargets} of ${spec.totalInRadius} nearest shown`;
}

/** The website column shows the host only (the full URL is noise on a card). */
function websiteHost(website: string): string {
  try {
    return new URL(website).hostname;
  } catch {
    return website;
  }
}

type RowDecision = "approve" | "skip";

export function BatchReviewCard({
  spec,
  submitting,
  onApprove,
  onDecline,
  onSkipAll,
}: {
  spec: BatchReviewSpec;
  submitting: boolean;
  /** action "accept" with {approved_dealer_ids} — only the approved rows. */
  onApprove: (approvedDealerIds: string[]) => void;
  /** action "decline" — terminal, zero writes. */
  onDecline: () => void;
  /** action "accept" with {skip_all:true} — the closeout skip-all → reset
   *  hand-off; terminal, zero writes. Closeout-only: the button renders only
   *  when spec.allowSkipAll is set, so an absent handler ⇒ no button. */
  onSkipAll?: () => void;
}): JSX.Element {
  // Row decisions, keyed by dealer_id; an ABSENT key is the undecided default.
  const [decisions, setDecisions] = useState<Record<string, RowDecision>>({});

  const decide = (dealerId: string, decision: RowDecision): void =>
    setDecisions((d) => ({ ...d, [dealerId]: decision }));
  const selectAll = (): void =>
    setDecisions(Object.fromEntries(spec.targets.map((t) => [t.dealer_id, "approve" as const])));

  const decidedCount = spec.targets.filter((t) => decisions[t.dealer_id] !== undefined).length;
  const approvedIds = spec.targets
    .filter((t) => decisions[t.dealer_id] === "approve")
    .map((t) => t.dealer_id);
  const allDecided = decidedCount === spec.targets.length;
  // Submit needs every row decided AND >=1 approve (the resume schema's min-1:
  // an all-skip batch has nothing to scan — Decline is the stop verb).
  const canSubmit = allDecided && approvedIds.length > 0 && !submitting;

  return (
    <div className="gate-card sensitive" data-testid="batch-review-card" role="alertdialog" aria-label="Batch review">
      <strong>{spec.question}</strong>
      <p className="muted" data-testid="batch-header">
        {batchHeaderLine(spec)}
      </p>

      <div className="batch-rows">
        {spec.targets.map((t) => {
          const decision = decisions[t.dealer_id];
          return (
            <div
              className="batch-row"
              key={t.dealer_id}
              data-testid={`batch-row-${t.dealer_id}`}
              data-decision={decision ?? "undecided"}
            >
              <span className="batch-row-text">
                <strong>{t.name}</strong> <span className="muted">{websiteHost(t.website)}</span>
              </span>
              <button
                type="button"
                data-testid={`batch-approve-${t.dealer_id}`}
                aria-pressed={decision === "approve"}
                className={decision === "approve" ? "on" : ""}
                disabled={submitting}
                onClick={() => decide(t.dealer_id, "approve")}
              >
                Approve
              </button>
              <button
                type="button"
                data-testid={`batch-skip-${t.dealer_id}`}
                aria-pressed={decision === "skip"}
                className={decision === "skip" ? "on" : ""}
                disabled={submitting}
                onClick={() => decide(t.dealer_id, "skip")}
              >
                Skip
              </button>
            </div>
          );
        })}
      </div>

      {spec.skipped.length > 0 && (
        <details className="muted" data-testid="batch-skipped">
          <summary>{spec.skipped.length} skipped (not scannable)</summary>
          <ul>
            {spec.skipped.map((s) => (
              <li key={s.dealer_id} data-testid={`batch-skipped-${s.dealer_id}`}>
                {s.name} — {s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="gate-actions">
        <button type="button" data-testid="batch-select-all" disabled={submitting} onClick={selectAll}>
          Select all
        </button>
        <span className="muted" data-testid="batch-counter">
          {decidedCount}/{spec.targets.length} decided
        </span>
        <button
          type="button"
          className="btn-primary"
          data-testid="batch-submit"
          disabled={!canSubmit}
          onClick={() => onApprove(approvedIds)}
        >
          Scan approved dealers
        </button>
        <button
          type="button"
          className="btn-danger"
          data-testid="batch-decline"
          disabled={submitting}
          onClick={onDecline}
        >
          Decline
        </button>
        {spec.allowSkipAll && onSkipAll && (
          // A DISTINCT terminal intent: "send none AND hand off to reset" — its
          // own verb (like Decline), always enabled, independent of row decisions.
          <button
            type="button"
            className="btn-danger"
            data-testid="batch-skip-all"
            disabled={submitting}
            onClick={onSkipAll}
          >
            Skip all &amp; reset
          </button>
        )}
      </div>
      {allDecided && approvedIds.length === 0 && (
        <p className="muted" data-testid="batch-zero-approved-hint">
          Nothing approved — use Decline to cancel the scan.
        </p>
      )}
    </div>
  );
}
