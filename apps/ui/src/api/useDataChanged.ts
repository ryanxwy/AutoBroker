/**
 * useDataChanged — the fresh-by-default refetch bus. A data-writing skill ends
 * with a `data.changed{profile_id, kinds}` pulse on its run stream (runPubSub
 * → /stream-v2 → App.onData); this module turns that pulse into a targeted
 * refetch of exactly the read views that render those data families, so the
 * dashboard reflects a write WITHOUT a manual page/Electron reload.
 *
 * THE BUS: views register a refetcher under the data KINDS they render
 * (Canvas's profile list → "profiles"; its dealer tiles → "dealers"; …). App
 * calls `invalidate(kinds)` when a data.changed part arrives; every refetcher
 * registered under an intersecting kind fires. There is no query library — this
 * is a ~ small registry over the existing useAsync refetch (a later upgrade if
 * the read surface grows). Refetch-on-mount is already useAsync's default; this
 * adds refetch-on-data.changed and refetch-on-refocus.
 *
 * FRESH-ON-REFOCUS: a single set of window `focus` + document `visibilitychange`
 * listeners refetches EVERY registered refetcher when the tab/Electron window
 * re-activates (the user may have written data elsewhere, or a background run
 * finished while hidden). Electron surfaces dock/window re-activation to the
 * page as these same events, so no native nudge is needed.
 *
 * IDEMPOTENT BY CONSTRUCTION: a refetch is a plain GET that overwrites the
 * view's state with the latest rows; a replayed data.changed (reconnect/replay
 * re-delivers the logged frame) just triggers another harmless GET — no double
 * counting, no accumulation. transport.ts already skips the already-delivered
 * replay prefix, so a clean reconnect re-delivers nothing; even if it did, the
 * refetch is safe.
 *
 * Dependency wall: app/ui layer. react only.
 */

import { useEffect } from "react";

/** A registered refetcher: a zero-arg trigger (useAsync's refetch). */
type Refetch = () => void;

/** The module-level registry: kind → the set of refetchers for views that
 *  render that kind. A view registers under one-or-more kinds; one refetcher
 *  may sit under several kinds (it appears in each set). */
const REGISTRY = new Map<string, Set<Refetch>>();

/** Register a refetcher under each kind; returns the unregister cleanup. */
function register(kinds: readonly string[], refetch: Refetch): () => void {
  for (const kind of kinds) {
    let set = REGISTRY.get(kind);
    if (set === undefined) {
      set = new Set();
      REGISTRY.set(kind, set);
    }
    set.add(refetch);
  }
  return () => {
    for (const kind of kinds) {
      const set = REGISTRY.get(kind);
      if (set === undefined) continue;
      set.delete(refetch);
      if (set.size === 0) REGISTRY.delete(kind);
    }
  };
}

/**
 * Refetch every view that renders any of `kinds` (deduped — a refetcher under
 * two named kinds fires once). Called by App when a data.changed part arrives.
 * Unknown kinds simply match nothing. Profile-scoped refetch is the refetcher's
 * own business: a list refetcher re-pulls the whole list (the active row is
 * what the Canvas projects), so naming the profile is informational only.
 */
export function invalidate(kinds: readonly string[]): void {
  const seen = new Set<Refetch>();
  for (const kind of kinds) {
    const set = REGISTRY.get(kind);
    if (set === undefined) continue;
    for (const refetch of set) {
      if (seen.has(refetch)) continue;
      seen.add(refetch);
      refetch();
    }
  }
}

/** Refetch EVERY registered view (the refocus path — any of them may be stale). */
function invalidateAll(): void {
  const seen = new Set<Refetch>();
  for (const set of REGISTRY.values()) {
    for (const refetch of set) {
      if (seen.has(refetch)) continue;
      seen.add(refetch);
      refetch();
    }
  }
}

/**
 * Register a view's `refetch` under the data `kinds` it renders, for the view's
 * lifetime (re-registers if kinds/refetch identity change). A data.changed for
 * an intersecting kind, OR a window refocus, then refetches it in place. The
 * refetch identity should be stable (useAsync's refetch is useCallback-stable);
 * `kinds` should be a stable literal array.
 */
export function useDataRefetch(kinds: readonly string[], refetch: Refetch): void {
  useEffect(() => register(kinds, refetch), [kinds, refetch]);
}

/**
 * Install the fresh-on-refocus listeners ONCE (App mounts this once). A window
 * `focus` or a `visibilitychange` to visible refetches every registered view.
 * Idempotent GETs make a spurious double-fire (some platforms emit both)
 * harmless.
 */
export function useRefocusRefetch(): void {
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === "visible") invalidateAll();
    };
    const onFocus = (): void => invalidateAll();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}

/** Test-only: clear the registry between isolated cases. */
export function resetDataRefetchForTests(): void {
  REGISTRY.clear();
}
