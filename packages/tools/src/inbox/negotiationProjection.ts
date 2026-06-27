/**
 * negotiationProjection — the derived-on-read per-DEALER negotiation summary the
 * dealer-negotiation cards grid renders. ONE record per bound dealer, ordered by
 * actionability. Composes the give-up advisory projection (facts + verdict +
 * batna_gap_usd) with two profile-scoped aggregate reads (the message count and
 * the dealer_quotes roll-up) and the per-thread negotiation status reduced to one
 * status per dealer. The server route delegates DOWN into this. Read-only.
 *
 * No stored column: like the give-up advisory and the per-thread status overlay,
 * every figure is recomputed each read, so a re-conceding dealer flips back
 * without any persisted-state write to maintain. Budget-free (dealer-side OTD /
 * discount only); the competing dealer is never named (only the batna_gap_usd
 * scalar crosses, inherited from the give-up projection).
 */

import type { Db } from "@autobroker/db";

import type { NegotiationStatus } from "../dealerComm/negotiationStatus.js";

import { listFollowupCandidateThreads } from "./followupReads.js";
import { listProfileDealerRowsWithVerdicts } from "./giveUpProjection.js";
import { listProfileThreadStatuses } from "./negotiationStatusProjection.js";

/**
 * Actionability rank for the live negotiation status — lower = more worth the
 * buyer's attention right now. A dealer actively conceding (countered) outranks a
 * stalled one, which outranks a fresh quote, and so on down to the terminal
 * dead/agreed states. Used both to REDUCE a dealer's many threads to its single
 * most-actionable status and to SORT the grid.
 */
export const NEGOTIATION_STATUS_RANK: Record<NegotiationStatus, number> = {
  countered: 0,
  stalled: 1,
  quoted: 2,
  replied: 3,
  lead_sent: 4,
  dormant: 5,
  agreed: 6,
  dead: 7,
};

/** A dealer with no thread (no negotiation_status) sorts after every status. */
const NO_STATUS_RANK = 8;

/** One dealer's negotiation summary card. Budget-free: only dealer-side figures. */
export interface DealerNegotiationRow {
  dealer_id: string;
  name: string | null;
  city: string | null;
  state: string | null;
  candidate_status: string | null;
  lead_submission_count: number;
  email_count: number;
  quote_sent: boolean;
  best_otd: number | null;
  best_discount: number | null;
  /** Present only when the dealer has an active thread with a give-up verdict. */
  verdict?: string;
  verdict_reason?: string;
  batna_gap_usd?: number | null;
  /** Present only when the dealer has at least one (non-terminal-excluded) thread. */
  negotiation_status?: NegotiationStatus;
}

/** COUNT(messages) per dealer (both directions) via the threads.dealer_id join,
 *  profile-scoped. A dealer with no thread is simply absent from the map (→ 0). */
function emailCountByDealer(db: Db, profileId: string): Map<string, number> {
  const rows = db.$client
    .prepare(
      "SELECT t.dealer_id AS dealerId, COUNT(*) AS cnt " +
        "FROM messages m JOIN threads t ON t.thread_id = m.thread_id " +
        "WHERE m.search_profile_id = ? " +
        "GROUP BY t.dealer_id",
    )
    .all(profileId) as Array<{ dealerId: string; cnt: number }>;
  return new Map(rows.map((r) => [r.dealerId, r.cnt]));
}

interface QuoteAgg {
  bestOtd: number | null;
  bestDiscount: number | null;
}

/** The dealer_quotes roll-up per dealer (profile-scoped): MIN(otd_total) and
 *  MAX(dealer_discount). Presence in the map ⇒ quote_sent. */
function quoteAggByDealer(db: Db, profileId: string): Map<string, QuoteAgg> {
  const rows = db.$client
    .prepare(
      "SELECT dealer_id AS dealerId, MIN(otd_total) AS bestOtd, MAX(dealer_discount) AS bestDiscount " +
        "FROM dealer_quotes WHERE search_profile_id = ? " +
        "GROUP BY dealer_id",
    )
    .all(profileId) as Array<{ dealerId: string; bestOtd: number | null; bestDiscount: number | null }>;
  return new Map(rows.map((r) => [r.dealerId, { bestOtd: r.bestOtd, bestDiscount: r.bestDiscount }]));
}

