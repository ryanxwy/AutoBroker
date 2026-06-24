/**
 * useDataChanged — the fresh-by-default refetch bus. A data-writing skill ends
 * with a `data.changed{profile_id, kinds}` pulse on its run stream (runPubSub
 * → /stream-v2 → App.onData); this module turns that pulse into a targeted
 * refetch of exactly the read views that render those data families, so the
 * dashboard reflects a write WITHOUT a manual page/Electron reload.
 *
 * THE BUS: views register a refetcher under the data KINDS they render
 * (Canvas's profile list → "profiles"; its dealer tiles → "dealers"; …). App
 * calls `invalidate(kinds, profileId)` when a data.changed part arrives; every
 * refetcher registered under an intersecting kind fires — UNLESS it opted into a
 * profile SCOPE that the pulse's profile_id doesn't match.
 *
 * PROFILE SCOPE (Phase 3, multi-profile): a refetcher may register with an
 * optional `profileScope`. A scoped refetcher fires only when the pulse names
 * the SAME profile (or names no profile — a global/headless write). An
 * unscoped (scope === null) refetcher always fires — backward-compatible with
 * every existing caller (the profile LIST refetch, sessions, etc.). So a write
 * in profile A no longer refetches profile B's canvas reads. A pulse with a null
 * profile_id (headless/unpinned terminal) still refetches everything matching
 * the kinds — the broad-but-safe default.
 *
 * FRESH-ON-REFOCUS: a single set of window `focus` + document `visibilitychange`
 * listeners refetches EVERY registered refetcher when the tab/Electron window
 * re-activates (the user may have written data elsewhere, or a background run
 * finished while hidden). Refocus ignores scope (refresh everything visible).
 *
 * IDEMPOTENT BY CONSTRUCTION: a refetch is a plain GET that overwrites the
 * view's state with the latest rows; a replayed data.changed just triggers
 * another harmless GET — no double counting.
 *
 * Dependency wall: app/ui layer. react only.
 */

import { useEffect } from "react";

/** A registered refetcher: a zero-arg trigger (useAsync's refetch). */
type Refetch = () => void;

/** One registration: the refetcher + its optional profile scope (null = fires
 *  for every profile, the unscoped default). */
interface Entry {
  refetch: Refetch;
  scope: string | null;
}

/** The module-level registry: kind → the set of registrations for views that
 *  render that kind. A view registers under one-or-more kinds; one refetcher
 *  may sit under several kinds (it appears in each set) — deduped at fire time
 *  by refetcher identity. */
const REGISTRY = new Map<string, Set<Entry>>();

/** Register a refetcher (with an optional profile scope) under each kind;
 *  returns the unregister cleanup. */
function register(
  kinds: readonly string[],
  refetch: Refetch,
  scope: string | null,
): () => void {
  const entry: Entry = { refetch, scope };
  for (const kind of kinds) {
    let set = REGISTRY.get(kind);
    if (set === undefined) {
      set = new Set();
      REGISTRY.set(kind, set);
    }
    set.add(entry);
  }
  return () => {
    for (const kind of kinds) {
      const set = REGISTRY.get(kind);
      if (set === undefined) continue;
      set.delete(entry);
      if (set.size === 0) REGISTRY.delete(kind);
    }
  };
}

/** A scoped refetcher fires iff it is unscoped, OR the pulse names no profile,
 *  OR the scopes match. (Unscoped refetcher + scoped pulse → fires; scoped
 *  refetcher + null pulse → fires — both the broad-but-safe direction.) */
function scopeMatches(scope: string | null, profileId: string | null): boolean {
  return scope === null || profileId === null || scope === profileId;
}

/**
 * Refetch every view that renders any of `kinds` AND whose profile scope matches
 * `profileId` (deduped — a refetcher under two named kinds fires once). Called
 * by App when a data.changed part arrives. `profileId` defaults to null (a
 * global pulse — refetch everything matching the kinds). Unknown kinds match
 * nothing.
 */
export function invalidate(kinds: readonly string[], profileId: string | null = null): void {
  const seen = new Set<Refetch>();
  for (const kind of kinds) {
    const set = REGISTRY.get(kind);
    if (set === undefined) continue;
    for (const entry of set) {
      if (seen.has(entry.refetch)) continue;
      // Only claim the dedup slot when this entry ACTUALLY fires: a refetcher
      // registered under two kinds with DIFFERENT scopes must still fire via its
      // matching entry even if a non-matching entry is encountered first.
      if (scopeMatches(entry.scope, profileId)) {
        seen.add(entry.refetch);
        entry.refetch();
      }
    }
  }
}

/** Refetch EVERY registered view (the refocus path — any of them may be stale).
 *  Ignores scope: a refocus refreshes everything currently mounted. */
function invalidateAll(): void {
  const seen = new Set<Refetch>();
  for (const set of REGISTRY.values()) {
    for (const entry of set) {
      if (seen.has(entry.refetch)) continue;
      seen.add(entry.refetch);
      entry.refetch();
    }
  }
}

/**
 * Register a view's `refetch` under the data `kinds` it renders, for the view's
 * lifetime (re-registers if kinds/refetch/scope identity change). A data.changed
 * for an intersecting kind whose pulse profile matches `profileScope`, OR a
 * window refocus, then refetches it in place. `profileScope` defaults to null
 * (fires for every profile) — the byte-identical behavior for every existing
 * single-profile caller. A multi-profile view passes its own profile id to scope
 * the refetch to writes for THAT profile.
 */
export function useDataRefetch(
  kinds: readonly string[],
  refetch: Refetch,
  profileScope: string | null = null,
): void {
  useEffect(() => register(kinds, refetch, profileScope), [kinds, refetch, profileScope]);
}

/**
 * Install the fresh-on-refocus listeners ONCE (App mounts this once). A window
 * `focus` or a `visibilitychange` to visible refetches every registered view.
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
