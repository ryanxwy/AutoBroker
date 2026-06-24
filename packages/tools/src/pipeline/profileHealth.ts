/**
 * profileHealth — the read-only HOT/WARM/COLD classification of every
 * non-terminal search profile, the derived "activity" signal the multi-profile
 * pipeline uses to decide which profiles still warrant attention. Pure read; no
 * writes, no checkpoint. It is recomputed on demand from the live DB plus the set
 * of profiles whose pipeline is currently running (the caller supplies that set —
 * this layer cannot observe in-flight runs).
 *
 * Classification (per profile; the FIRST matching tier wins):
 *
 *   HOT  — the profile is actively in play. Any of:
 *            1. it is in the live-run set                         → live_run
 *            2. detectPipelineState reports an applicable step    → detect:<flag>
 *            3. it has a thread that is gate=ready AND cap=ok      → thread_ready
 *            4. a non-archived session pinned to it had activity
 *               within the dormancy window                        → pinned_session
 *
 *   COLD — NOT hot AND the progress watermark is older than the dormancy window
 *          AND every thread is gate=skip or cap!=ok (vacuously true with zero
 *          threads). A NULL watermark is NOT stale, so a fresh profile is never
 *          cold.                                          → dormant_<N>d, all_threads_capped
 *
 *   WARM — anything else (fresh/NULL watermark, or recent progress). → warm
 *
 * Enumerates ONLY profiles with status 'active' or NULL (a closed_out / terminal
 * profile is excluded outright). Mirrors detectPipelineState's raw-SQL style and
 * reuses the per-profile follow-up read + the pure timing-gate / follow-up-cap
 * deciders rather than reimplementing the per-thread SQL.
 *
 * SQLITE INVARIANT: reads go through the raw better-sqlite3 handle (db.$client)
 * like the sibling pipeline modules — tools never imports drizzle-orm operators.
 */

import type { Db } from "@autobroker/db";

import { followupCapDecision, gateDecisionForTarget } from "../dealerComm/replyTargets.js";
import { listFollowupCandidateThreads } from "../inbox/followupReads.js";
import { DEFAULT_AUDIT_PASS_VERSION } from "../quotes/quotesRead.js";

import { detectPipelineState, type PipelineStateFlags } from "./detectPipelineState.js";
import { COLD_DORMANCY_DAYS, readLastProgressAt } from "./progressWatermark.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type ProfileHealthLevel = "hot" | "warm" | "cold";

export interface ProfileHealth {
  profileId: string;
  health: ProfileHealthLevel;
  /** The signals that drove the classification (one per matching condition). */
  reasons: string[];
}

export interface ProfileHealthOpts {
  nowMs?: number;
  auditPassVersion?: string;
  dormancyDays?: number;
}

// Non-terminal profiles only: active or status-not-yet-set.
const SELECT_NON_TERMINAL_PROFILES = `
SELECT search_profile_id AS profileId
  FROM search_profiles
 WHERE status = 'active' OR status IS NULL
`;

// The non-archived sessions pinned to a profile, newest activity first. Activity
// is an ISO string; freshness is decided in JS (Date.parse).
const SELECT_PINNED_SESSION_ACTIVITY = `
SELECT MAX(last_activity_at) AS lastActivityAt
  FROM sessions
 WHERE pinned_profile_id = ?
   AND archived = 0
`;

/** The detect flags in canonical order, for stable reason ordering. */
const DETECT_FLAGS: (keyof PipelineStateFlags)[] = ["extract", "scrape", "audit", "compare"];

/**
 * Classify every non-terminal profile hot / warm / cold. Pure read.
 *
 * @param liveRunProfileIds the profiles whose pipeline is currently running
 *   (a Set or array; normalized internally) — the only signal this layer cannot
 *   derive from the DB.
 */
export function profileHealth(
  db: Db,
  liveRunProfileIds: ReadonlySet<string> | readonly string[],
  opts: ProfileHealthOpts = {},
): ProfileHealth[] {
  const nowMs = opts.nowMs ?? Date.now();
  const auditPassVersion = opts.auditPassVersion ?? DEFAULT_AUDIT_PASS_VERSION;
  const dormancyDays = opts.dormancyDays ?? COLD_DORMANCY_DAYS;
  const liveSet =
    liveRunProfileIds instanceof Set ? liveRunProfileIds : new Set(liveRunProfileIds);

  const profiles = db.$client.prepare(SELECT_NON_TERMINAL_PROFILES).all() as {
    profileId: string;
  }[];

  return profiles.map(({ profileId }) =>
    classifyProfile(db, profileId, { nowMs, auditPassVersion, dormancyDays, liveSet }),
  );
}

function classifyProfile(
  db: Db,
  profileId: string,
  ctx: {
    nowMs: number;
    auditPassVersion: string;
    dormancyDays: number;
    liveSet: ReadonlySet<string>;
  },
): ProfileHealth {
  // Compute each thread's gate/cap once — reused by HOT#3 and the COLD condition.
  const threads = listFollowupCandidateThreads(db, profileId).map((t) => ({
    gate: gateDecisionForTarget(t.lastInboundAtMs, t.lastOutboundAtMs, { nowMs: ctx.nowMs }),
    cap: followupCapDecision(t.unansweredFollowups, t.roundsSent),
  }));

  // --- HOT (first match wins) ---
  if (ctx.liveSet.has(profileId)) {
    return { profileId, health: "hot", reasons: ["live_run"] };
  }

  const flags = detectPipelineState({
    searchProfileId: profileId,
    auditPassVersion: ctx.auditPassVersion,
    nowMs: ctx.nowMs,
    db,
  });
  const detectReasons = DETECT_FLAGS.filter((f) => flags[f]).map((f) => `detect:${f}`);
  if (detectReasons.length > 0) {
    return { profileId, health: "hot", reasons: detectReasons };
  }

  if (threads.some((t) => t.gate === "ready" && t.cap === "ok")) {
    return { profileId, health: "hot", reasons: ["thread_ready"] };
  }

  const pinnedRow = db.$client.prepare(SELECT_PINNED_SESSION_ACTIVITY).get(profileId) as
    | { lastActivityAt: string | null }
    | undefined;
  const pinnedActivityMs =
    pinnedRow?.lastActivityAt != null ? Date.parse(pinnedRow.lastActivityAt) : NaN;
  if (Number.isFinite(pinnedActivityMs) && ctx.nowMs - pinnedActivityMs <= ctx.dormancyDays * DAY_MS) {
    return { profileId, health: "hot", reasons: ["pinned_session"] };
  }

  // --- COLD (not hot AND stale watermark AND every thread skip/capped) ---
  const watermark = readLastProgressAt(db, profileId);
  const watermarkMs = watermark !== null ? Date.parse(watermark) : NaN;
  const ageMs = ctx.nowMs - watermarkMs;
  const watermarkStale = Number.isFinite(watermarkMs) && ageMs > ctx.dormancyDays * DAY_MS;
  // Array.prototype.every → vacuously true when the profile has zero threads.
  const allThreadsSkipOrCapped = threads.every((t) => t.gate === "skip" || t.cap !== "ok");

  if (watermarkStale && allThreadsSkipOrCapped) {
    const wholeDays = Math.floor(ageMs / DAY_MS);
    return {
      profileId,
      health: "cold",
      reasons: [`dormant_${wholeDays}d`, "all_threads_capped"],
    };
  }

  // --- WARM (everything else) ---
  return {
    profileId,
    health: "warm",
    reasons: [watermark === null ? "fresh" : "recent_progress"],
  };
}
