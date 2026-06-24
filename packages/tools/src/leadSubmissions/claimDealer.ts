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
 *   claimDealer        — flip THIS profile's row to 'bound'. If a DIFFERENT
 *                        profile already holds the dealer bound, the index
 *                        throws SQLITE_CONSTRAINT_UNIQUE; we catch it, mark THIS
 *                        profile's row 'excluded_conflict' (exclusion_reason =
 *                        'engaged_by:<holder>'), and return the conflict + a
 *                        human vehicle label for the holder (NEVER budget — inv
 *                        #9). Idempotent: a re-claim by the current holder is a
 *                        no-op success (the row is already 'bound', so the UPDATE
 *                        keeps it bound without tripping the index).
 *   releaseDealerClaims — flip THIS profile's 'bound' rows back to 'closed_out',
 *                        freeing those dealers for another profile. Returns the
 *                        row count. (Closeout / purge / reset call this.)
 *
 * SQLITE INVARIANT: raw better-sqlite3 handle only — no drizzle-orm operators.
 *
 * Dependency wall: imports @autobroker/db (getDb + the Db type) only.
 */

import { getDb, type Db } from "@autobroker/db";

/** The claim verdict — a typed union (no exception for the conflict path). */
export type ClaimResult =
  | { kind: "claimed" }
  | { kind: "conflict"; heldByProfileId: string; heldByVehicle: string };

// Bind this profile's row. Restricted to rows that are already candidate/bound
// so a closed_out/excluded_conflict row is not silently resurrected. Re-binding
// an already-'bound' row of the SAME profile is a no-op that does NOT trip the
// partial-unique index (the index sees the same single bound row for the dealer).
const UPDATE_BIND =
  "UPDATE profile_dealers SET status = 'bound', bound_at = CURRENT_TIMESTAMP " +
  "WHERE search_profile_id = ? AND dealer_id = ? AND status IN ('candidate', 'bound')";

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
 * The bind + the conflict-marking run in ONE transaction so a conflict never
 * leaves a half-written state.
 */
export function claimDealer(args: {
  searchProfileId: string;
  dealerId: string;
  db?: Db;
}): ClaimResult {
  const db = args.db ?? getDb();
  const conn = db.$client;

  const txn = conn.transaction((): ClaimResult => {
    try {
      conn.prepare(UPDATE_BIND).run(args.searchProfileId, args.dealerId);
      return { kind: "claimed" };
    } catch (err) {
      if (!isUniqueConstraint(err)) throw err;
      // A different profile holds the dealer bound. Look up the holder + its
      // vehicle label, then exclude THIS profile's row.
      const holder = conn.prepare(SELECT_HOLDER).get(args.dealerId) as
        | { profile_id: string; year?: unknown; make?: unknown; model?: unknown; trim?: unknown }
        | undefined;
      const heldByProfileId = holder?.profile_id ?? "unknown";
      const heldByVehicle = holder === undefined ? "" : vehicleLabel(holder);
      conn
        .prepare(UPDATE_EXCLUDE)
        .run(`engaged_by:${heldByProfileId}`, args.searchProfileId, args.dealerId);
      return { kind: "conflict", heldByProfileId, heldByVehicle };
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
