/**
 * TopBar — the persistent app chrome: wordmark, live-run pill, the Searches and
 * Skills popovers, the canvas/conversation mode switch (rail layout state,
 * persisted), and a diagnostics fold carrying the raw data-dir/db paths (off
 * the main chrome — plumbing detail, not user content).
 *
 * The Skills popover is the ONLY skill directory; both popovers refetch their
 * lists on EVERY open (the top bar never remounts, so a list fetched once
 * would go stale — e.g. a skill enabled by a just-finished intake).
 */

import { ApiClient } from "../api/client.js";
import { useAsync, type AsyncState } from "../api/useApi.js";
import type { Mode, ProfileList, SkillList, SkillManifest } from "../api/wire.js";
import { toSnapshot, vehicleLabel } from "../home/profileView.js";
import { Link } from "../router.js";
import { useLayout } from "../store/layout.js";
import { Popover } from "./Popover.js";
import { SkillsPopoverList } from "./SkillsPopover.js";

export interface TopBarProps {
  client: ApiClient;
  activeRunId: string | null;
  /** The backend mode (App owns the fetch — it doubles as the reachability probe). */
  mode: AsyncState<Mode>;
  onStartIntake: () => void;
  onRunSkill: (skill: SkillManifest) => void;
}

export function TopBar({ client, activeRunId, mode, onStartIntake, onRunSkill }: TopBarProps): JSX.Element {
  const profiles = useAsync<ProfileList>(() => client.listProfiles("active"), []);
  const skills = useAsync<SkillList>(() => client.listSkills(), []);
  const layoutMode = useLayout((s) => s.mode);
  const setLayoutMode = useLayout((s) => s.setMode);

  // Inferred-newest active profile as the pin projection (true pin wiring is a
  // later slice; the readiness grouping reads this).
  const activePin =
    profiles.kind === "ok" && profiles.data.length > 0 ? toSnapshot(profiles.data[0]!).id : null;

  return (
    <header className="topbar">
      <span className="wordmark">AutoBroker</span>
      {activeRunId !== null && (
        <span className="running-pill" data-testid="running-pill">
          ● run active
        </span>
      )}
      <span className="spacer" />

      <Popover
        label="Searches"
        triggerTestId="topbar-searches"
        panelTestId="searches-popover"
        onOpen={() => profiles.refetch()}
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
                return (
                  <div className="popover-row" key={snap.id}>
                    <Link to={`/profiles/${snap.id}`}>{vehicleLabel(snap) || snap.id}</Link>
                  </div>
                );
              })}
            {profiles.kind === "error" && (
              <p className="danger-text" role="alert">
                Couldn&apos;t load searches: {profiles.message}
              </p>
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
          // pin, the rows need a fresh manifest.
          profiles.refetch();
          skills.refetch();
        }}
      >
        {(close) =>
          skills.kind === "ok" ? (
            <SkillsPopoverList
              skills={skills.data}
              activePin={activePin}
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
