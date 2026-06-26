/**
 * giveUpProjection — the derived-on-read per-dealer give-up advisory the Dealers
 * canvas renders. Composes the candidate-thread read with the pure timing-gate /
 * follow-up-cap deciders and the give-up verdict, all over current DB rows (no
 * stored score — mirrors profileHealth's derived-on-read shape). The server route
 * delegates DOWN into listProfileDealerRowsWithVerdicts (the SQLite invariant +
 * the thin-route convention). Read-only.
 *
 * It is ADVISORY ONLY: this computes a recommendation; it never sends, never
 * writes profile_dealers.status, and never changes which threads a follow-up run
 * targets. The send floor stays the L2 gate + the cap/gate in negotiation_followup.
 */

import type { Db } from "@autobroker/db";

import { BATCH_SILENCE_WINDOW_DAYS } from "../dealerComm/constants.js";
import { dealerGiveUpDecision, type DealerVerdict, type GiveUpReason } from "../dealerComm/giveUp.js";
import { followupCapDecision, gateDecisionForTarget } from "../dealerComm/replyTargets.js";
import { listProfileDealerRows } from "../profile/profileService.js";

import { listFollowupCandidateThreads, readDealerGiveUpInputs } from "./followupReads.js";

/** Terminal thread states a give-up verdict does not apply to. selectNextReplyTargets
 *  excludes agreed/closed; this projection ALSO excludes suppressed (a hygiene-
 *  killed thread is not a give-up candidate) — intentionally MORE conservative
 *  than the reply ranker, not a claim of parity. */
const TERMINAL_STATES = new Set(["agreed", "closed", "suppressed"]);

/** Display precedence when ONE dealer has several active threads: an ENGAGED
 *  (continue) thread wins, so the buyer is never told to abandon a dealer they are
 *  actively negotiating with on another vehicle; otherwise the actionable
 *  give_up_switch outranks a passive hold. Lower rank = shown. */
const VERDICT_RANK: Record<DealerVerdict, number> = { continue: 0, give_up_switch: 1, hold: 2 };

/** One dealer's give-up advisory row (budget-free: only dealer-side OTD figures). */
export interface DealerVerdictRow {
  threadId: string;
  dealerId: string;
  dealerName: string | null;
  verdict: DealerVerdict;
  reason: GiveUpReason;
  /** Dollars the best quality same-mode competitor beats this dealer by, or null. */
  batnaGapUsd: number | null;
}

/** Which of two same-dealer verdict rows is shown: lower VERDICT_RANK first, then
 *  the more compelling (larger BATNA gap), then the lowest threadId — fully
 *  deterministic, never a coin-flip on key-insertion order. */
function outranks(a: DealerVerdictRow, b: DealerVerdictRow): boolean {
  if (VERDICT_RANK[a.verdict] !== VERDICT_RANK[b.verdict]) {
    return VERDICT_RANK[a.verdict] < VERDICT_RANK[b.verdict];
  }
  const ga = a.batnaGapUsd ?? -1;
  const gb = b.batnaGapUsd ?? -1;
  if (ga !== gb) return ga > gb;
  return a.threadId < b.threadId;
}

/**
 * The per-DEALER give-up advisory for one profile's active (non-terminal) dealer
 * threads. For each thread: the timing gate (batch silence window) + the
 * responsive follow-up cap + the same-vehicle / same-mode, confidence-floored
 * give-up inputs feed the pure dealerGiveUpDecision; threads are then REDUCED to
 * one verdict per dealer by the deterministic precedence above. Read-only; mirrors
 * profileHealth (no stored score, recomputed each read so a re-conceding dealer
 * flips back to continue).
 */
export function listProfileDealerVerdicts(
  db: Db,
  profileId: string,
  opts: { nowMs?: number } = {},
): DealerVerdictRow[] {
  const nowMs = opts.nowMs ?? Date.now();
  const candidates = listFollowupCandidateThreads(db, profileId).filter((c) => !TERMINAL_STATES.has(c.state));

  const byDealer = new Map<string, DealerVerdictRow>();
  for (const c of candidates) {
    const gate = gateDecisionForTarget(c.lastInboundAtMs, c.lastOutboundAtMs, {
      maxGapDays: BATCH_SILENCE_WINDOW_DAYS,
      nowMs,
    });
    const cap = followupCapDecision(c.unansweredFollowups, c.roundsSent);
    const inputs = readDealerGiveUpInputs(db, { profileId, dealerId: c.dealerId, nowMs });
    const d = dealerGiveUpDecision({
      gate,
      cap,
      otdTrajectory: inputs.otdTrajectory,
      isItemized: inputs.isItemized,
      currentOtd: inputs.currentOtd,
      bestCompetingOtd: inputs.bestCompetingOtd,
    });
    const row: DealerVerdictRow = {
      threadId: c.threadId,
      dealerId: c.dealerId,
      dealerName: c.dealerName,
      verdict: d.verdict,
      reason: d.reason,
      batnaGapUsd: d.batnaGapUsd,
    };
    const prev = byDealer.get(c.dealerId);
    if (prev === undefined || outranks(row, prev)) byDealer.set(c.dealerId, row);
  }
  return [...byDealer.values()];
}

/**
 * The Dealers-canvas projection: the profile_dealers rows enriched with the
 * derived give-up verdict, merged by dealer_id. A dealer with no active thread
 * keeps no verdict field (no chip). Budget-free (dealer-side OTD only). The server
 * route delegates straight to this. Read-only.
 */
export function listProfileDealerRowsWithVerdicts(
  db: Db,
  profileId: string,
  opts: { nowMs?: number } = {},
): Record<string, unknown>[] {
  const rows = listProfileDealerRows(db, profileId);
  const byDealer = new Map(listProfileDealerVerdicts(db, profileId, opts).map((v) => [v.dealerId, v]));
  return rows.map((r) => {
    const v = byDealer.get(r.dealer_id as string);
    return v === undefined
      ? r
      : { ...r, verdict: v.verdict, verdict_reason: v.reason, batna_gap_usd: v.batnaGapUsd };
  });
}
