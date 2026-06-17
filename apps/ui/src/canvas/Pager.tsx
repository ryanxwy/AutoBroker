/**
 * Pager — a presentational pagination bar in the Showroom-Ledger skin.
 * Renders nothing when pageCount <= 1 (a single page needs no controls).
 * When rendered: a range count label ("6–10 of 25 threads") plus Prev/Next
 * buttons. Consumes the PagedList shape from usePagedList but accepts plain
 * props so it stays testable without the hook.
 *
 * Stable testids (committed selector surface):
 *   canvas-pager       — root container
 *   canvas-pager-prev  — Prev button
 *   canvas-pager-next  — Next button
 *   canvas-pager-range — count label
 */

export interface PagerProps {
  page: number;
  pageCount: number;
  total: number;
  rangeStart: number;
  rangeEnd: number;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
  /** Optional noun appended to the range label, e.g. "threads". Default "items". */
  noun?: string;
}

export function Pager({
  pageCount,
  total,
  rangeStart,
  rangeEnd,
  onPrev,
  onNext,
  canPrev,
  canNext,
  noun = "items",
}: PagerProps): JSX.Element | null {
  if (pageCount <= 1) return null;

  return (
    <div className="canvas-pager" data-testid="canvas-pager">
      <button
        type="button"
        data-testid="canvas-pager-prev"
        disabled={!canPrev}
        onClick={onPrev}
      >
        Prev
      </button>
      <span className="canvas-pager-range" data-testid="canvas-pager-range">
        {rangeStart}–{rangeEnd} of {total} {noun}
      </span>
      <button
        type="button"
        data-testid="canvas-pager-next"
        disabled={!canNext}
        onClick={onNext}
      >
        Next
      </button>
    </div>
  );
}
