/**
 * ModeToggle — the TopBar's two-state posture switch for the single
 * AUTOBROKER_MODE: Buyer (the real product — AutoBroker can really email dealers
 * & submit web forms, each still behind the per-action approval gate) vs Test
 * (internal/safe — nothing leaves the machine). It REFLECTS the live value
 * (fetched by App from GET /api/mode) and switches it via
 * client.setEnvConfig("app_mode", …) then refetches so the toggle + the demo/
 * mode surfaces re-derive.
 *
 * SAFETY DIRECTION: switching TO buyer enables real external send, so it is
 * gated by a danger confirm dialog (the established Modal `danger` variant — no
 * backdrop dismiss, an explicit button is the only commit). Switching TO test is
 * the safe direction and commits immediately.
 *
 * Visual semantics (reuses the segmented `.modeswitch` idiom, role-colored):
 *   - the ACTIVE segment carries the role color — buyer = safety-orange `--gate`
 *     (live / can send), test = racing-green `--go` (calm / safe) — plus a small
 *     status dot, so the posture reads at a glance with no new vocabulary.
 *
 * Dependency wall: app/ui layer. react + the api client + the Modal primitive.
 */

import { useId, useState } from "react";

import { ApiClient } from "../api/client.js";
import type { AppMode } from "../api/wire.js";
import { Modal } from "./Modal.js";

export interface ModeToggleProps {
  /** The live posture from GET /api/mode (App owns the read). */
  mode: AppMode;
  /** Refetch /api/mode after a committed switch (the toggle + banners re-derive). */
  onSwitched: () => void;
  client: ApiClient;
}

const TITLE: Record<AppMode, string> = {
  buyer:
    "Buyer mode — AutoBroker can really email dealers & submit forms; you still approve each one",
  test: "Test mode — nothing leaves your computer",
};

export function ModeToggle({ mode, onSwitched, client }: ModeToggleProps): JSX.Element {
  // The pending confirm for the sensitive direction (test → buyer). Switching to
  // test never opens this (it is the safe direction → commits immediately).
  const [confirmBuyer, setConfirmBuyer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const descId = useId();

  // Commit a switch: PUT the env value, then refetch /api/mode. Optimism is NOT
  // used — the toggle reflects the server-confirmed value only (App refetches).
  const commit = (next: AppMode): void => {
    setBusy(true);
    setError(null);
    client
      .setEnvConfig("app_mode", next)
      .then(() => {
        setConfirmBuyer(false);
        onSwitched();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Could not switch mode.");
      })
      .finally(() => setBusy(false));
  };

  // A segment click. Selecting the active mode is a no-op. Selecting buyer (the
  // sensitive direction) opens the confirm; selecting test commits immediately.
  const select = (next: AppMode): void => {
    if (next === mode) return;
    if (next === "buyer") {
      setError(null);
      setConfirmBuyer(true);
      return;
    }
    commit("test");
  };

  const Segment = ({ value, label }: { value: AppMode; label: string }): JSX.Element => {
    const active = mode === value;
    return (
      <button
        type="button"
        role="switch"
        aria-checked={active}
        aria-label={TITLE[value]}
        title={TITLE[value]}
        className={active ? "on" : ""}
        data-mode={value}
        data-testid={`mode-toggle-${value}`}
        disabled={busy}
        onClick={() => select(value)}
      >
        <span className="mode-dot" aria-hidden="true" />
        {label}
      </button>
    );
  };

  return (
    <>
      <div
        className="mode-toggle"
        data-mode={mode}
        data-testid="mode-toggle"
        role="group"
        aria-label="App mode"
      >
        <Segment value="test" label="Test" />
        <Segment value="buyer" label="Buyer" />
      </div>

      {confirmBuyer && (
        <Modal
          open
          variant="danger"
          onClose={() => setConfirmBuyer(false)}
          labelId={titleId}
          describedById={descId}
        >
          <h2 id={titleId} data-testid="mode-confirm-title">
            Switch to Buyer mode?
          </h2>
          <p id={descId} className="hard-delete-consequence">
            Buyer mode lets AutoBroker <strong>really email dealers and submit web
            forms</strong> on your behalf. You still approve each send before it goes
            out. Test mode keeps everything on your computer.
          </p>
          {error !== null && (
            <p className="danger-text" role="alert" data-testid="mode-confirm-error">
              Couldn’t switch: {error}
            </p>
          )}
          <div className="modal-foot">
            <button
              type="button"
              data-testid="mode-confirm-cancel"
              disabled={busy}
              onClick={() => setConfirmBuyer(false)}
            >
              Stay in Test
            </button>
            <span className="spacer" />
            <button
              type="button"
              className="btn-go-live"
              data-testid="mode-confirm-buyer"
              aria-busy={busy}
              disabled={busy}
              onClick={() => commit("buyer")}
            >
              {busy ? "Switching…" : "Turn on Buyer mode"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
