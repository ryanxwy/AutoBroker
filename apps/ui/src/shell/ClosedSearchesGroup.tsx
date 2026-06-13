/**
 * ClosedSearchesGroup — the "Closed" group inside the Searches popover,
 * mirroring the existing Sessions group (the skills-group-title heading + a
 * popover-row per entry). It lists the soft-deleted (status='closed') searches
 * and offers a Restore verb on each.
 *
 * Restore fires a REAL POST /api/profiles/:id/restore (the tools restore():
 * status→'active', audited). On success the row leaves the closed list and the
 * profile returns to active — the host's shared profiles fetch is invalidated so
 * the active row list + Canvas re-read; the popover stays open. A 409
 * active_slot_conflict (an active search of the same brand already holds the
 * slot) renders an inline message reading the conflicting brand off the error
 * envelope; any other failure shows a generic error line. Both keep the row.
 *
 * The group fetches its own closed list (client.listProfiles("closed")) on mount
 * and after a restore — it renders nothing when the list is empty (no closed
 * searches → no group), exactly like the Sessions group hides when empty. The
 * popover panel mounts this group fresh on every open, so the on-mount fetch is
 * always current.
 */

import { useState } from "react";

import type { ApiClient } from "../api/client.js";
import { ApiError } from "../api/client.js";
import { invalidate } from "../api/useDataChanged.js";
import { useAsync } from "../api/useApi.js";
import type { ProfileList } from "../api/wire.js";
import { toSnapshot, vehicleLabel } from "../home/profileView.js";

type RowState =
  | { kind: "idle" }
  | { kind: "restoring" }
  | { kind: "conflict"; brand: string | null }
  | { kind: "error"; message: string };

export interface ClosedSearchesGroupProps {
  client: ApiClient;
}

export function ClosedSearchesGroup({ client }: ClosedSearchesGroupProps): JSX.Element | null {
  const closed = useAsync<ProfileList>(() => client.listProfiles("closed"), []);
  // Per-row restore state, keyed by profile id.
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});

  const setRow = (id: string, s: RowState): void =>
    setRowStates((prev) => ({ ...prev, [id]: s }));

  const restore = async (id: string): Promise<void> => {
    setRow(id, { kind: "restoring" });
    try {
      await client.restoreProfile(id);
      // The row is active again — refresh the active list (so the active rows +
      // Canvas re-read) and drop it from the closed list (the popover stays open).
      invalidate(["profiles"]);
      closed.refetch();
      setRow(id, { kind: "idle" });
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 409 && e.code === "active_slot_conflict") {
        const brand = e.envelope?.["brand"];
        setRow(id, { kind: "conflict", brand: typeof brand === "string" ? brand : null });
        return;
      }
      setRow(id, {
        kind: "error",
        message: e instanceof Error ? e.message : "restore failed",
      });
    }
  };

  if (closed.kind !== "ok" || closed.data.length === 0) return null;

  return (
    <div data-testid="searches-closed-group">
      <h3 className="skills-group-title">Closed</h3>
      {closed.data.map((row) => {
        const snap = toSnapshot(row);
        if (snap.id === null) return null;
        const id = snap.id;
        const rs = rowStates[id] ?? { kind: "idle" };
        const restoring = rs.kind === "restoring";
        return (
          <div className="popover-row" key={id} data-testid={`searches-closed-row-${id}`}>
            <span>{vehicleLabel(snap) || id}</span>{" "}
            <button
              type="button"
              data-testid={`profile-restore-${id}`}
              disabled={restoring}
              aria-busy={restoring}
              onClick={() => void restore(id)}
            >
              {restoring ? "Restoring…" : "Restore"}
            </button>
            {rs.kind === "conflict" && (
              <p
                className="danger-text"
                role="alert"
                data-testid={`profile-restore-conflict-${id}`}
              >
                You already have an active {rs.brand ?? snap.make ?? "matching"} search. Remove or
                replace it first.
              </p>
            )}
            {rs.kind === "error" && (
              <p className="danger-text" role="alert" data-testid={`profile-restore-error-${id}`}>
                Couldn’t restore: {rs.message}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
