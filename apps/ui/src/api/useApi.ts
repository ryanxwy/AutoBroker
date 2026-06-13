/**
 * useApi — a minimal async-data hook over the typed ApiClient (the server-state
 * cache). Pulling in @tanstack/react-query (a real runtime dependency) for a
 * handful of one-shot GETs (skills / profiles / mode / status) is more machinery
 * than this needs; a ~40-line useAsync with refetch + cancel-on-unmount covers
 * the read paths without a new dep. Query keys / cache invalidation /
 * background refetch are a later upgrade if the read surface grows.
 *
 * Dependency wall: app/ui layer. react + the typed client only.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "./client.js";

export type AsyncState<T> =
  | { kind: "loading" }
  | { kind: "ok"; data: T }
  | { kind: "error"; message: string; code: string };

function toMessage(err: unknown): { message: string; code: string } {
  if (err instanceof ApiError) return { message: err.message, code: err.code };
  if (err instanceof Error) return { message: err.message, code: "error" };
  return { message: "unknown error", code: "error" };
}

/**
 * Run `fetcher` on mount (and when `deps` change), exposing loading/ok/error +
 * a manual `refetch`. Cancels state writes after unmount. `enabled=false` keeps
 * it idle (loading) without firing — used to gate a fetch on a present id.
 *
 * STALE-WHILE-REVALIDATE: a `refetch()` (or a deps-change re-run) does NOT drop
 * back to `loading` when there is already `ok` data — the last good `data` stays
 * rendered while the new GET is in flight, then swaps in once it resolves. The
 * `loading` state shows ONLY for the first load (no data yet). This keeps a
 * component that reads `data` from unmounting/flickering on every auto-refresh
 * (a data.changed pulse or a window refocus): the discriminant never leaves
 * `ok` for an already-loaded view during a background refresh.
 *
 * Error-on-refetch: a failing refetch surfaces the `error` state (replacing the
 * stale data), the same as a first-load failure. The read views all render an
 * error banner, so keeping stale rows while silently swallowing a fetch error
 * would hide a real failure — surfacing it is the least-surprising choice here.
 *
 * `refreshing` is true only while a background refetch is in flight over
 * existing data (never during the first load); consumers MAY use it for a subtle
 * indicator but are not required to.
 */
export function useAsync<T>(
  fetcher: () => Promise<T>,
  deps: ReadonlyArray<unknown> = [],
  enabled = true,
): AsyncState<T> & { refetch: () => void; refreshing: boolean } {
  const [state, setState] = useState<AsyncState<T>>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  // The latest state, read inside `run` without making it a dep of the run
  // callback (run must stay useCallback-stable for the data.changed bus).
  const stateRef = useRef(state);
  stateRef.current = state;

  const run = useCallback(() => {
    // Keep the prior `ok` data on screen during a refetch; only the first load
    // (no data yet) shows the loading state.
    if (stateRef.current.kind === "ok") {
      setRefreshing(true);
    } else {
      setState({ kind: "loading" });
    }
    fetcherRef.current()
      .then((data) => {
        if (mounted.current) {
          setState({ kind: "ok", data });
          setRefreshing(false);
        }
      })
      .catch((err: unknown) => {
        if (mounted.current) {
          setState({ kind: "error", ...toMessage(err) });
          setRefreshing(false);
        }
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (enabled) run();
    return () => {
      mounted.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);

  return { ...state, refetch: run, refreshing };
}
