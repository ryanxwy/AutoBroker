/**
 * usePagedList — a pure React hook for paginating an in-memory list.
 * Keeps a 1-based current page, derives the visible slice and boundary
 * flags, and resets to page 1 whenever the items reference or pageSize
 * changes (so stale page numbers don't survive data refreshes).
 *
 * No external deps — useState + useMemo + useEffect from "react" only.
 */

import { useEffect, useMemo, useState } from "react";

/** The full pagination state returned by usePagedList. */
export interface PagedList<T> {
  /** 1-based current page. */
  page: number;
  /** Total number of pages (>= 1; minimum 1 even for an empty list). */
  pageCount: number;
  /** Total item count (items.length). */
  total: number;
  /** The items on the current page. */
  pageItems: T[];
  /** 1-based index of the first item on the current page (0 when total=0). */
  rangeStart: number;
  /** 1-based index of the last item on the current page (0 when total=0). */
  rangeEnd: number;
  /** Navigate to a specific page; clamps to [1, pageCount]. */
  setPage: (n: number) => void;
  /** Move to the previous page; no-op when already on page 1. */
  prev: () => void;
  /** Move to the next page; no-op when already on the last page. */
  next: () => void;
  /** True when the current page is not page 1. */
  canPrev: boolean;
  /** True when the current page is not the last page. */
  canNext: boolean;
}

export function usePagedList<T>(items: T[], pageSize: number): PagedList<T> {
  const [page, setPageRaw] = useState(1);

  const pageCount = useMemo(
    () => Math.max(1, Math.ceil(items.length / pageSize)),
    [items, pageSize],
  );

  // Reset to page 1 whenever the items reference or pageSize changes.
  useEffect(() => {
    setPageRaw(1);
  }, [items, pageSize]);

  const setPage = (n: number): void => {
    setPageRaw(Math.max(1, Math.min(pageCount, n)));
  };

  const pageItems = useMemo(() => {
    const start = (page - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, page, pageSize]);

  const total = items.length;
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeEnd = total === 0 ? 0 : Math.min(page * pageSize, total);

  return {
    page,
    pageCount,
    total,
    pageItems,
    rangeStart,
    rangeEnd,
    setPage,
    prev: () => setPage(page - 1),
    next: () => setPage(page + 1),
    canPrev: page > 1,
    canNext: page < pageCount,
  };
}
