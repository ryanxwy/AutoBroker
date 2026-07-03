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

import { ReviewDecisionList } from "./ReviewDecisionList.js";

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
  /** The primary submit button's label. Absent ⇒ the inventory-scan verb;
   *  lead-submit/closeout/negotiation set their own send verb so the same card
   *  reads correctly for every gate (the question is already payload-driven). */
  submitLabel?: string;
  /** Opt-in submission preview: the MINIMAL info each approved item receives,
   *  rendered as a labelled block above the list so the user sees exactly what
   *  is sent before approving. Absent ⇒ no summary block (e.g. read-only gates).
   *  Explicit `| undefined` so `readSummary`'s undefined return assigns under
   *  exactOptionalPropertyTypes. */
  summary?: { heading: string; lines: Array<{ label: string; value: string }> } | undefined;
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
    submitLabel:
      typeof spec["submit_label"] === "string" ? spec["submit_label"] : "Scan approved dealers",
    summary: readSummary(spec["summary"]),
  };
}

/** Defensively read the optional submission-preview block. Any malformed shape
 *  (or absence) ⇒ undefined ⇒ no summary block renders — never a thrown gate. */
function readSummary(raw: unknown): BatchReviewSpec["summary"] {
  if (typeof raw !== "object" || raw === null) return undefined;
  const heading = (raw as { heading?: unknown }).heading;
  const linesRaw = (raw as { lines?: unknown }).lines;
  if (typeof heading !== "string" || !Array.isArray(linesRaw)) return undefined;
  const lines: Array<{ label: string; value: string }> = [];
  for (const l of linesRaw) {
    const row = l as { label?: unknown; value?: unknown };
    if (typeof row.label !== "string" || typeof row.value !== "string") return undefined;
    lines.push({ label: row.label, value: row.value });
  }
  return { heading, lines };
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
  return (
    <ReviewDecisionList
      cardTestId="batch-review-card"
      ariaLabel="Batch review"
      testidPrefix="batch"
      rowsTestId="batch-rows"
      submitLabel={spec.submitLabel ?? "Scan approved dealers"}
      zeroApprovedHint="Nothing approved — use Decline to cancel the scan."
      submitting={submitting}
      onApprove={onApprove}
      onDecline={onDecline}
      beforeRows={
        <>
          <strong>{spec.question}</strong>
          <p className="muted" data-testid="batch-header">
            {batchHeaderLine(spec)}
          </p>

          {spec.summary && (
            <div className="batch-summary" data-testid="batch-summary">
              <p className="batch-summary-heading">{spec.summary.heading}</p>
              <dl>
                {spec.summary.lines.map((line) => (
                  <div className="batch-summary-line" key={line.label} data-testid={`batch-summary-${line.label}`}>
                    <dt>{line.label}</dt>
                    <dd>{line.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </>
      }
      rows={spec.targets.map((t) => ({
        id: t.dealer_id,
        body: (
          <span className="batch-row-text">
            <strong>{t.name}</strong> <span className="muted">{websiteHost(t.website)}</span>
          </span>
        ),
      }))}
      afterRows={
        spec.skipped.length > 0 ? (
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
        ) : undefined
      }
      footerExtra={
        // A DISTINCT terminal intent: "send none AND hand off to reset" — its
        // own verb (like Decline), always enabled, independent of row decisions.
        // Closeout-only: renders only when allowSkipAll is set AND a handler is
        // passed, so an absent handler ⇒ no button.
        spec.allowSkipAll && onSkipAll ? (
          <button
            type="button"
            className="btn-danger"
            data-testid="batch-skip-all"
            disabled={submitting}
            onClick={onSkipAll}
          >
            Skip all &amp; reset
          </button>
        ) : undefined
      }
    />
  );
}
