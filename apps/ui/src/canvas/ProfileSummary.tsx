/**
 * ProfileSummary — a persistent sticky bento header that surfaces the
 * active search's key numbers at a glance. Presentational ONLY: it takes
 * scalar props (no API client, no async) and is mounted by Canvas which
 * already holds all the async reads. Replaces the standalone TodaysDigest
 * section, folding the digest headline + bestOtd up to a sticky top bar.
 *
 * Budget red-line: `bestOtd` is the user's OWN collected offer (rendered).
 * Budget is NEVER a prop and NEVER shown here.
 */

export interface ProfileSummaryProps {
  bestOtd: number | null;
  dealerCount: number | null;
  quoteCount: number | null;
  threadCount: number | null;
  needsReplyCount: number | null;
  inventoryRecommended: number | null;
  inventoryTotal: number | null;
  headline: string | null;
}

/** "$35,500" (no cents), or null when value is null. */
function fmtOtd(value: number | null): string {
  if (value === null) return "—";
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function fmtCount(value: number | null): string {
  if (value === null) return "—";
  return String(value);
}

export function ProfileSummary({
  bestOtd,
  dealerCount,
  quoteCount,
  threadCount,
  needsReplyCount,
  inventoryRecommended,
  inventoryTotal,
  headline,
}: ProfileSummaryProps): JSX.Element {
  const inventoryLabel =
    inventoryTotal !== null && inventoryTotal > 0
      ? `${inventoryRecommended ?? 0} rec / ${inventoryTotal}`
      : "—";

  return (
    <header className="canvas-summary" data-testid="canvas-summary">
      {/* Hero tile — best out-the-door (the user's own collected offer) */}
      <div className="canvas-summary-hero">
        <span className="canvas-summary-num" data-testid="canvas-summary-best-otd">
          {fmtOtd(bestOtd)}
        </span>
        <span className="canvas-summary-label">Best OTD</span>
      </div>

      {/* Secondary stat tiles */}
      <div className="canvas-summary-tiles">
        <div className="canvas-summary-tile">
          <span className="canvas-summary-num">{fmtCount(dealerCount)}</span>
          <span className="canvas-summary-label">Dealers</span>
        </div>
        <div className="canvas-summary-tile">
          <span className="canvas-summary-num">{fmtCount(quoteCount)}</span>
          <span className="canvas-summary-label">Quotes</span>
        </div>
        <div className="canvas-summary-tile">
          <span className="canvas-summary-num">{fmtCount(threadCount)}</span>
          <span className="canvas-summary-label">
            Replies
            {needsReplyCount !== null && needsReplyCount > 0 && (
              <span className="canvas-summary-chip" data-testid="canvas-summary-needs-reply">
                {needsReplyCount} need reply
              </span>
            )}
          </span>
        </div>
        <div className="canvas-summary-tile">
          <span className="canvas-summary-num">{inventoryLabel}</span>
          <span className="canvas-summary-label">Inventory</span>
        </div>
      </div>

      {/* Optional headline from digest — serif italic, muted */}
      {headline !== null && (
        <p className="canvas-summary-headline" data-testid="canvas-summary-headline">
          {headline}
        </p>
      )}
    </header>
  );
}
