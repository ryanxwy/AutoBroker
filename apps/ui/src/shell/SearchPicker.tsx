/**
 * SearchPicker — the shared active-searches picker body. ONE picker, two mount
 * points: the TopBar "Searches" popover (primary nav) and the per-session pin
 * toggle at the top of the chat rail (Phase 3). Each active search is a row with
 * a far-left pin TOGGLE (binds the CURRENT session to that profile; unpins when
 * already pinned) and a title that opens the profile modal. Pinned floats to the
 * top; the Closed group sits at the bottom.
 *
 * It owns its own profiles read (fetches on MOUNT — i.e. when the popover opens —
 * and refetches on the data-change bus / refocus), so a write landing while the
 * popover was closed is visible on re-open. The exact testids are preserved
 * (searches-new / searches-row-<id> / searches-pin-<id> / searches-unpin-<id> /
 * searches-view-<id>) so the existing TopBar driver + tests are unchanged.
 *
 * Dependency wall: app/ui layer.
 */

import { ApiClient } from "../api/client.js";
import { useDataRefetch } from "../api/useDataChanged.js";
import { useAsync } from "../api/useApi.js";
import type { ProfileList } from "../api/wire.js";
import { toSnapshot, vehicleLabel } from "../home/profileView.js";
import { ClosedSearchesGroup } from "./ClosedSearchesGroup.js";
import { PinIcon } from "./icons.js";

// Stable literal — the data-change bus key the list subscribes under.
const PROFILE_KINDS = ["profiles"] as const;

export interface SearchPickerProps {
  client: ApiClient;
  /** The current session's TRUE pin, or null. */
  pinnedProfileId: string | null;
  /** Pin the CURRENT session to a profile (creates a session when none). */
  onPin: (profileId: string) => void;
  /** Clear the current session's pin. */
  onUnpin: () => void;
  /** Open the view/edit modal for a profile. */
  onViewProfile: (profileId: string, name: string) => void;
  /** Start a fresh search (intake). */
  onStartIntake: () => void;
  /** Close the hosting popover after a terminal action. */
  close: () => void;
}

export function SearchPicker({
  client,
  pinnedProfileId,
  onPin,
  onUnpin,
  onViewProfile,
  onStartIntake,
  close,
}: SearchPickerProps): JSX.Element {
  const profiles = useAsync<ProfileList>(() => client.listProfiles("active"), []);
  useDataRefetch(PROFILE_KINDS, profiles.refetch);

  const rows = profiles.kind === "ok" ? profiles.data.map(toSnapshot).filter((s) => s.id !== null) : [];
  const pinned = rows.filter((s) => s.id === pinnedProfileId);
  const rest = rows.filter((s) => s.id !== pinnedProfileId);

  const SearchRow = ({ snap }: { snap: (typeof rows)[number] }): JSX.Element => {
    const id = snap.id!;
    const isPinned = id === pinnedProfileId;
    return (
      <div className="popover-row searches-row" data-pinned={isPinned} data-testid={`searches-row-${id}`}>
        <button
          type="button"
          className="pin-toggle"
          aria-pressed={isPinned}
          aria-label="Pin to top"
          title={isPinned ? "Unpin" : "Pin to top"}
          data-testid={isPinned ? `searches-unpin-${id}` : `searches-pin-${id}`}
          onClick={() => (isPinned ? onUnpin() : onPin(id))}
        >
          <PinIcon filled={isPinned} />
        </button>
        <button
          type="button"
          className="searches-row-title"
          data-testid={`searches-view-${id}`}
          onClick={() => onViewProfile(id, vehicleLabel(snap) || id)}
        >
          {vehicleLabel(snap) || id}
        </button>
      </div>
    );
  };

  return (
    <div>
      <button
        type="button"
        className="btn-primary"
        data-testid="searches-new"
        onClick={() => {
          close();
          onStartIntake();
        }}
      >
        + New search
      </button>
      {profiles.kind === "ok" && rows.length === 0 && <p className="muted">No active searches yet.</p>}
      {pinned.length > 0 && (
        <>
          <h3 className="skills-group-title">Pinned</h3>
          {pinned.map((snap) => (
            <SearchRow key={snap.id} snap={snap} />
          ))}
        </>
      )}
      {rest.length > 0 && (
        <>
          {pinned.length > 0 && <h3 className="skills-group-title">All searches</h3>}
          {rest.map((snap) => (
            <SearchRow key={snap.id} snap={snap} />
          ))}
        </>
      )}
      {profiles.kind === "error" && (
        <p className="danger-text" role="alert">
          Couldn&apos;t load searches: {profiles.message}
        </p>
      )}

      {/* Closed searches — the soft-deleted set, each row restorable. */}
      <ClosedSearchesGroup client={client} />
    </div>
  );
}
