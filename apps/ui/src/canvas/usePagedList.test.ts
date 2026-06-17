// @vitest-environment happy-dom
/**
 * usePagedList.test — pagination hook. Proves slicing, clamp, reset-on-change,
 * boundary conditions, and the empty-list edge case.
 *
 * No @testing-library/react — we drive the hook through a thin wrapper component
 * rendered with the project's own render() helper (react-dom/client + act).
 */

import { act } from "react";
import { describe, expect, it } from "vitest";

import { render } from "../test/render.js";
import { usePagedList, type PagedList } from "./usePagedList.js";

// ---------------------------------------------------------------------------
// Test harness — a wrapper component that exposes the hook result via a ref.
// ---------------------------------------------------------------------------
import { createElement, type ReactElement } from "react";

function makeHarness<T>(
  items: T[],
  pageSize: number,
): { el: ReactElement; ref: { current: PagedList<T> | null } } {
  const ref: { current: PagedList<T> | null } = { current: null };
  function Harness(): null {
    ref.current = usePagedList(items, pageSize);
    return null;
  }
  return { el: createElement(Harness), ref };
}

const ITEMS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]; // 10 items

describe("usePagedList — basic slicing", () => {
  it("first page returns the first pageSize items", () => {
    const h = makeHarness(ITEMS, 4);
    render(h.el);
    const r = h.ref.current!;
    expect(r.page).toBe(1);
    expect(r.pageCount).toBe(3); // ceil(10/4)
    expect(r.total).toBe(10);
    expect(r.pageItems).toEqual(["a", "b", "c", "d"]);
    expect(r.rangeStart).toBe(1);
    expect(r.rangeEnd).toBe(4);
  });

  it("middle page slices correctly", () => {
    const h = makeHarness(ITEMS, 4);
    render(h.el);
    act(() => h.ref.current!.next());
    const r = h.ref.current!;
    expect(r.page).toBe(2);
    expect(r.pageItems).toEqual(["e", "f", "g", "h"]);
    expect(r.rangeStart).toBe(5);
    expect(r.rangeEnd).toBe(8);
  });

  it("last page returns the remaining items (not a full page)", () => {
    const h = makeHarness(ITEMS, 4);
    render(h.el);
    act(() => h.ref.current!.setPage(3));
    const r = h.ref.current!;
    expect(r.page).toBe(3);
    expect(r.pageItems).toEqual(["i", "j"]);
    expect(r.rangeStart).toBe(9);
    expect(r.rangeEnd).toBe(10);
  });
});

describe("usePagedList — navigation + clamping", () => {
  it("canPrev is false on page 1, canNext is false on last page", () => {
    const h = makeHarness(ITEMS, 4);
    render(h.el);
    expect(h.ref.current!.canPrev).toBe(false);
    expect(h.ref.current!.canNext).toBe(true);

    act(() => h.ref.current!.setPage(3));
    expect(h.ref.current!.canPrev).toBe(true);
    expect(h.ref.current!.canNext).toBe(false);
  });

  it("prev() is a no-op on page 1 (does not underflow)", () => {
    const h = makeHarness(ITEMS, 4);
    render(h.el);
    act(() => h.ref.current!.prev());
    expect(h.ref.current!.page).toBe(1);
  });

  it("next() is a no-op on the last page (does not overflow)", () => {
    const h = makeHarness(ITEMS, 4);
    render(h.el);
    act(() => h.ref.current!.setPage(3));
    act(() => h.ref.current!.next());
    expect(h.ref.current!.page).toBe(3);
  });

  it("setPage() clamps below 1 to 1", () => {
    const h = makeHarness(ITEMS, 4);
    render(h.el);
    act(() => h.ref.current!.setPage(0));
    expect(h.ref.current!.page).toBe(1);
  });

  it("setPage() clamps above pageCount to pageCount", () => {
    const h = makeHarness(ITEMS, 4);
    render(h.el);
    act(() => h.ref.current!.setPage(99));
    expect(h.ref.current!.page).toBe(3);
  });
});

describe("usePagedList — reset on data/pageSize change", () => {
  it("resets to page 1 when items identity changes", () => {
    let items = ITEMS;
    let pageSize = 4;

    // We need a mutable-closure harness for this test.
    const ref: { current: PagedList<string> | null } = { current: null };
    function Harness(): null {
      ref.current = usePagedList(items, pageSize);
      return null;
    }
    const { rerender } = render(createElement(Harness));

    act(() => ref.current!.setPage(2));
    expect(ref.current!.page).toBe(2);

    // Replace with a new array identity (simulates a data reload).
    items = [...ITEMS];
    rerender(createElement(Harness));
    expect(ref.current!.page).toBe(1);
  });

  it("resets to page 1 when pageSize changes", () => {
    let items = ITEMS;
    let pageSize = 4;

    const ref: { current: PagedList<string> | null } = { current: null };
    function Harness(): null {
      ref.current = usePagedList(items, pageSize);
      return null;
    }
    const { rerender } = render(createElement(Harness));

    act(() => ref.current!.setPage(2));
    expect(ref.current!.page).toBe(2);

    pageSize = 5;
    rerender(createElement(Harness));
    expect(ref.current!.page).toBe(1);
  });
});

describe("usePagedList — empty list", () => {
  it("empty list: pageCount=1, page=1, pageItems=[], range 0-0", () => {
    const h = makeHarness([], 5);
    render(h.el);
    const r = h.ref.current!;
    expect(r.page).toBe(1);
    expect(r.pageCount).toBe(1);
    expect(r.total).toBe(0);
    expect(r.pageItems).toEqual([]);
    expect(r.rangeStart).toBe(0);
    expect(r.rangeEnd).toBe(0);
    expect(r.canPrev).toBe(false);
    expect(r.canNext).toBe(false);
  });
});

describe("usePagedList — exact-page-boundary (total divisible by pageSize)", () => {
  it("8 items / 4 per page = 2 pages, last page is full", () => {
    const h = makeHarness(ITEMS.slice(0, 8), 4);
    render(h.el);
    act(() => h.ref.current!.setPage(2));
    const r = h.ref.current!;
    expect(r.pageCount).toBe(2);
    expect(r.pageItems).toEqual(["e", "f", "g", "h"]);
    expect(r.rangeStart).toBe(5);
    expect(r.rangeEnd).toBe(8);
  });
});
