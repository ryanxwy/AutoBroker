/**
 * ProfileRemoveControl — the SOFT-DELETE affordance at the foot of the active
 * profile card. A low-emphasis "Remove this search" button expands an inline
 * gate-card confirm (no modal/portal — the confirm lives in the card flow). The
 * copy is HONEST about recoverability: removing keeps the data (it moves to
 * Closed searches and can be restored); only Reset erases everything. Because
 * the action is recoverable it is NOT a typed-YES confirm (that is reserved for
 * the irreversible pipeline_reset).
 *
 * On Remove the control fires a REAL DELETE /api/profiles/:id (the tools close()
 * soft-delete: status→'closed', the active (account, brand) slot frees, an
 * audited row lands). On success the profile leaves the active list — the host's
 * shared profiles fetch is invalidated, so the Canvas re-reads and the active
 * profile disappears (the empty state takes over). A 409 profile_busy keeps the
 * card open with a failure plate ("a run is using it"); any other error shows a
 * generic error line and keeps the card open so the user can retry.
 *
 * a11y: opening the confirm moves focus to the gate-card; "Keep it" (and the
 * Escape key) return focus to the open button.
 */

import { useEffect, useRef, useState } from "react";

import type { ApiClient } from "../api/client.js";
import { ApiError } from "../api/client.js";
import { invalidate } from "../api/useDataChanged.js";

type RemoveState =
  | { kind: "idle" }
  | { kind: "confirm" }
  | { kind: "removing" }
  | { kind: "busy" }
  | { kind: "error"; message: string };

export interface ProfileRemoveControlProps {
  client: ApiClient;
  /** The active profile id to soft-delete. */
  profileId: string;
}

export function ProfileRemoveControl({
  client,
  profileId,
}: ProfileRemoveControlProps): JSX.Element {
  const [state, setState] = useState<RemoveState>({ kind: "idle" });
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Focus the confirm card when it opens (the busy/error plates re-render the
  // same card, so this only fires on the idle→confirm transition).
  useEffect(() => {
    if (state.kind === "confirm") cardRef.current?.focus();
  }, [state.kind]);

  const open = (): void => setState({ kind: "confirm" });

  // Cancel returns focus to the open button (a11y) and closes the card.
  const cancel = (): void => {
    setState({ kind: "idle" });
    requestAnimationFrame(() => openButtonRef.current?.focus());
  };

  const remove = async (): Promise<void> => {
    setState({ kind: "removing" });
    try {
      await client.closeProfile(profileId);
      // The slot freed + the row is now 'closed' — refresh the active list so
      // the Canvas re-reads (the profile drops out, the empty state shows).
      invalidate(["profiles"]);
      // No success plate needed: the whole card unmounts with the profile.
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 409 && e.code === "profile_busy") {
        setState({ kind: "busy" });
        return;
      }
      setState({
        kind: "error",
        message: e instanceof Error ? e.message : "remove failed",
      });
    }
  };

  if (state.kind === "idle") {
    return (
      <div className="profile-remove">
        <button
          ref={openButtonRef}
          type="button"
          className="btn-danger profile-remove-open"
          data-testid="profile-remove-open"
          onClick={open}
        >
          Remove this search
        </button>
      </div>
    );
  }

  const removing = state.kind === "removing";
  const failure = state.kind === "busy" || state.kind === "error";

  return (
    <div className="profile-remove">
      <div
        ref={cardRef}
        className={`gate-card${failure ? " failure" : ""}`}
        role="alertdialog"
        aria-label="Remove this search"
        tabIndex={-1}
        data-testid="profile-remove-confirm"
        aria-busy={removing}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !removing) cancel();
        }}
      >
        <strong>Remove this search?</strong>
        <p className="muted">
          Your data is kept and can be restored from Closed searches. To erase
          everything, use Reset.
        </p>

        {state.kind === "busy" && (
          <p className="danger-text" role="alert" data-testid="profile-remove-busy">
            This search is busy — a run is using it. Try again once its run finishes.
          </p>
        )}
        {state.kind === "error" && (
          <p className="danger-text" role="alert" data-testid="profile-remove-error">
            Couldn’t remove this search: {state.message}
          </p>
        )}

        <div className="gate-actions">
          <button
            type="button"
            data-testid="profile-remove-cancel"
            disabled={removing}
            onClick={cancel}
          >
            Keep it
          </button>
          <button
            type="button"
            className="btn-danger"
            data-testid="profile-remove-confirm-yes"
            aria-busy={removing}
            disabled={removing}
            onClick={() => void remove()}
          >
            {removing ? <span data-testid="profile-remove-removing">Removing…</span> : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}
