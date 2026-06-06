/**
 * Typed three-branch profile resolver (the profile-ASK three-branch rule — see
 * CLAUDE.md).
 *
 * The profile-ASK three-branch contract used to be skill markdown prose with no
 * function enforcing 1/0/2+ STOP semantics (readers.md:1404/1456). In full-TS it
 * is THIS typed tools-layer function:
 *
 *   threadPin (non-empty + active) → kind:'pinned'         → run
 *   exactly 1 active               → kind:'inferred_newest' → LOG + run
 *   0 active                       → kind:'none'            → STOP, point to intake
 *   2+ active                      → kind:'ambiguous'       → STOP, ask by vehicle
 *
 * INTAKE EXEMPTION: intake itself does NOT call this — it is
 * CREATING the profile, so there is nothing to resolve. The three branches govern
 * DOWNSTREAM skills that act on an existing profile. Intake's own inverse guard
 * is the active unique index → ActiveSlotConflict (see profileService.create).
 *
 * NEWEST-ACTIVE TIEBREAK = ROWID DESC: the product
 * schema is frozen by the drizzle empty-diff CI gate — there is NO created_at
 * column to add, and the synth-hash id has no chronological order. SQLite ROWID
 * is the insertion order, so `ORDER BY rowid DESC` is the newest-active rule.
 *
 * NULL status = v1-implicit-active: legacy oracle rows may carry NULL status; the
 * active filter treats NULL as active (status IS 'active' OR status IS NULL),
 * while terminal states (superseded/closed) are filtered out.
 *
 * NEVER SILENTLY PICK: every inferred_newest resolution is LOGGED (structured
 * trace record), so an inferred pick is always auditable.
 *
 * SQLITE ACCESS: queries go through the raw better-sqlite3 handle (db.$client) —
 * tools must NOT import drizzle-orm operators (dependency-cruiser
 * `sqlite-only-in-db`, severity error). This keeps full control of the ROWID
 * predicate the query builder would hide.
 */

import type { Db } from "@autobroker/db";
import { rowToProfile, type SearchProfileRow } from "./adapter.js";
import {
  MultipleActiveProfilesError,
  NoActiveProfileError,
} from "./errors.js";
import type { SearchProfile } from "@autobroker/core";

/** Discriminated resolver result. */
export type ResolveResult =
  | { kind: "pinned"; profile: SearchProfile }
  | { kind: "inferred_newest"; profile: SearchProfile }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: SearchProfile[] };

/**
 * Trace sink for inferred_newest resolutions (never silently pick). Default
 * writes a structured line to the console; tests inject a spy to assert the log
 * fired. This is a trace span, not the audit_log (no DB write — resolution is a
 * read, the audit_log records mutations).
 */
export type ResolverTrace = (record: {
  event: "inferred_newest_resolution";
  profileId: string;
  vehicle: string;
}) => void;

const defaultTrace: ResolverTrace = (record) => {
  // Structured single-line trace; the harness can scrape it.
  console.info(JSON.stringify({ trace: "resolver", ...record }));
};

/** SELECT the active profiles, newest first (ROWID DESC). NULL status counts as
 *  v1-implicit-active; superseded/closed are excluded. */
const SELECT_ACTIVE =
  "SELECT * FROM search_profiles " +
  "WHERE status = 'active' OR status IS NULL " +
  "ORDER BY rowid DESC";

/** Look up one profile by id regardless of status (for threadPin validation). */
const SELECT_BY_ID = "SELECT * FROM search_profiles WHERE search_profile_id = ?";

/** Human label for ask-by-vehicle: "2025 Toyota RAV4 XLE". */
function vehicleLabel(p: SearchProfile): string {
  return [p.year, p.make, p.model, p.trim].filter((x) => x != null && x !== "").join(" ");
}

/** True when a row is in an active (or v1-implicit-active NULL) state. */
function isActiveStatus(status: string | null): boolean {
  return status === "active" || status === null;
}

/**
 * resolveActiveProfile — the typed three-branch resolver.
 *
 * @param db    the tools-layer DB handle (the ONLY layer that touches SQLite).
 * @param args  { threadPin? } the session-pinned profile id, if any.
 * @param trace inferred_newest trace sink (default console); injectable for tests.
 */
export function resolveActiveProfile(
  db: Db,
  args: { threadPin?: string } = {},
  trace: ResolverTrace = defaultTrace,
): ResolveResult {
  // --- pinned branch: an explicit, still-active pin wins ---------------------
  if (args.threadPin !== undefined && args.threadPin !== "") {
    const pinnedRow = db.$client
      .prepare(SELECT_BY_ID)
      .get(args.threadPin) as SearchProfileRow | undefined;
    if (pinnedRow !== undefined && isActiveStatus(pinnedRow.status)) {
      return { kind: "pinned", profile: rowToProfile(pinnedRow) };
    }
    // A stale/closed/missing pin does NOT pin — fall through to count active.
  }

  // --- count active (ROWID DESC) ---------------------------------------------
  const rows = db.$client.prepare(SELECT_ACTIVE).all() as SearchProfileRow[];
  const profiles = rows.map(rowToProfile);

  if (profiles.length === 0) {
    return { kind: "none" }; // STOP → point to intake.
  }
  if (profiles.length === 1) {
    const profile = profiles[0]!;
    trace({
      event: "inferred_newest_resolution",
      profileId: profile.id,
      vehicle: vehicleLabel(profile),
    });
    return { kind: "inferred_newest", profile };
  }
  // 2+ → ambiguous. STOP → ask by vehicle name.
  return { kind: "ambiguous", candidates: profiles };
}

/**
 * Same three-branch logic, but THROWS the typed STOP errors instead of returning
 * a discriminated union — for call sites that demand a single profile and want
 * the error envelope. `pinned`/`inferred_newest` return the profile;
 * `none` → NoActiveProfileError; `ambiguous` → MultipleActiveProfilesError.
 */
export function requireActiveProfile(
  db: Db,
  args: { threadPin?: string } = {},
  trace: ResolverTrace = defaultTrace,
): SearchProfile {
  const result = resolveActiveProfile(db, args, trace);
  switch (result.kind) {
    case "pinned":
    case "inferred_newest":
      return result.profile;
    case "none":
      throw new NoActiveProfileError();
    case "ambiguous":
      throw new MultipleActiveProfilesError(
        result.candidates.map((p) => ({ id: p.id, label: vehicleLabel(p) })),
      );
  }
}
