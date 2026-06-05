/**
 * useApi — a minimal async-data hook over the typed ApiClient (FRONTEND_LAYOUT §9.1
 * "服务端缓存" row). The spec names TanStack Query for this slice, but pulling in
 * @tanstack/react-query (a real runtime dependency) for a handful of one-shot GETs
 * (skills / profiles / mode / status) is more machinery than this milestone needs;
 * a ~40-line useAsync with refetch + cancel-on-unmount covers the read paths
 * without a new dep (recorded in design_notes). Query keys / cache invalidation /
 * background refetch are a post-M2 upgrade if the read surface grows.
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
 */
export function useAsync<T>(
  fetcher: () => Promise<T>,
  deps: ReadonlyArray<unknown> = [],
  enabled = true,
): AsyncState<T> & { refetch: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ kind: "loading" });
  const mounted = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(() => {
    setState({ kind: "loading" });
    fetcherRef.current()
      .then((data) => {
        if (mounted.current) setState({ kind: "ok", data });
      })
      .catch((err: unknown) => {
        if (mounted.current) setState({ kind: "error", ...toMessage(err) });
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

  return { ...state, refetch: run };
}
