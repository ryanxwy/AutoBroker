/**
 * Settings — the `/settings` route page. A thin page shell around the shared
 * SettingsBody: it keeps the `settings-page` testid + the page <h1> for the
 * first-run/deep-link full-page surface (the no-DeepSeek-key gate navigates
 * here). The gear in the top bar opens the SAME SettingsBody in a pop-up overlay
 * (App owns that Modal), so the route and the pop-up never fork.
 *
 * Presence is owned by App (the SAME read the first-run gate uses): App passes
 * the presence AsyncState down plus an `onChanged` that refetches it after a
 * save/clear, so saving the DeepSeek key here clears the gate app-wide with no
 * reload. A standalone open (direct /settings link) still works — App always
 * has the presence read mounted.
 */

import type { ApiClient } from "../api/client.js";
import type { AsyncState } from "../api/useApi.js";
import type { EnvConfigResponse, KeyPresenceResponse, Mode } from "../api/wire.js";
import { SettingsBody } from "../settings/SettingsBody.js";

export interface SettingsProps {
  client: ApiClient;
  /** The presence read App owns (drives both this panel and the first-run gate). */
  presence: AsyncState<KeyPresenceResponse>;
  /** Refetch presence after a save/clear (App re-reads → the gate re-evaluates). */
  onChanged: () => void;
  /** The env config read App owns (drives the Environment panel). */
  env: AsyncState<EnvConfigResponse>;
  /** Refetch the env config after a setting write lands. */
  onEnvChanged: () => void;
  /** The backend mode read App owns — its db/data-dir paths drive Diagnostics. */
  mode: AsyncState<Mode>;
}

export function Settings({ client, presence, onChanged, env, onEnvChanged, mode }: SettingsProps): JSX.Element {
  return (
    <div className="settings-page" data-testid="settings-page">
      <h1>Settings</h1>
      <SettingsBody
        client={client}
        presence={presence}
        onChanged={onChanged}
        env={env}
        onEnvChanged={onEnvChanged}
        mode={mode}
      />
    </div>
  );
}
