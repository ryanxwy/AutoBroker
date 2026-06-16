/**
 * Settings — the centralized Keys panel (the /settings route). It renders the
 * four managed-key rows (data-driven from keyDefs) + the Gmail onboarding shell,
 * and — when the required DeepSeek key is absent — a non-dismissable setup strip
 * framing first-run onboarding.
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
import { EnvPanel } from "../settings/EnvPanel.js";
import { GmailCard } from "../settings/GmailCard.js";
import { KeyRow } from "../settings/KeyRow.js";
import { KEY_DEFS } from "../settings/keyDefs.js";

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
  /** The backend mode read App owns — its db/data-dir paths drive the
   *  Diagnostics section (folded in from the old top-bar fold). */
  mode: AsyncState<Mode>;
}

export function Settings({ client, presence, onChanged, env, onEnvChanged, mode }: SettingsProps): JSX.Element {
  const deepseekReady = presence.kind === "ok" && presence.data.deepseek.present;

  return (
    <div className="settings-page" data-testid="settings-page">
      <h1>Settings</h1>

      {/* First-run setup framing — shown until the required DeepSeek key lands.
          Non-dismissable (a scope-notice), so a fresh install always sees it. */}
      {presence.kind === "ok" && !deepseekReady && (
        <div className="scope-notice" data-testid="settings-setup-strip" role="status">
          <strong>Set up AutoBroker</strong>
          <ul>
            <li>Add your DeepSeek key below to start running searches.</li>
            <li>Add a Google Places key to find dealers near you.</li>
          </ul>
        </div>
      )}

      {presence.kind === "loading" && <p className="muted">Loading your keys…</p>}
      {presence.kind === "error" && (
        <p className="danger-text" role="alert" data-testid="settings-error">
          Couldn&apos;t load your keys: {presence.message}
        </p>
      )}

      {presence.kind === "ok" && (
        <>
          <section data-testid="settings-keys">
            <h2>API keys</h2>
            {KEY_DEFS.map((def) => (
              <KeyRow
                key={def.id}
                client={client}
                def={def}
                present={presence.data[def.id].present}
                onChanged={onChanged}
              />
            ))}
          </section>

          <section data-testid="settings-gmail">
            <h2>Connections</h2>
            <GmailCard connected={presence.data.gmail.connected} />
          </section>

          <EnvPanel client={client} env={env} onChanged={onEnvChanged} />
        </>
      )}

      {/* Diagnostics — the raw data-dir/db paths (folded in from the old top-bar
          fold; plumbing detail, not user content). */}
      <section data-testid="settings-diagnostics">
        <h2>Diagnostics</h2>
        {mode.kind === "ok" ? (
          <dl className="diag-grid">
            <dt>Product DB</dt>
            <dd data-testid="diag-db-path">{mode.data.active_db}</dd>
            <dt>Data dir</dt>
            <dd>{mode.data.data_dir}</dd>
          </dl>
        ) : (
          <p className="muted">Backend mode unavailable.</p>
        )}
      </section>
    </div>
  );
}
