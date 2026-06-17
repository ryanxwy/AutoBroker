# Task 1 Report: Pager + usePagedList pagination primitives

## Status: DONE

## Commit
`f604f43` — `phase0/canvas_ia: pager + usePagedList pagination primitives`

---

## Public API Shipped

### `usePagedList<T>(items: T[], pageSize: number): PagedList<T>`

Located at `apps/ui/src/canvas/usePagedList.ts`.

`PagedList<T>` shape:

| Field | Type | Description |
|---|---|---|
| `page` | `number` | 1-based current page |
| `pageCount` | `number` | >= 1; ceil(total/pageSize), min 1 |
| `total` | `number` | items.length |
| `pageItems` | `T[]` | current page's slice |
| `rangeStart` | `number` | 1-based inclusive first index (0 when total=0) |
| `rangeEnd` | `number` | 1-based inclusive last index (0 when total=0) |
| `setPage` | `(n: number) => void` | clamps to [1, pageCount] |
| `prev` | `() => void` | moves back one page; no-op at page 1 |
| `next` | `() => void` | moves forward one page; no-op at last page |
| `canPrev` | `boolean` | false on page 1 |
| `canNext` | `boolean` | false on last page |

Reset behavior: `useEffect` keyed on `[items, pageSize]` calls `setPage(1)` whenever items identity or pageSize changes.

---

### `Pager` component

Located at `apps/ui/src/canvas/Pager.tsx`.

Props:
```ts
interface PagerProps {
  page: number;
  pageCount: number;
  total: number;
  rangeStart: number;
  rangeEnd: number;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
  noun?: string;  // default "items"
}
```

- Returns `null` when `pageCount <= 1`.
- Range label format: `` `${rangeStart}–${rangeEnd} of ${total} ${noun}` `` (en-dash U+2013).

Stable testids:
| testid | Element |
|---|---|
| `canvas-pager` | root `<div>` |
| `canvas-pager-prev` | Prev `<button>` |
| `canvas-pager-next` | Next `<button>` |
| `canvas-pager-range` | count `<span>` |

---

## Files Changed

| File | Change |
|---|---|
| `apps/ui/src/canvas/usePagedList.ts` | new — pagination hook |
| `apps/ui/src/canvas/usePagedList.test.ts` | new — 16 tests |
| `apps/ui/src/canvas/Pager.tsx` | new — presentational component |
| `apps/ui/src/canvas/Pager.test.tsx` | new — 7 tests |
| `apps/ui/src/styles.css` | added `.canvas-pager` rule set (~20 lines at end) |

---

## Test command + output

```
npx vitest run apps/ui/src/canvas/usePagedList.test.ts apps/ui/src/canvas/Pager.test.tsx

 Test Files  2 passed (2)
      Tests  23 passed (23)
   Start at  00:31:50
   Duration  542ms
```

`pnpm typecheck` also passes (zero errors).

---

## Concerns

None. Implementation is minimal — `useState` + `useMemo` + `useEffect` only, no external deps. Tests drive the hook through a thin wrapper component (no `@testing-library/react`; that dep is not in this project).

---

## Fix note — commit `9a4baf5` (phase0/canvas_ia: stabilize pager callbacks (useCallback))

**What changed:**

1. `apps/ui/src/canvas/usePagedList.ts` — imported `useCallback` from "react"; wrapped `setPage` with `useCallback([pageCount])` so its identity is stable across renders (only changes when the page count changes); wrapped `prev` and `next` with `useCallback([page, setPage])` / `[page, pageCount, setPage]` respectively — they preserve the existing clamp-and-no-op behavior but now have stable identities for `React.memo` children and `useEffect` dep arrays.

2. `apps/ui/src/styles.css` — added `cursor: pointer` to the `.canvas-pager button` rule (the enabled-button block), leaving the existing `cursor: not-allowed` on `:disabled` intact.

**Test command + output:**

```
npx vitest run apps/ui/src/canvas/usePagedList.test.ts apps/ui/src/canvas/Pager.test.tsx

 Test Files  2 passed (2)
      Tests  23 passed (23)
   Start at  00:36:12
   Duration  538ms
```

`pnpm typecheck` also clean (zero errors).
