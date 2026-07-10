/**
 * ModeToggle — the TopBar's posture switch for the single AUTOBROKER_MODE,
 * rendered as ONE lamp (not a two-segment group): Buyer (the real product —
 * AutoBroker can really email dealers & submit web forms, each still behind the
 * per-action approval gate) vs Test (internal/safe — nothing leaves the machine).
 * The lamp REFLECTS the live value (fetched by App from GET /api/mode) and
 * switches it via client.setEnvConfig("app_mode", …) then refetches.
 *
 * COLOR (owner-directed): GREEN = Buyer (live / armed to send), AMBER = Test
 * (safe / held on the bench). The word "Buyer"/"Test" is always visible, so the
 * posture never rides on colour alone. Clicking the lamp FLIPS the mode.
 *
 * SAFETY DIRECTION: switching TO buyer enables real external send, so it is
 * gated by a danger confirm dialog (the established Modal `danger` variant — no
 * backdrop dismiss, an explicit button is the only commit). Switching TO test is
 * the safe direction and commits immediately. The danger-confirm path is the
 * load-bearing one and is preserved verbatim.
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
    "Buyer mode — AutoBroker can really email dealers & submit forms; you still approve each one. Click to switch to Test.",
  test: "Test mode — nothing leaves your computer. Click to switch to Buyer.",
};

export function ModeToggle({ mode, onSwitched, client }: ModeToggleProps): JSX.Element {
  // The pending confirm for the sensitive direction (test → buyer). Switching to
  // test never opens this (it is the safe direction → commits immediately).
  const [confirmBuyer, setConfirmBuyer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const descId = useId();
  const buyer = mode === "buyer";

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

  // Click the lamp to FLIP. Going to buyer (the sensitive direction) opens the
  // confirm first; going to test (the safe direction) commits immediately.
  const toggle = (): void => {
    if (busy) return;
    if (buyer) {
      commit("test");
      return;
    }
    setError(null);
    setConfirmBuyer(true);
  };

  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={buyer}
        aria-label={TITLE[mode]}
        title={TITLE[mode]}
        className="mode-lamp"
        data-mode={mode}
        data-testid="mode-toggle"
        disabled={busy}
        onClick={toggle}
      >
        <span className="mode-lamp-dot" aria-hidden="true" />
        <span className="mode-lamp-text">{buyer ? "Buyer" : "Test"}</span>
      </button>

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
