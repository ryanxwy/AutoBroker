/**
 * StopCard — the typed profile/precondition STOP rendering (the three-branch
 * profile contract, plus inbox preconditions, made answerable in the UI). A run
 * that stopped on a typed STOP renders one of three affordances:
 *
 *   - no_active_profile / profile_missing_fields → an intake CTA (the 0-active
 *     branch points at /search_profile_intake — there are no candidates to pick).
 *   - multiple_active_profiles / pin_required → a PICKER: the candidates are NOT
 *     on the error frame, so the picker fetches GET /api/profiles?status=active
 *     LIVE when it renders; picking a vehicle RE-LAUNCHES the stopped skill as a
 *     NEW run with search_profile_id in the start body (STOP is terminal — never
 *     a resume). pin_required (a pin-required skill launched with no pin) reuses
 *     the same picker — the only difference is the workflow STOP code.
 *   - no_lead_submitted → a FRIENDLY informational pointer (the inbox
 *     precondition: no lead has been submitted yet). No picker, no red error —
 *     it renders the workflow's own message in a calm tone.
 *
 * Presentational beyond the one read fetch; the parent owns both launches.
 */

import { useEffect, useState } from "react";

import type { ApiClient } from "../api/client.js";
import type { ProfileList } from "../api/wire.js";
import type { ProfileStopCode } from "../chat/messageModel.js";
import { toSnapshot, vehicleLabel } from "../home/profileView.js";

export interface StopCardProps {
  code: ProfileStopCode;
  client: ApiClient;
  /** The workflow's verbatim STOP message — rendered in the friendly
   *  no_lead_submitted arm (the picker/CTA arms point elsewhere). */
  message?: string | null;
  /** Start a fresh intake (the 0-active / missing-fields CTA). */
  onStartIntake: () => void;
  /** Re-launch the stopped skill pinned to the picked profile (a NEW run). */
  onPickProfile: (profileId: string) => void;
}

function ProfileStopPicker({
  client,
  onPick,
}: {
  client: ApiClient;
  onPick: (profileId: string) => void;
}): JSX.Element {
  const [profiles, setProfiles] = useState<ProfileList | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .listProfiles("active")
      .then((rows) => {
        if (!cancelled) setProfiles(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load profiles.");
      });
    return (): void => {
      cancelled = true;
    };
  }, [client]);

  if (error !== null) {
    return (
      <p className="danger-text" role="alert">
        Couldn&apos;t load the active searches: {error}
      </p>
    );
  }
  if (profiles === null) return <p className="muted">Loading active searches…</p>;

  return (
    <div data-testid="stop-pick-list">
      <p className="muted">Pick the vehicle to act on:</p>
      {profiles.map((row) => {
        const snap = toSnapshot(row);
        if (snap.id === null) return null;
        return (
          <button
            key={snap.id}
            type="button"
            className="btn-primary"
            data-testid="stop-pick-option"
            onClick={() => onPick(snap.id!)}
          >
            {vehicleLabel(snap) || snap.id}
          </button>
        );
      })}
    </div>
  );
}

export function StopCard({
  code,
  client,
  message = null,
  onStartIntake,
  onPickProfile,
}: StopCardProps): JSX.Element {
  // no_lead_submitted is a calm precondition pointer (role="status", not
  // "alert") — it shows the workflow's own next-step message, no picker/CTA.
  if (code === "no_lead_submitted") {
    return (
      <div className="card stop-card" data-testid="stop-card" data-stop-code={code} role="status">
        <p className="muted" data-testid="stop-no-lead-submitted">
          {message ?? "Submit a lead to a dealer first, then check the inbox."}
        </p>
      </div>
    );
  }

  return (
    <div className="card stop-card" data-testid="stop-card" data-stop-code={code} role="alert">
      {code === "multiple_active_profiles" || code === "pin_required" ? (
        <ProfileStopPicker client={client} onPick={onPickProfile} />
      ) : (
        <button
          type="button"
          className="btn-primary"
          data-testid="stop-intake-cta"
          onClick={onStartIntake}
        >
          Create a search profile
        </button>
      )}
    </div>
  );
}
