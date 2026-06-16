/**
 * SessionHistory — the rail's History popover CONTENT: the recent chat sessions,
 * newest-first, each row entering the session on click. Moved OUT of the Searches
 * popover (searches and session history are separate concerns now). The row for
 * the rail's CURRENT session carries aria-current + a graphite-blue fill so the
 * open session never visually merges with a hover.
 *
 * Fetches its own list (it mounts fresh on every popover open) AND subscribes to
 * the data-change bus so a write landing while open refreshes it in place.
 */

import type { ApiClient } from "../api/client.js";
import { useDataRefetch } from "../api/useDataChanged.js";
import { useAsync } from "../api/useApi.js";
import type { SessionList } from "../api/wire.js";
import { SessionStatusPill } from "../shell/SessionStatusPill.js";

const SESSION_KINDS = ["sessions"] as const;

/** A compact relative timestamp ("2h ago" / "Yesterday" / "Mar 14") from an ISO
 *  string. Best-effort: an unparseable value renders nothing. */
function relativeWhen(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return "Yesterday";
  if (day < 7) return `${day}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export interface SessionHistoryProps {
  client: ApiClient;
  /** The rail's current session (highlighted), or null. */
  currentSessionId: string | null;
  /** Enter a session (App hydrates its pin + scope notice). */
  onSelect: (sessionId: string) => void;
}

export function SessionHistory({ client, currentSessionId, onSelect }: SessionHistoryProps): JSX.Element {
  const sessions = useAsync<SessionList>(() => client.listSessions(), []);
  useDataRefetch(SESSION_KINDS, sessions.refetch);

  if (sessions.kind === "error") {
    return (
      <p className="danger-text" role="alert">
        Couldn&apos;t load history: {sessions.message}
      </p>
    );
  }
  if (sessions.kind !== "ok") return <p className="muted">Loading…</p>;
  if (sessions.data.length === 0) {
    return (
      <p className="muted" data-testid="rail-history-empty">
        No sessions yet.
      </p>
    );
  }

  return (
    <div data-testid="rail-history-list">
      <h3 className="skills-group-title">Recent sessions</h3>
      {sessions.data.map((s) => {
        const isCurrent = s.id === currentSessionId;
        return (
          <div
            className="rail-history-row"
            key={s.id}
            {...(isCurrent ? { "aria-current": "true" as const } : {})}
            data-testid={`rail-history-row-${s.id}`}
          >
            <button
              type="button"
              className="rail-history-title"
              data-testid={`rail-session-${s.id}`}
              onClick={() => onSelect(s.id)}
            >
              {s.title ?? s.id}
              {s.pinned_profile_id !== null ? " · pinned" : ""}
            </button>
            <span className="rail-history-when">{relativeWhen(s.last_activity_at)}</span>
            {s.last_run_id !== null && (
              <SessionStatusPill client={client} sessionId={s.id} runId={s.last_run_id} />
            )}
          </div>
        );
      })}
    </div>
  );
}
