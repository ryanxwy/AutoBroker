/**
 * TopBar — the persistent app chrome, a THREE-ZONE grid:
 *   - LEFT  : the Searches popover (primary nav) + the live-run pill.
 *   - CENTER: the brand mark + wordmark (a home link), optically centered.
 *   - RIGHT : the canvas/chat mode switch + the Settings GEAR (icon-only).
 *
 * The Searches popover is now searches-ONLY: active searches (pinned sorted to
 * the top, each row a far-left pin toggle + a title that opens the profile
 * modal) plus the Closed group. Session history moved into the chat rail; the
 * Skills directory moved into the chat rail; Diagnostics folded into Settings.
 *
 * Both the active-searches list subscribes to the data-change bus + refocus, so a
 * write landing while the popover is open refreshes it in place.
 *
 * PIN LIFECYCLE lives here: each active search row carries a pin TOGGLE (binds
 * the CURRENT rail session to that profile; creates a session when none exists)
 * — aria-pressed carries the state, the label stays constant ("Pin to top").
 */

import { ApiClient } from "../api/client.js";
import { useDataRefetch } from "../api/useDataChanged.js";
import { useAsync } from "../api/useApi.js";
import type { AppMode, ProfileList } from "../api/wire.js";
import { toSnapshot, vehicleLabel } from "../home/profileView.js";
import { navigate } from "../router.js";
import { useLayout } from "../store/layout.js";
import { ClosedSearchesGroup } from "./ClosedSearchesGroup.js";
import { BrandMark, GearIcon, PinIcon } from "./icons.js";
import { ModeToggle } from "./ModeToggle.js";
import { Popover } from "./Popover.js";

// Module-level stable literal — the data-change bus key the active-searches list
// subscribes under (stable identity so useDataRefetch's effect deps don't churn).
const PROFILE_KINDS = ["profiles"] as const;

export interface TopBarProps {
  client: ApiClient;
  /** True only while the active run is genuinely in-flight (not terminal). Drives
   *  the pulsing "run active" pill — it must clear when the run reaches done/error,
   *  not linger for the rest of the session. */
  runActive: boolean;
  /** The current session's TRUE pin (hydrated by App), or null. */
  pinnedProfileId: string | null;
  /** The live AUTOBROKER_MODE posture (from GET /api/mode), or null while the
   *  mode read is loading/errored — the toggle hides until a real value lands. */
  appMode: AppMode | null;
  /** Refetch /api/mode after the toggle commits a switch. */
  onModeSwitched: () => void;
  onStartIntake: () => void;
  /** Pin the CURRENT session to a profile (creates a session when none). */
  onPin: (profileId: string) => void;
  /** Clear the current session's pin. */
  onUnpin: () => void;
  /** Open the view/edit modal for a profile (replaces the dead /profiles/:id link). */
  onViewProfile: (profileId: string, name: string) => void;
}

export function TopBar({
  client,
  runActive,
  pinnedProfileId,
  appMode,
  onModeSwitched,
  onStartIntake,
  onPin,
  onUnpin,
  onViewProfile,
}: TopBarProps): JSX.Element {
  const profiles = useAsync<ProfileList>(() => client.listProfiles("active"), []);
  useDataRefetch(PROFILE_KINDS, profiles.refetch);
  const layoutMode = useLayout((s) => s.mode);
  const setLayoutMode = useLayout((s) => s.setMode);

  // Pinned-first ordering: the single bound profile floats to the top under a
  // "Pinned" header; the rest follow. (The rail pins ONE session→profile binding,
  // so the Pinned group holds 0 or 1 rows — sorting still makes the pin visible.)
  const rows = profiles.kind === "ok" ? profiles.data.map(toSnapshot).filter((s) => s.id !== null) : [];
  const pinned = rows.filter((s) => s.id === pinnedProfileId);
  const rest = rows.filter((s) => s.id !== pinnedProfileId);

  const SearchRow = ({ snap }: { snap: (typeof rows)[number] }): JSX.Element => {
    const id = snap.id!;
    const isPinned = id === pinnedProfileId;
    return (
      <div className="popover-row searches-row" data-pinned={isPinned} data-testid={`searches-row-${id}`}>
        <button
          type="button"
          className="pin-toggle"
          aria-pressed={isPinned}
          aria-label="Pin to top"
          title={isPinned ? "Unpin" : "Pin to top"}
          data-testid={isPinned ? `searches-unpin-${id}` : `searches-pin-${id}`}
          onClick={() => (isPinned ? onUnpin() : onPin(id))}
        >
          <PinIcon filled={isPinned} />
        </button>
        <button
          type="button"
          className="searches-row-title"
          data-testid={`searches-view-${id}`}
          onClick={() => onViewProfile(id, vehicleLabel(snap) || id)}
        >
          {vehicleLabel(snap) || id}
        </button>
      </div>
    );
  };

  return (
    <header className="topbar">
      <div className="topbar__left">
        <nav aria-label="Primary">
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
                {profiles.kind === "ok" && rows.length === 0 && (
                  <p className="muted">No active searches yet.</p>
                )}
                {pinned.length > 0 && (
                  <>
                    <h3 className="skills-group-title">Pinned</h3>
                    {pinned.map((snap) => (
                      <SearchRow key={snap.id} snap={snap} />
                    ))}
                  </>
                )}
                {rest.length > 0 && (
                  <>
                    {pinned.length > 0 && <h3 className="skills-group-title">All searches</h3>}
                    {rest.map((snap) => (
                      <SearchRow key={snap.id} snap={snap} />
                    ))}
                  </>
                )}
                {profiles.kind === "error" && (
                  <p className="danger-text" role="alert">
                    Couldn&apos;t load searches: {profiles.message}
                  </p>
                )}

                {/* Closed searches — the soft-deleted set, each row restorable. */}
                <ClosedSearchesGroup client={client} />
              </div>
            )}
          </Popover>
        </nav>
        {runActive && (
          <span className="running-pill" data-testid="running-pill">
            <span className="pulse" aria-hidden="true" />
            run active
          </span>
        )}
      </div>

      <div className="topbar__brand">
        <a href="/" className="brand-link" aria-label="AutoBroker home" onClick={(e) => { e.preventDefault(); navigate("/"); }}>
          <BrandMark />
          <span className="wordmark">
            Auto<b>Broker</b>
          </span>
        </a>
      </div>

      <div className="topbar__right">
        {/* App-mode posture toggle (Buyer = live/can-send, Test = safe). Renders
            once the /api/mode read resolves; switching TO buyer is confirm-gated. */}
        {appMode !== null && (
          <ModeToggle mode={appMode} onSwitched={onModeSwitched} client={client} />
        )}

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

        {/* Settings — an icon-only gear routing to /settings (Diagnostics now
            lives there too). The accessible name is on aria-label + the tooltip. */}
        <button
          type="button"
          className="icon-btn topbar-settings"
          aria-label="Settings"
          title="Settings"
          data-testid="topbar-settings"
          onClick={() => navigate("/settings")}
        >
          <GearIcon />
        </button>
      </div>
    </header>
  );
}
