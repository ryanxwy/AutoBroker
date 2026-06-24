/**
 * claimDealer / releaseDealerClaims — the dealership-exclusivity claim seam.
 *
 * THE EXCLUSIVITY INVARIANT (load-bearing): a dealership (`dealer_id`) may be
 * `'bound'` to AT MOST ONE search profile at a time. The DB backstop is the
 * partial-unique index `uq_profile_dealers_bound_dealer(dealer_id) WHERE
 * status='bound'` (migration 0003) — two profiles can both hold a `'candidate'`
 * row, but only one row per dealer may be `'bound'`. This module is the tools-
 * layer writer that drives a profile's row through that wall.
 *
 *   claimDealer        — bind THIS profile's row to 'bound'. The verdict is a
 *                        SAFE three-way union; ONLY `'claimed'` permits a send.
 *                        - The bind targets candidate/bound/excluded_conflict
 *                          rows, so a row that lost a PRIOR conflict can RETRY
 *                          once the holder releases the dealer.
 *                        - A DIFFERENT profile already holds the dealer bound =>
 *                          either the partial-unique index throws
 *                          SQLITE_CONSTRAINT_UNIQUE, or the bind matches 0 rows;
 *                          either way we re-derive the holder, mark THIS row
 *                          'excluded_conflict' (exclusion_reason='engaged_by:
 *                          <holder>'), and return { kind:'conflict' } with a
 *                          human vehicle label (NEVER budget — inv #9).
 *                        - The bind matches 0 rows AND the dealer is free
 *                          (this row is absent or already 'closed_out') =>
 *                          { kind:'unavailable' }. NEVER 'claimed': a re-submit
 *                          of an excluded/closed dealer must not slip through
 *                          (fail-CLOSED on the send path).
 *                        Idempotent: a re-claim by the current holder is a
 *                        no-op success — the row is already 'bound', the UPDATE
 *                        re-affirms it (1 row matched, index untripped) =>
 *                        'claimed'.
 *   releaseDealerClaims — flip THIS profile's 'bound' rows back to 'closed_out',
 *                        freeing those dealers for another profile. Returns the
 *                        row count. (Closeout / purge / reset call this.)
 *
 * SQLITE INVARIANT: raw better-sqlite3 handle only — no drizzle-orm operators.
 *
 * Dependency wall: imports @autobroker/db (getDb + the Db type) only.
 */

import { getDb, type Db } from "@autobroker/db";

/**
 * The claim verdict — a SAFE typed union (no exception for the conflict path).
 * SEND CONTRACT: only `'claimed'` permits a send; `'conflict'` and
 * `'unavailable'` both drop the dealer. `'unavailable'` distinguishes the benign
 * not-claimable case (this profile has no live candidate/bound/excluded_conflict
 * row to bind) from an actual exclusivity conflict.
 */
export type ClaimResult =
  | { kind: "claimed" }
  | { kind: "conflict"; heldByProfileId: string; heldByVehicle: string }
  | { kind: "unavailable"; reason: "no_row" | "closed_out" };

// Bind this profile's row. Targets candidate/bound/excluded_conflict so a row
// that LOST a prior conflict can be retried (once the holder releases the dealer
// the index is free and the bind succeeds; if the holder still holds it the
// partial-unique index throws and we take the conflict path). A 'closed_out' row
// is intentionally NOT a bind target — it must not be silently resurrected.
// Re-binding an already-'bound' row of the SAME profile is a no-op that does NOT
// trip the index (the index sees the same single bound row for the dealer).
const UPDATE_BIND =
  "UPDATE profile_dealers SET status = 'bound', bound_at = CURRENT_TIMESTAMP " +
  "WHERE search_profile_id = ? AND dealer_id = ? " +
  "AND status IN ('candidate', 'bound', 'excluded_conflict')";

// Read THIS profile's row status (to tell no_row from closed_out when the bind
// matched 0 rows and the dealer is free).
const SELECT_OWN_STATUS =
  "SELECT status FROM profile_dealers WHERE search_profile_id = ? AND dealer_id = ?";

// The profile that currently holds the dealer bound + its vehicle identity (a
// human label only — budget is NEVER selected, inv #9).
const SELECT_HOLDER =
  "SELECT pd.search_profile_id AS profile_id, sp.year, sp.make, sp.model, sp.trim " +
  "FROM profile_dealers pd " +
  "JOIN search_profiles sp ON sp.search_profile_id = pd.search_profile_id " +
  "WHERE pd.dealer_id = ? AND pd.status = 'bound' " +
  "LIMIT 1";

