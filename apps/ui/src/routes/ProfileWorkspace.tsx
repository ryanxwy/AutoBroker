/**
 * ProfileWorkspace — the /profiles/:id route (an extension-point route). The
 * dealer workspace itself is a later slice (skeleton only here), but the AUTO-LOAD
 * logic is REAL: it fetches the profile by id and reuses SnapshotCard to render
 * it. A "pin auto-load" note states that opening a profile route auto-pins it to
 * the active rail session (the binding itself lands with the pin lifecycle slice;
 * this slice ships the note + the real load, not the full workspace).
 */

import type { ApiClient } from "../api/client.js";
import { useAsync } from "../api/useApi.js";
import type { ProfileRow } from "../api/wire.js";
import { SnapshotCard } from "../home/SnapshotCard.js";
import { toSnapshot } from "../home/profileView.js";

export function ProfileWorkspace({
  client,
  profileId,
}: {
  client: ApiClient;
  profileId: string;
}): JSX.Element {
  const profile = useAsync<ProfileRow>(
    () => client.getProfile(profileId),
    [profileId],
    profileId !== "",
  );

  return (
    <div data-testid="profile-workspace">
      <h1>Search file</h1>
      {profile.kind === "loading" && (
        <div className="card" data-testid="profile-skeleton">
          <p className="muted">Loading profile…</p>
        </div>
      )}
      {profile.kind === "error" && (
        <p className="danger-text" role="alert" data-testid="profile-error">
          Couldn't load this profile: {profile.message}
        </p>
      )}
      {profile.kind === "ok" && <SnapshotCard snapshot={toSnapshot(profile.data)} />}

      <p className="muted" data-testid="profile-pin-note" style={{ marginTop: 12 }}>
        Opening this search auto-pins it to your conversation — every skill you run
        here acts on this profile (1 session = 1 profile).
      </p>
      <p className="muted">The full dealer workspace lands in a later slice.</p>
    </div>
  );
}
