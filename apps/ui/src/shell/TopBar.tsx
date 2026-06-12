/**
 * TopBar — the persistent app chrome: wordmark, live-run pill, the Searches and
 * Skills popovers, the canvas/conversation mode switch (rail layout state,
 * persisted), and a diagnostics fold carrying the raw data-dir/db paths (off
 * the main chrome — plumbing detail, not user content).
 *
 * The Skills popover is the ONLY skill directory; both popovers refetch their
 * lists on EVERY open (the top bar never remounts, so a list fetched once
 * would go stale — e.g. a skill enabled by a just-finished intake).
 *
 * PIN LIFECYCLE lives in the Searches popover: each active search row carries
 * a Pin verb (binds the CURRENT rail session to that profile; creates a session
 * when none exists yet) and the pinned row shows Unpin. The Sessions section
 * lists recent rail sessions; clicking one ENTERS it — App re-hydrates the pin
 * AND the persisted scope notice from the same GET /api/sessions/:id fetch
 * (the post-restart recovery path: the runId→session link is in-memory, but
 * the session metadata is durable).
 */

import { ApiClient } from "../api/client.js";
import { useAsync, type AsyncState } from "../api/useApi.js";
import type { Mode, ProfileList, SessionList, SkillList, SkillManifest, SkillRunSummary } from "../api/wire.js";
import { toSnapshot, vehicleLabel } from "../home/profileView.js";
import { Link } from "../router.js";
import { useLayout } from "../store/layout.js";
import { Popover } from "./Popover.js";
import { SkillsPopoverList } from "./SkillsPopover.js";

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

/**
 * The per-session terminal pill: reads the status of the session's BOUND run
 * (last_run_id off the session row — never a global latest-run guess) from
 * GET /api/skill-runs/:id, which resolves from durable Mastra storage even
 * after a server restart. Rows mount on every popover open, so the read is
 * fresh per open. Renders nothing while loading or when the run is unknown.
 */
function SessionStatusPill({
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
    <span
      className="session-pill"
      data-testid={`session-pill-${sessionId}`}
      data-status={s}
    >
      {SESSION_PILL_LABEL[s] ?? s}
    </span>
  );
}

export interface TopBarProps {
  client: ApiClient;
  activeRunId: string | null;
  /** The backend mode (App owns the fetch — it doubles as the reachability probe). */
  mode: AsyncState<Mode>;
  /** The current session's TRUE pin (hydrated by App), or null. */
  pinnedProfileId: string | null;
  onStartIntake: () => void;
  onRunSkill: (skill: SkillManifest) => void;
  /** Pin the CURRENT session to a profile (creates a session when none). */
  onPin: (profileId: string) => void;
  /** Clear the current session's pin. */
  onUnpin: () => void;
  /** Enter an existing session — App hydrates pin + scope notice from it. */
  onSelectSession: (sessionId: string) => void;
}