// Mark THIS profile's row as excluded by the conflict, recording who holds it.
const UPDATE_EXCLUDE =
  "UPDATE profile_dealers SET status = 'excluded_conflict', exclusion_reason = ? " +
  "WHERE search_profile_id = ? AND dealer_id = ?";

function isUniqueConstraint(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

/** Build a human "2026 Honda Accord EX-L" label from the holder row (no budget). */
function vehicleLabel(row: {
  year?: unknown;
  make?: unknown;
  model?: unknown;
  trim?: unknown;
}): string {
  return [row.year, row.make, row.model, row.trim]
    .filter((p) => p !== null && p !== undefined && String(p).trim() !== "")
    .map((p) => String(p))
    .join(" ");
}

/**
 * Bind a dealer to one profile, enforcing dealership exclusivity.
 *  - This profile holds/keeps the dealer bound      => { kind: 'claimed' }.
 *  - A DIFFERENT profile already holds it bound      => { kind: 'conflict', ... }
 *    (this profile's row is set 'excluded_conflict').
 *  - No live row to bind, dealer free                => { kind: 'unavailable', ... }.
 * The bind + the conflict-marking run in ONE transaction so a conflict never
 * leaves a half-written state, and `'claimed'` is returned ONLY when this
 * profile's row genuinely transitioned to 'bound' (changes > 0 with no
 * constraint trip). A 0-rows bind is NEVER a false 'claimed'.
 */
export function claimDealer(args: {
  searchProfileId: string;
  dealerId: string;
  db?: Db;
}): ClaimResult {
  const db = args.db ?? getDb();
  const conn = db.$client;

  // Resolve the non-claimed verdict when this profile did NOT end up bound. If
  // the dealer is held by ANOTHER profile => conflict (and mark THIS row
  // excluded, when a row exists). Otherwise the dealer is free but this profile
  // has nothing live to bind => unavailable (no_row | closed_out).
  const resolveNotClaimed = (): ClaimResult => {
    const holder = conn.prepare(SELECT_HOLDER).get(args.dealerId) as
      | { profile_id: string; year?: unknown; make?: unknown; model?: unknown; trim?: unknown }
      | undefined;
    const ownRow = conn.prepare(SELECT_OWN_STATUS).get(args.searchProfileId, args.dealerId) as
      | { status: string }
      | undefined;

    if (holder !== undefined && holder.profile_id !== args.searchProfileId) {
      // A different profile holds the dealer bound — exclusivity conflict.
      const heldByProfileId = holder.profile_id;
      const heldByVehicle = vehicleLabel(holder);
      if (ownRow !== undefined) {
        conn
          .prepare(UPDATE_EXCLUDE)
          .run(`engaged_by:${heldByProfileId}`, args.searchProfileId, args.dealerId);
      }
      return { kind: "conflict", heldByProfileId, heldByVehicle };
    }

    // Dealer is not held by another profile, yet this profile did not bind it:
    // its row is absent or already closed_out. Not claimable — fail closed.
    return {
      kind: "unavailable",
      reason: ownRow === undefined ? "no_row" : "closed_out",
    };
  };

  const txn = conn.transaction((): ClaimResult => {
    try {
      const info = conn.prepare(UPDATE_BIND).run(args.searchProfileId, args.dealerId);
      // 'claimed' ONLY when this profile's row genuinely became (or stayed) bound.
      if (info.changes > 0) return { kind: "claimed" };
      // 0 rows matched: row absent, closed_out, or held by another profile.
      return resolveNotClaimed();
    } catch (err) {
      if (!isUniqueConstraint(err)) throw err;
      // A different profile holds the dealer bound: the partial-unique index
      // tripped. Mark THIS row excluded and report the conflict.
      return resolveNotClaimed();
    }
  });

  return txn();
}

const UPDATE_RELEASE =
  "UPDATE profile_dealers SET status = 'closed_out' " +
  "WHERE search_profile_id = ? AND status = 'bound'";

/**
 * Release every dealer THIS profile holds bound — flip 'bound' → 'closed_out',
 * freeing those dealers for another profile. Returns the number of rows flipped.
 */
export function releaseDealerClaims(args: { searchProfileId: string; db?: Db }): number {
  const db = args.db ?? getDb();
  const info = db.$client.prepare(UPDATE_RELEASE).run(args.searchProfileId);
  return info.changes;
}
