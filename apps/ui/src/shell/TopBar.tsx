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
import type { AppMode } from "../api/wire.js";
import { navigate } from "../router.js";
import { BrandMark, GearIcon } from "./icons.js";
import { ModeToggle } from "./ModeToggle.js";
import { Popover } from "./Popover.js";
import { SearchPicker } from "./SearchPicker.js";

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
  /** Open the Settings pop-up (the top-right gear) — App owns the overlay. */
  onOpenSettings: () => void;
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
  onOpenSettings,
}: TopBarProps): JSX.Element {
  return (
    <header className="topbar">
      <div className="topbar__left">
        <nav aria-label="Primary">
          <Popover label="Searches" triggerTestId="topbar-searches" panelTestId="searches-popover">
            {(close) => (
              <SearchPicker
                client={client}
                pinnedProfileId={pinnedProfileId}
                onPin={onPin}
                onUnpin={onUnpin}
                onViewProfile={onViewProfile}
                onStartIntake={onStartIntake}
                close={close}
              />
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

        {/* Settings — an icon-only gear that POPS UP the settings overlay (keys,
            connections, environment, diagnostics; App owns the modal). The
            accessible name is on aria-label + the tooltip. */}
        <button
          type="button"
          className="icon-btn topbar-settings"
          aria-label="Settings"
          title="Settings"
          data-testid="topbar-settings"
          onClick={onOpenSettings}
        >
          <GearIcon />
        </button>
      </div>
    </header>
  );
}
