/**
 * SettingsBody — the centralized settings CONTENT, shared by two hosts: the
 * `/settings` route page (Settings.tsx, the first-run/deep-link full page) and
 * the top-right gear's pop-up overlay (App's settings Modal). Keeping the body
 * in one presentational component means the gear pop-up and the route render the
 * exact same surface (no fork): the first-run setup strip, the four managed-key
 * rows, the Gmail onboarding shell, the Environment panel, and Diagnostics.
 *
 * Presence + env are owned by App (the SAME reads the first-run gate uses): App
 * passes the AsyncStates down plus `onChanged`/`onEnvChanged` that refetch them
 * after a write, so a save reflects the live value with no reload.
 *
 * Dependency wall: app/ui layer. react + the typed client + the wire types.
 */

import type { ApiClient } from "../api/client.js";
import type { AsyncState } from "../api/useApi.js";
import type { EnvConfigResponse, KeyPresenceResponse, Mode } from "../api/wire.js";
import { EnvPanel } from "./EnvPanel.js";
import { GmailCard } from "./GmailCard.js";
import { KeyRow } from "./KeyRow.js";
import { KEY_DEFS } from "./keyDefs.js";

export interface SettingsBodyProps {
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

export function SettingsBody({
  client,
  presence,
  onChanged,
  env,
  onEnvChanged,
  mode,
}: SettingsBodyProps): JSX.Element {
  const deepseekReady = presence.kind === "ok" && presence.data.deepseek.present;

  return (
    <>
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

      {/* Diagnostics — the raw data-dir/db paths (plumbing detail, not user
          content). */}
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
    </>
  );
}