export function TopBar({
  client,
  activeRunId,
  mode,
  pinnedProfileId,
  onStartIntake,
  onRunSkill,
  onPin,
  onUnpin,
  onSelectSession,
}: TopBarProps): JSX.Element {
  const profiles = useAsync<ProfileList>(() => client.listProfiles("active"), []);
  const sessions = useAsync<SessionList>(() => client.listSessions(), []);
  const skills = useAsync<SkillList>(() => client.listSkills(), []);
  const layoutMode = useLayout((s) => s.mode);
  const setLayoutMode = useLayout((s) => s.setMode);

  const hasActiveProfile = profiles.kind === "ok" && profiles.data.length > 0;

  return (
    <header className="topbar">
      <span className="wordmark">
        Auto<b>Broker</b>
      </span>
      {activeRunId !== null && (
        <span className="running-pill" data-testid="running-pill">
          <span className="pulse" aria-hidden="true" />
          run active
        </span>
      )}
      <span className="spacer" />

      <Popover
        label="Searches"
        triggerTestId="topbar-searches"
        panelTestId="searches-popover"
        onOpen={() => {
          profiles.refetch();
          sessions.refetch();
        }}
      >
        {(close) => (
          <div>
            <button
              type="button"
              className="btn-primary"
              data-testid="searches-new"
              onClick={() => {
                close();
                onStartIntake();
              }}
            >
              + New search
            </button>
            {profiles.kind === "ok" && profiles.data.length === 0 && (
              <p className="muted">No active searches yet.</p>
            )}
            {profiles.kind === "ok" &&
              profiles.data.map((row) => {
                const snap = toSnapshot(row);
                if (snap.id === null) return null;
                const isPinned = snap.id === pinnedProfileId;
                return (
                  <div className="popover-row" key={snap.id} data-testid={`searches-row-${snap.id}`}>
                    <Link to={`/profiles/${snap.id}`}>{vehicleLabel(snap) || snap.id}</Link>{" "}
                    {isPinned ? (
                      <button
                        type="button"
                        data-testid={`searches-unpin-${snap.id}`}
                        onClick={() => onUnpin()}
                      >
                        Unpin
                      </button>
                    ) : (
                      <button
                        type="button"
                        data-testid={`searches-pin-${snap.id}`}
                        onClick={() => onPin(snap.id!)}
                      >
                        Pin
                      </button>
                    )}
                  </div>
                );
              })}
            {profiles.kind === "error" && (
              <p className="danger-text" role="alert">
                Couldn&apos;t load searches: {profiles.message}
              </p>
            )}

            {sessions.kind === "ok" && sessions.data.length > 0 && (
              <>
                <h3 className="skills-group-title">Sessions</h3>
                {sessions.data.map((s) => (
                  <div className="popover-row" key={s.id}>
                    <button
                      type="button"
                      data-testid={`searches-session-${s.id}`}
                      onClick={() => {
                        close();
                        onSelectSession(s.id);
                      }}
                      style={{ border: "none", background: "none", textAlign: "left", padding: 0 }}
                    >
                      {s.title ?? s.id}
                      {s.pinned_profile_id !== null ? " (pinned)" : ""}
                    </button>{" "}
                    {s.last_run_id !== null && (
                      <SessionStatusPill client={client} sessionId={s.id} runId={s.last_run_id} />
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </Popover>

      <Popover
        label="Skills"
        triggerTestId="topbar-skills"
        panelTestId="skills-popover"
        onOpen={() => {
          // Refetch BOTH on every open: the readiness grouping needs a fresh
          // active-profile read, the rows need a fresh manifest.
          profiles.refetch();
          skills.refetch();
        }}
      >
        {(close) =>
          skills.kind === "ok" ? (
            <SkillsPopoverList
              skills={skills.data}
              pin={pinnedProfileId}
              hasActiveProfile={hasActiveProfile}
              onRun={(skill) => {
                close();
                onRunSkill(skill);
              }}
            />
          ) : skills.kind === "error" ? (
            <p className="danger-text" role="alert">
              Couldn&apos;t load skills: {skills.message}
            </p>
          ) : (
            <p className="muted">Loading…</p>
          )
        }
      </Popover>

      <div className="modeswitch" role="tablist" aria-label="Workbench mode">
        <button
          type="button"
          role="tab"
          aria-selected={layoutMode === "canvas"}
          className={layoutMode === "canvas" ? "on" : ""}
          data-testid="topbar-mode-canvas"
          onClick={() => setLayoutMode("canvas")}
        >
          Canvas
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={layoutMode === "conversation"}
          className={layoutMode === "conversation" ? "on" : ""}
          data-testid="topbar-mode-conversation"
          onClick={() => setLayoutMode("conversation")}
        >
          Chat
        </button>
      </div>

      <details className="diagnostics" data-testid="topbar-diagnostics">
        <summary>Diagnostics</summary>
        <div className="diag-panel">
          {mode.kind === "ok" ? (
            <dl>
              <dt>Product DB</dt>
              <dd data-testid="diag-db-path">{mode.data.active_db}</dd>
              <dt>Data dir</dt>
              <dd>{mode.data.data_dir}</dd>
            </dl>
          ) : (
            <p className="muted">Backend mode unavailable.</p>
          )}
        </div>
      </details>
    </header>
  );
}
