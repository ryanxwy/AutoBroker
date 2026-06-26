/**
 * negotiationStatusProjection — the derived-on-read per-thread negotiation status
 * the Threads/Replies canvas renders. Composes the candidate-thread read with the
 * pure timing-gate / follow-up-cap deciders and the give-up trajectory inputs, then
 * the pure deriveNegotiationStatus. It also re-orders the thread rows by the HONEST
 * last_activity_at (the newest message timestamp), not threads.updated_at. The
 * server route delegates DOWN into listProfileThreadRowsWithStatus. Read-only.
 *
 * No stored status column: like profileHealth / the give-up advisory, this is
 * recomputed each read, so a re-conceding dealer flips back to `countered` without
 * any persisted-state write to maintain.
 */

import type { Db } from "@autobroker/db";

import { BATCH_SILENCE_WINDOW_DAYS } from "../dealerComm/constants.js";
import { deriveNegotiationStatus, type NegotiationStatus } from "../dealerComm/negotiationStatus.js";
import { followupCapDecision, gateDecisionForTarget } from "../dealerComm/replyTargets.js";

import { listFollowupCandidateThreads, readDealerGiveUpInputs } from "./followupReads.js";
import { listProfileThreadRows } from "./reads.js";

/** Parse an ISO-string OR epoch-ms timestamp to epoch-ms, or null (the schema's
 *  dual format — a SQL sort can't order both, so we sort in JS). */
function toEpochMs(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    if (raw.trim() === "") return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export interface ThreadStatusRow {
  threadId: string;
  status: NegotiationStatus;
}

/**
 * The per-thread derived negotiation status for one profile. For each thread: the
 * timing gate (batch silence window) + the follow-up cap + the same-vehicle OTD
 * trajectory (current vs prior, reused from readDealerGiveUpInputs) feed the pure
 * deriveNegotiationStatus. Read-only.
 */
export function listProfileThreadStatuses(
  db: Db,
  profileId: string,
  opts: { nowMs?: number } = {},
): ThreadStatusRow[] {
  const nowMs = opts.nowMs ?? Date.now();
  return listFollowupCandidateThreads(db, profileId).map((c) => {
    const gate = gateDecisionForTarget(c.lastInboundAtMs, c.lastOutboundAtMs, {
      maxGapDays: BATCH_SILENCE_WINDOW_DAYS,
      nowMs,
    });
    const cap = followupCapDecision(c.unansweredFollowups, c.roundsSent);
    // CAVEAT: readDealerGiveUpInputs is per-DEALER (the dealer's latest open quote
    // across all its vehicles). For the dominant one-thread-per-dealer case this is
    // exact; a dealer running TWO threads on two vehicles would borrow the same
    // quote for both threads' countered/stalled. Acceptable for v1 (same property
    // as the give-up advisory); a per-thread vehicle key is a follow-up.
    const inputs = readDealerGiveUpInputs(db, { profileId, dealerId: c.dealerId, nowMs });
    const status = deriveNegotiationStatus({
      persistedState: c.state,
      gate,
      cap,
      lastInboundAtMs: c.lastInboundAtMs,
      roundsSent: c.roundsSent,
      currentOtd: inputs.currentOtd,
      priorOtd: inputs.otdTrajectory[1] ?? null,
    });
    return { threadId: c.threadId, status };
  });
}

/**
 * The Threads-canvas projection: the thread rows enriched with the derived
 * negotiation_status (merged by thread_id) and re-ordered by the honest
 * last_activity_at (newest first), parsed in JS because the column is ISO or
 * epoch-ms. The server route delegates straight to this. Read-only.
 */
export function listProfileThreadRowsWithStatus(
  db: Db,
  profileId: string,
  opts: { nowMs?: number } = {},
): Record<string, unknown>[] {
  const rows = listProfileThreadRows(db, profileId);
  const byThread = new Map(listProfileThreadStatuses(db, profileId, opts).map((s) => [s.threadId, s.status]));
  return rows
    .map((r): Record<string, unknown> => {
      // Normalize last_activity_at to an ISO string so the UI's relativeDate (which
      // Date.parse's it) renders an epoch-ms value too; null stays null.
      const ms = toEpochMs(r.last_activity_at);
      const base: Record<string, unknown> = {
        ...r,
        last_activity_at: ms !== null ? new Date(ms).toISOString() : null,
      };
      const status = byThread.get(r.thread_id as string);
      return status === undefined ? base : { ...base, negotiation_status: status };
    })
    .sort((a, b) => {
      const am = toEpochMs(a.last_activity_at) ?? -Infinity;
      const bm = toEpochMs(b.last_activity_at) ?? -Infinity;
      if (am !== bm) return bm - am; // newest activity first (honest order)
      return String(a.thread_id) < String(b.thread_id) ? -1 : 1; // stable tiebreak
    });
}
