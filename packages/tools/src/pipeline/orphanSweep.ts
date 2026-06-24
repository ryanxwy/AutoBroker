/**
 * boot orphan sweep — release dealership claims abandoned by a crashed/aborted
 * pipeline so the dealer is not locked to a dead profile forever.
 *
 * THE EXCLUSIVITY INVARIANT (load-bearing): a dealer may be `'bound'` to at most
 * one profile (claimDealer / migration 0003's partial-unique index). A claim
 * that a run acquired and then never released — because the process crashed, or
 * the engage step ran but the pipeline was abandoned before any send — would
 * otherwise pin the dealer for every other profile indefinitely. This sweep is
 * the boot-time reconcile that frees those genuinely-orphaned claims.
 *
 * CONSERVATIVE by design — a claim is released ONLY when BOTH hold:
 *   1. its profile has NO live/suspended run (not in `liveProfileIds`), AND
 *   2. it is dormant: `now - dormancyTs > dormancyDays`, where dormancyTs is the
 *      profile's progress watermark, or — when no watermark was ever written
 *      (engage-then-abort) — its most-recent `bound_at`. A profile that is live,
 *      or whose dormancyTs is recent, is LEFT ALONE.
 * Releasing reuses `releaseDealerClaims` (bound → closed_out), one call per
 * orphaned profile. The counts are returned (never swallowed) so the boot path
 * can log the sweep — there is no silent release.
 *
 * UTC PARSING: a `bound_at` CURRENT_TIMESTAMP value is the string
 * 'YYYY-MM-DD HH:MM:SS' in UTC; it is parsed as UTC (…'T'… + 'Z'), never local
 * time. A numeric epoch value (ms or s) is handled too.
 *
 * SQLITE INVARIANT: raw better-sqlite3 handle (db.$client) only — the tools
 * layer never imports drizzle-orm.
 *
 * Dependency wall: imports @autobroker/db and sibling tools-layer modules only.
 */

import { getDb, type Db } from "@autobroker/db";

import { releaseDealerClaims } from "../leadSubmissions/claimDealer.js";
import { COLD_DORMANCY_DAYS, readLastProgressAt } from "./progressWatermark.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OrphanSweepResult {
  /** Profiles whose orphaned bound claims were released this sweep. */
  releasedProfileIds: string[];
  /** Total profile_dealers rows flipped bound → closed_out across all of them. */
  releasedRows: number;
}

const SELECT_BOUND_PROFILES =
  "SELECT DISTINCT search_profile_id FROM profile_dealers WHERE status = 'bound'";

// The profile's most-recent bind timestamp among its still-bound rows — the
// fallback dormancy marker when no progress watermark was ever written. MAX over
// the numeric-affinity column is a lexicographic max, which IS chronologically
// correct for the fixed 'YYYY-MM-DD HH:MM:SS' CURRENT_TIMESTAMP shape (the only
// form bound_at is ever written in — fixed-width fields sort the same as time).
const SELECT_MAX_BOUND_AT =
  "SELECT MAX(bound_at) AS bound_at FROM profile_dealers " +
  "WHERE search_profile_id = ? AND status = 'bound'";

/**
 * Parse a dormancy marker to epoch-ms. Accepts:
 *  - an ISO string (the progress watermark, written via Date#toISOString);
 *  - a numeric epoch (ms, or seconds when < 1e12) stored in bound_at;
 *  - a SQLite CURRENT_TIMESTAMP string 'YYYY-MM-DD HH:MM:SS' (parsed as UTC).
 * Returns null when the value is absent or unparseable.
 */
function parseDormancyTs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value < 1e12 ? value * 1000 : value; // seconds vs ms epoch
  }
  // A pure-numeric string stored in a numeric column.
  if (/^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return n < 1e12 ? n * 1000 : n;
  }
  // An ISO string already carries a zone (Z / offset) — Date.parse handles it.
  // A bare CURRENT_TIMESTAMP 'YYYY-MM-DD HH:MM:SS' has no zone, so pin UTC.
  const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value.trim());
  const iso = hasZone ? value.trim() : `${value.trim().replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Release every dealership claim orphaned by a crashed/aborted pipeline. See the
 * module header for the conservative two-condition release rule.
 */
export function sweepOrphanedBoundClaims(args: {
  liveProfileIds: ReadonlySet<string> | readonly string[];
  nowMs?: number;
  dormancyDays?: number;
  db?: Db;
}): OrphanSweepResult {
  const db = args.db ?? getDb();
  const conn = db.$client;
  const nowMs = args.nowMs ?? Date.now();
  const dormancyDays = args.dormancyDays ?? COLD_DORMANCY_DAYS;
  const dormancyMs = dormancyDays * DAY_MS;
  const live =
    args.liveProfileIds instanceof Set ? args.liveProfileIds : new Set(args.liveProfileIds);

  const boundProfiles = (conn.prepare(SELECT_BOUND_PROFILES).all() as Array<{
    search_profile_id: string;
  }>).map((r) => r.search_profile_id);

  const releasedProfileIds: string[] = [];
  let releasedRows = 0;

  for (const profileId of boundProfiles) {
    if (live.has(profileId)) continue; // live profile — never released

    // Dormancy marker: progress watermark, else most-recent bound_at fallback.
    let dormancyTs = parseDormancyTs(readLastProgressAt(db, profileId));
    if (dormancyTs === null) {
      const row = conn.prepare(SELECT_MAX_BOUND_AT).get(profileId) as
        | { bound_at: string | number | null }
        | undefined;
      dormancyTs = parseDormancyTs(row?.bound_at);
    }
    // No usable timestamp at all — leave it alone (cannot prove abandonment).
    if (dormancyTs === null) continue;
    if (nowMs - dormancyTs <= dormancyMs) continue; // recent — leave alone

    const rows = releaseDealerClaims({ searchProfileId: profileId, db });
    if (rows > 0) {
      releasedProfileIds.push(profileId);
      releasedRows += rows;
    }
  }

  return { releasedProfileIds, releasedRows };
}
