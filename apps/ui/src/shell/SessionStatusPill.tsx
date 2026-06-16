/**
 * SessionStatusPill — the per-session terminal pill (reused by the rail's
 * History popover; formerly defined inside TopBar). Reads the status of the
 * session's BOUND run (last_run_id off the session row) from
 * GET /api/skill-runs/:id, which resolves from durable Mastra storage even after
 * a server restart. Rows mount on each popover open, so the read is fresh.
 * Renders nothing while loading or when the run is unknown.
 */

import type { ApiClient } from "../api/client.js";
import { useAsync } from "../api/useApi.js";
import type { SkillRunSummary } from "../api/wire.js";

/** Short pill wording per projected run status (terminal + in-flight). */
const SESSION_PILL_LABEL: Record<string, string> = {
  pending: "Starting…",
  running: "Running",
  awaiting_approval: "Awaiting input",
  done: "Done",
  error: "Error",
  declined: "Cancelled",
  aborted: "Stopped",
};

export function SessionStatusPill({
  client,
  sessionId,
  runId,
}: {
  client: ApiClient;
  sessionId: string;
  runId: string;
}): JSX.Element | null {
  const status = useAsync<SkillRunSummary>(() => client.runStatus(runId), [runId]);
  if (status.kind !== "ok") return null;
  const s = status.data.status;
  return (
    <span className="session-pill" data-testid={`session-pill-${sessionId}`} data-status={s}>
      {SESSION_PILL_LABEL[s] ?? s}
    </span>
  );
}