/** Reduce each dealer's per-thread negotiation statuses to ONE: lowest
 *  NEGOTIATION_STATUS_RANK, tie-broken by the newest thread activity. */
function negotiationStatusByDealer(
  db: Db,
  profileId: string,
  opts: { nowMs?: number },
): Map<string, NegotiationStatus> {
  const statusByThread = new Map(
    listProfileThreadStatuses(db, profileId, opts).map((s) => [s.threadId, s.status]),
  );
  const best = new Map<string, { status: NegotiationStatus; tieMs: number }>();
  for (const c of listFollowupCandidateThreads(db, profileId)) {
    const status = statusByThread.get(c.threadId);
    if (status === undefined) continue;
    const tieMs = Math.max(c.lastInboundAtMs ?? -Infinity, c.lastOutboundAtMs ?? -Infinity);
    const prev = best.get(c.dealerId);
    if (
      prev === undefined ||
      NEGOTIATION_STATUS_RANK[status] < NEGOTIATION_STATUS_RANK[prev.status] ||
      (NEGOTIATION_STATUS_RANK[status] === NEGOTIATION_STATUS_RANK[prev.status] && tieMs > prev.tieMs)
    ) {
      best.set(c.dealerId, { status, tieMs });
    }
  }
  return new Map([...best].map(([id, v]) => [id, v.status]));
}

/**
 * The dealer-negotiation cards grid: one record per bound dealer, enriched with
 * the message count, the quote roll-up (MIN otd / MAX discount), the give-up
 * verdict (+ batna_gap_usd) and the most-actionable negotiation status, sorted by
 * actionability (status rank asc → batna_gap_usd desc → name asc). Read-only;
 * delegates the dealer universe + verdict to listProfileDealerRowsWithVerdicts so
 * a zero-thread dealer still appears (email_count 0, quote_sent false, no status).
 */
export function listProfileDealerNegotiations(
  db: Db,
  profileId: string,
  opts: { nowMs?: number } = {},
): DealerNegotiationRow[] {
  const base = listProfileDealerRowsWithVerdicts(db, profileId, opts);
  const emails = emailCountByDealer(db, profileId);
  const quotes = quoteAggByDealer(db, profileId);
  const statuses = negotiationStatusByDealer(db, profileId, opts);

  const out = base.map((r): DealerNegotiationRow => {
    const dealerId = r.dealer_id as string;
    const agg = quotes.get(dealerId);
    const status = statuses.get(dealerId);
    const row: DealerNegotiationRow = {
      dealer_id: dealerId,
      name: (r.name as string | null) ?? null,
      city: (r.city as string | null) ?? null,
      state: (r.state as string | null) ?? null,
      candidate_status: (r.candidate_status as string | null) ?? null,
      lead_submission_count: Number(r.lead_submission_count ?? 0),
      email_count: emails.get(dealerId) ?? 0,
      quote_sent: agg !== undefined,
      best_otd: agg?.bestOtd ?? null,
      best_discount: agg?.bestDiscount ?? null,
    };
    if (r.verdict !== undefined) row.verdict = r.verdict as string;
    if (r.verdict_reason !== undefined) row.verdict_reason = r.verdict_reason as string;
    if (r.batna_gap_usd !== undefined) row.batna_gap_usd = r.batna_gap_usd as number | null;
    if (status !== undefined) row.negotiation_status = status;
    return row;
  });

  return out.sort((a, b) => {
    const ra = a.negotiation_status !== undefined ? NEGOTIATION_STATUS_RANK[a.negotiation_status] : NO_STATUS_RANK;
    const rb = b.negotiation_status !== undefined ? NEGOTIATION_STATUS_RANK[b.negotiation_status] : NO_STATUS_RANK;
    if (ra !== rb) return ra - rb;
    const ga = a.batna_gap_usd ?? -Infinity;
    const gb = b.batna_gap_usd ?? -Infinity;
    if (ga !== gb) return gb - ga;
    return (a.name ?? "").localeCompare(b.name ?? "");
  });
}
