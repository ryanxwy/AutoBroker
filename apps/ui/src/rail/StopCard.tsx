/**
 * StopCard — the typed profile-resolution STOP rendering (the three-branch
 * contract made answerable in the UI). A geosearch run that stopped on profile
 * resolution renders one of two affordances under the verbatim STOP message:
 *
 *   - no_active_profile / profile_missing_fields → an intake CTA (the 0-active
 *     branch points at /search_profile_intake).
 *   - multiple_active_profiles → a PICKER: the candidates are NOT on the error
 *     frame, so the picker fetches GET /api/profiles?status=active LIVE when it
 *     renders; picking a vehicle RE-LAUNCHES the skill as a NEW run with
 *     search_profile_id in the start body (STOP is terminal — never a resume).
 *
 * Presentational beyond the one read fetch; the parent owns both launches.
 */

import { useEffect, useState } from "react";

import type { ApiClient } from "../api/client.js";
import type { ProfileList } from "../api/wire.js";
import type { GeosearchStopCode } from "../chat/messageModel.js";
import { toSnapshot, vehicleLabel } from "../home/profileView.js";

export interface StopCardProps {
  code: GeosearchStopCode;
  client: ApiClient;
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

export function StopCard({ code, client, onStartIntake, onPickProfile }: StopCardProps): JSX.Element {
  return (
    <div className="card stop-card" data-testid="stop-card" data-stop-code={code} role="alert">
      {code === "multiple_active_profiles" ? (
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
