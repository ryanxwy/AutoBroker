/**
 * router — a tiny hand-rolled client-side router (two real routes + a
 * placeholder). Three route shapes only — home '/', run view '/runs/:id',
 * profile '/profiles/:id' — with no nested routing, no loaders, and no data
 * APIs. We do NOT pull in react-router-dom (a real runtime dependency) for three
 * static patterns: a ~50-line History-API matcher is less code than the
 * library's setup and has zero new deps. It exposes a `useRoute()` hook
 * (re-renders on popstate + programmatic navigate) and a `navigate(path)`
 * helper.
 *
 * Dependency wall: app/ui layer. react + the browser History API only.
 */

import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from "react";

export type Route =
  | { name: "home" }
  | { name: "run"; runId: string }
  | { name: "profile"; profileId: string }
  | { name: "settings" }
  | { name: "digest"; profileId: string | null }
  | { name: "not_found"; path: string };

/** Parse a pathname into a typed Route. Order: most-specific first. */
export function matchRoute(pathname: string): Route {
  if (pathname === "/" || pathname === "") return { name: "home" };
  if (pathname === "/settings" || pathname === "/settings/") return { name: "settings" };
  // /digest = the all-active digest (profileId null); /digest/:id pins it to one
  // search (path-param form, consistent with /profiles/:id — the client maps it
  // to ?profile_id). This router parses pathnames only, no query string.
  if (pathname === "/digest" || pathname === "/digest/") return { name: "digest", profileId: null };
  const digest = /^\/digest\/([^/]+)\/?$/.exec(pathname);
  if (digest) return { name: "digest", profileId: decodeURIComponent(digest[1]!) };
  const run = /^\/runs\/([^/]+)\/?$/.exec(pathname);
  if (run) return { name: "run", runId: decodeURIComponent(run[1]!) };
  const profile = /^\/profiles\/([^/]+)\/?$/.exec(pathname);
  if (profile) return { name: "profile", profileId: decodeURIComponent(profile[1]!) };
  return { name: "not_found", path: pathname };
}

// A module-level event channel so a programmatic navigate() re-renders every
// mounted useRoute() consumer (popstate only fires for back/forward, not
// pushState). Mirrors the minimal contract react-router gives for free.
const NAV_EVENT = "autobroker:navigate";

/** Push a new path and notify all route consumers. No-op if already there. */
export function navigate(path: string): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new Event(NAV_EVENT));
}

/** Subscribe to the current route; re-renders on back/forward + navigate(). */
export function useRoute(): Route {
  const read = (): Route =>
    matchRoute(typeof window === "undefined" ? "/" : window.location.pathname);
  const [route, setRoute] = useState<Route>(read);

  const sync = useCallback(() => {
    setRoute(read());
  }, []);

  useEffect(() => {
    window.addEventListener("popstate", sync);
    window.addEventListener(NAV_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(NAV_EVENT, sync);
    };
  }, [sync]);

  return route;
}

/** An anchor that routes client-side (no full reload). */
export function Link(props: {
  to: string;
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}): JSX.Element {
  const onClick = (e: MouseEvent<HTMLAnchorElement>): void => {
    // Honour modifier-clicks / middle-click (open in new tab) — only intercept
    // the plain left-click.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    e.preventDefault();
    navigate(props.to);
  };
  return (
    <a
      href={props.to}
      onClick={onClick}
      className={props.className}
      data-testid={props["data-testid"]}
    >
      {props.children}
    </a>
  );
}
