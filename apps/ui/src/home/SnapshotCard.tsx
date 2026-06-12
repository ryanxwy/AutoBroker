/**
 * SnapshotCard — the search-file snapshot used on the profile route. Shows
 * Year/Make/Model/trim · location · Dealers/Threads/Best-OTD + a "View search
 * file" link. It consumes the dealer-SAFE
 * ProfileSnapshot — which has NO budget accessor — so budget can never leak into
 * this summary surface (budget red-line: budget_max is internal-only, never
 * dealer-facing — see CLAUDE.md).
 */

import { Link } from "../router.js";
import { formatLocation, vehicleLabel, type ProfileSnapshot } from "./profileView.js";

export function SnapshotCard({ snapshot }: { snapshot: ProfileSnapshot }): JSX.Element {
  const vehicle = vehicleLabel(snapshot);
  return (
    <section className="card snapshot-card" data-testid="snapshot-card">
      <h3>Active search</h3>
      <dl>
        <dt>Vehicle</dt>
        <dd data-testid="snapshot-vehicle">{vehicle || "—"}</dd>
        <dt>Location</dt>
        <dd data-testid="snapshot-location">{formatLocation(snapshot.location) ?? "—"}</dd>
        <dt>Dealers</dt>
        <dd>{snapshot.dealerCount ?? 0}</dd>
        <dt>Threads</dt>
        <dd>{snapshot.threadCount ?? 0}</dd>
        <dt>Best OTD</dt>
        <dd>{snapshot.bestOtd !== null ? `$${snapshot.bestOtd.toLocaleString()}` : "—"}</dd>
      </dl>
      {snapshot.id !== null && (
        <Link to={`/profiles/${snapshot.id}`} data-testid="snapshot-view-file">
          View search file →
        </Link>
      )}
    </section>
  );
}
