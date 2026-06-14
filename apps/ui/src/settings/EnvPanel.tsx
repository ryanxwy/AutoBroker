/**
 * EnvPanel — the "Environment" section of the Settings page. It renders one
 * EnvRow per curated env var FROM the server's getEnvConfig() response (the
 * EnvVarState[] carries every descriptor field + the current value), in the
 * server's order — the UI does not hardcode the descriptor set.
 *
 * The read is owned by App (like key presence): App passes the env AsyncState
 * down plus an `onChanged` that refetches it after a write, so a successful
 * setEnvConfig reflects the live value with no reload. This panel owns only the
 * per-row write state (the in-flight error + the brief Saved badge).
 *
 * Dependency wall: app/ui layer. react + the typed client + the wire type.
 */

import { useState } from "react";

import type { ApiClient } from "../api/client.js";
import type { AsyncState } from "../api/useApi.js";
import { ENV_EDITABLE_IDS, type EnvConfigResponse, type EnvEditableId } from "../api/wire.js";
import { EnvRow } from "./EnvRow.js";

export interface EnvPanelProps {
  client: ApiClient;
  /** The env config read App owns (mirrors key presence). */
  env: AsyncState<EnvConfigResponse>;
  /** Refetch the env config after a write lands (App re-reads → live value). */
  onChanged: () => void;
}

const EDITABLE_SET = new Set<string>(ENV_EDITABLE_IDS);
const isEditableId = (id: string): id is EnvEditableId => EDITABLE_SET.has(id);

export function EnvPanel({ client, env, onChanged }: EnvPanelProps): JSX.Element {
  // Per-id write state: the last error + a brief Saved badge after a success.
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});

  const onSet = (id: string, value: string): void => {
    // Only the two editable ids are writable; read-only rows never call this.
    if (!isEditableId(id)) return;
    setErrors((e) => ({ ...e, [id]: null }));
    client
      .setEnvConfig(id, value)
      .then(() => {
        onChanged();
        setSaved((s) => ({ ...s, [id]: true }));
        // The badge is a brief confirmation; clear it so it does not linger.
        setTimeout(() => setSaved((s) => ({ ...s, [id]: false })), 2500);
      })
      .catch((err: unknown) => {
        setErrors((e) => ({
          ...e,
          [id]: err instanceof Error ? err.message : "could not save this setting",
        }));
      });
  };

  return (
    <section data-testid="settings-env">
      <h2>Environment</h2>

      {env.kind === "loading" && <p className="muted">Loading your settings…</p>}
      {env.kind === "error" && (
        <p className="danger-text" role="alert" data-testid="env-panel-error">
          Couldn&apos;t load your settings: {env.message}
        </p>
      )}

      {env.kind === "ok" && (
        <div className="card env-panel" data-testid="env-panel">
          {env.data.vars.map((state) => (
            <EnvRow
              key={state.id}
              state={state}
              onSet={onSet}
              busyError={errors[state.id] ?? null}
              saved={saved[state.id] ?? false}
            />
          ))}
        </div>
      )}
    </section>
  );
}
