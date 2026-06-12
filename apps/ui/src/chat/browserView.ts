/**
 * browserView — the pure reducer behind the rail's zone-4 browser activity
 * trail. Transient data-browser parts (delivered live via onData, never
 * persisted into message parts) fold into one bounded view: a short trail of
 * recent browser moments (target host + action verb; error frames visibly
 * distinct), a count of concurrently OPEN isolated browsers (the parallel
 * geosearch reality — opened/closed pairs interleave across N browsers, so the
 * view counts rather than assuming one-browser-at-a-time), and the latest
 * live screenshot (base64 jpeg riding a fan-out-only frame — gone after
 * terminal, never in history).
 *
 * Dependency wall: app/ui layer. Pure data — no React, no client.
 */

/** One rendered trail moment. */
export interface BrowserTrailEntry {
  kind: "opened" | "action" | "error" | "closed";
  label: string;
}

/** The folded zone-4 view. */
export interface BrowserView {
  /** Newest-last, bounded to BROWSER_TRAIL_LIMIT. */
  entries: BrowserTrailEntry[];
  /** Concurrently open isolated browsers (opened − closed, floored at 0). */
  openCount: number;
  /** The latest live screenshot (base64 jpeg), or null. */
  screenshot: string | null;
}

export const EMPTY_BROWSER_VIEW: BrowserView = { entries: [], openCount: 0, screenshot: null };

/** Trail length bound — the zone is a glanceable arm, not a log viewer. */
export const BROWSER_TRAIL_LIMIT = 6;

/** Reduce a target/url to its host for the trail label (raw text when it is
 *  not a URL — e.g. a fallback message target). */
function hostOf(target: string): string {
  try {
    const url = new URL(target);
    if (url.host !== "") return url.host;
  } catch {
    // not a URL — fall through to the raw text.
  }
  return target.length > 60 ? `${target.slice(0, 57)}…` : target;
}

function pushBounded(entries: BrowserTrailEntry[], entry: BrowserTrailEntry): BrowserTrailEntry[] {
  // The screenshot-bearing live twin repeats the pure frame's label — collapse
  // consecutive duplicates instead of showing the same moment twice.
  const last = entries[entries.length - 1];
  if (last !== undefined && last.kind === entry.kind && last.label === entry.label) {
    return entries;
  }
  const next = [...entries, entry];
  return next.length > BROWSER_TRAIL_LIMIT ? next.slice(next.length - BROWSER_TRAIL_LIMIT) : next;
}

/**
 * Fold one transient data-browser part's `data` ({kind, payload}) into the
 * view. Unknown/malformed data returns the view unchanged (defensive — onData
 * fires from inside the stream processor).
 */
export function reduceBrowserView(view: BrowserView, data: unknown): BrowserView {
  if (data === null || typeof data !== "object") return view;
  const kind = (data as { kind?: unknown }).kind;
  const rawPayload = (data as { payload?: unknown }).payload;
  const payload =
    rawPayload !== null && typeof rawPayload === "object"
      ? (rawPayload as Record<string, unknown>)
      : {};

  switch (kind) {
    case "browser.opened": {
      const url = payload["url"];
      const label = typeof url === "string" ? `Opened ${hostOf(url)}` : "Browser opened";
      return {
        ...view,
        openCount: view.openCount + 1,
        entries: pushBounded(view.entries, { kind: "opened", label }),
      };
    }
    case "browser.action": {
      const type = typeof payload["type"] === "string" ? (payload["type"] as string) : "working";
      const target = typeof payload["target"] === "string" ? (payload["target"] as string) : "";
      const label = target === "" ? type : `${type} ${hostOf(target)}`;
      const shot = payload["screenshot_b64"];
      return {
        ...view,
        ...(typeof shot === "string" && shot !== "" ? { screenshot: shot } : {}),
        entries: pushBounded(view.entries, { kind: "action", label }),
      };
    }
    case "browser.error": {
      const message = payload["message"];
      const label = typeof message === "string" ? message : "Browser issue";
      const shot = payload["screenshot_b64"];
      return {
        ...view,
        ...(typeof shot === "string" && shot !== "" ? { screenshot: shot } : {}),
        entries: pushBounded(view.entries, { kind: "error", label }),
      };
    }
    case "browser.closed": {
      return {
        ...view,
        openCount: Math.max(0, view.openCount - 1),
        entries: pushBounded(view.entries, { kind: "closed", label: "Browser closed" }),
      };
    }
    default:
      return view;
  }
}
