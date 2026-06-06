/**
 * ResumeBanner — "Pick up where you left off". Surfaces when
 * a same-runId draft was restored on mount. Continue keeps the restored values
 * (just dismisses the banner); Start fresh clears the draft and resets to the
 * prefill seed. The relative "5m ago" is derived from the draft's savedAt.
 */

/** Render an epoch-ms as a coarse relative time ("just now" / "5m ago" / "3h ago"). */
export function relativeTime(savedAt: number, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - savedAt) / 1000));
  if (sec < 30) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

export function ResumeBanner({
  savedAt,
  onContinue,
  onStartFresh,
}: {
  savedAt: number;
  onContinue: () => void;
  onStartFresh: () => void;
}): JSX.Element {
  return (
    <div className="resume-banner" role="status" data-testid="resume-banner">
      <span>
        Pick up where you left off — draft saved {relativeTime(savedAt)}.
      </span>
      <span className="spacer" style={{ flex: 1 }} />
      <button type="button" data-testid="resume-continue" onClick={onContinue}>
        Continue
      </button>
      <button type="button" data-testid="resume-start-fresh" onClick={onStartFresh}>
        Start fresh
      </button>
    </div>
  );
}
