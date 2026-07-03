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

import { BATCH_SILENCE_WINDOW_DAYS } from "../dealerComm/constants.js";
import { dealerGiveUpDecision } from "../dealerComm/giveUp.js";
import {
  composeNegotiationStrategy,
  composeNextSteps,
  composeStatusLine,
} from "../dealerComm/negotiationAdvice.js";
import { deriveNegotiationStatus, type NegotiationStatus } from "../dealerComm/negotiationStatus.js";
import { classifyQuoteSituation } from "../dealerComm/quoteSituation.js";
import { followupCapDecision, gateDecisionForTarget } from "../dealerComm/replyTargets.js";
import { redactBudget } from "../gmail.js";
import { flagSuggestionsFromJson } from "../quotes/flags.js";

import {
  listFollowupCandidateThreads,
  readDealerContacts,
  readDealerGiveUpInputs,
  type DealerContactRead,
} from "./followupReads.js";
import { listProfileDealerRowsWithVerdicts } from "./giveUpProjection.js";
import { isNonSubstantiveReply } from "./replyFilter.js";
import { toEpochMs } from "./time.js";

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
  /** COUNT of this dealer's inbound messages with quote_extraction_status='failed'. */
  extract_failed_count: number;
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

/** COUNT(inbound messages whose quote_extraction_status='failed') per dealer via
 *  the same threads.dealer_id join, profile-scoped. Absent from the map ⇒ 0. */
function extractFailedCountByDealer(db: Db, profileId: string): Map<string, number> {
  const rows = db.$client
    .prepare(
      "SELECT t.dealer_id AS dealerId, COUNT(*) AS cnt " +
        "FROM messages m JOIN threads t ON t.thread_id = m.thread_id " +
        "WHERE m.search_profile_id = ? AND m.direction = 'inbound' AND m.quote_extraction_status = 'failed' " +
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
 *  MAX(dealer_discount). Presence in the map ⇒ quote_sent. `NULLIF(otd_total, 0)`
 *  drops a $0 hold/no-number row so it can never rank as the cheapest best_otd and
 *  hide a dealer's real OTD (PIC-20260629r2-5; new rows are already null-normalized
 *  at write, this also heals any pre-existing $0 row). */
function quoteAggByDealer(db: Db, profileId: string): Map<string, QuoteAgg> {
  const rows = db.$client
    .prepare(
      "SELECT dealer_id AS dealerId, MIN(NULLIF(otd_total, 0)) AS bestOtd, MAX(dealer_discount) AS bestDiscount " +
        "FROM dealer_quotes WHERE search_profile_id = ? " +
        "GROUP BY dealer_id",
    )
    .all(profileId) as Array<{ dealerId: string; bestOtd: number | null; bestDiscount: number | null }>;
  return new Map(rows.map((r) => [r.dealerId, { bestOtd: r.bestOtd, bestDiscount: r.bestDiscount }]));
}

/** The winning (most-actionable) thread for one dealer: the derived status plus the
 *  winning thread's timing gate + follow-up cap, which the detail advisory reuses. */
interface MostActionableThread {
  status: NegotiationStatus;
  gate: ReturnType<typeof gateDecisionForTarget>;
  cap: ReturnType<typeof followupCapDecision>;
  tieMs: number;
}

/**
 * Reduce each dealer's threads to its MOST-ACTIONABLE one — lowest
 * NEGOTIATION_STATUS_RANK, tie-broken by newest thread activity. Per thread it
 * computes the timing gate + follow-up cap + the derived negotiation status (the
 * same-vehicle OTD trajectory drives current/prior), then keeps the winner (with
 * its gate/cap for the detail advisory). Optionally scoped to one dealer. The single
 * rank-min/newest-tie comparison the grid status roll-up AND the detail advisory
 * share, so the two can never diverge. Read-only.
 */
function mostActionableThreadByDealer(
  db: Db,
  profileId: string,
  opts: { nowMs: number; dealerId?: string },
): Map<string, MostActionableThread> {
  // Memoize the per-dealer give-up inputs (current/prior OTD): a dealer with many
  // threads reads them once, not once per thread.
  const giveUpByDealer = new Map<string, ReturnType<typeof readDealerGiveUpInputs>>();
  const inputsFor = (dealerId: string): ReturnType<typeof readDealerGiveUpInputs> => {
    let v = giveUpByDealer.get(dealerId);
    if (v === undefined) {
      v = readDealerGiveUpInputs(db, { profileId, dealerId, nowMs: opts.nowMs });
      giveUpByDealer.set(dealerId, v);
    }
    return v;
  };

  const best = new Map<string, MostActionableThread>();
  for (const c of listFollowupCandidateThreads(db, profileId)) {
    if (opts.dealerId !== undefined && c.dealerId !== opts.dealerId) continue;
    const gate = gateDecisionForTarget(c.lastInboundAtMs, c.lastOutboundAtMs, {
      maxGapDays: BATCH_SILENCE_WINDOW_DAYS,
      nowMs: opts.nowMs,
    });
    const cap = followupCapDecision(c.unansweredFollowups, c.roundsSent);
    const inputs = inputsFor(c.dealerId);
    const status = deriveNegotiationStatus({
      persistedState: c.state,
      gate,
      cap,
      lastInboundAtMs: c.lastInboundAtMs,
      roundsSent: c.roundsSent,
      currentOtd: inputs.currentOtd,
      priorOtd: inputs.otdTrajectory[1] ?? null,
    });
    const tieMs = Math.max(c.lastInboundAtMs ?? -Infinity, c.lastOutboundAtMs ?? -Infinity);
    const prev = best.get(c.dealerId);
    if (
      prev === undefined ||
      NEGOTIATION_STATUS_RANK[status] < NEGOTIATION_STATUS_RANK[prev.status] ||
      (NEGOTIATION_STATUS_RANK[status] === NEGOTIATION_STATUS_RANK[prev.status] && tieMs > prev.tieMs)
    ) {
      best.set(c.dealerId, { status, gate, cap, tieMs });
    }
  }
  return best;
}

/** Reduce each dealer's per-thread negotiation statuses to ONE: a thin map over the
 *  shared most-actionable reduction. */
function negotiationStatusByDealer(
  db: Db,
  profileId: string,
  opts: { nowMs?: number },
): Map<string, NegotiationStatus> {
  const nowMs = opts.nowMs ?? Date.now();
  return new Map(
    [...mostActionableThreadByDealer(db, profileId, { nowMs })].map(([id, w]) => [id, w.status]),
  );
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
  const extractFailed = extractFailedCountByDealer(db, profileId);
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
      extract_failed_count: extractFailed.get(dealerId) ?? 0,
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

// ---------------------------------------------------------------------------
// the per-dealer detail — contacts + replies + competing scalars + advice
// ---------------------------------------------------------------------------

/** The modal short body excerpt cap (chars). A full transcript body is trimmed to
 *  this so the reply rows stay scannable; T8's summary read uses a longer cap. */
const MODAL_REPLY_EXCERPT_MAX = 320;
/** The summary-feed body cap (chars) — longer than the modal excerpt because the
 *  T8 LLM summary needs more of the dealer's prose, but still bounded. */
const SUMMARY_REPLY_BODY_MAX = 1200;

/** Trim a string to a max length, appending an ellipsis when truncated. */
function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** One inbound dealer reply row (raw, pre-shaping). */
interface SubstantiveReplyRaw {
  messageId: string;
  senderEmail: string | null;
  senderName: string | null;
  subject: string | null;
  bodyText: string | null;
  receivedAt: string | number | null;
  receivedAtMs: number | null;
}

/**
 * The dealer's SUBSTANTIVE inbound replies (the T2 filter HIDES no-reply / auto-
 * reply / CRM-relay / marketing noise that never produced a quote), newest first.
 * received_at is ISO OR epoch-ms, so newest-first is ordered in JS. Read-only,
 * profile + dealer scoped. The shared base for both the modal reply rows and the
 * T8 summary bodies (each applies its own redact + cap downstream).
 */
function readSubstantiveInboundReplies(
  db: Db,
  args: { profileId: string; dealerId: string },
): SubstantiveReplyRaw[] {
  const rows = db.$client
    .prepare(
      "SELECT m.message_id AS messageId, m.sender_email AS senderEmail, m.sender_name AS senderName, " +
        "m.subject AS subject, m.body_text AS bodyText, m.received_at AS receivedAt, " +
        "m.quote_extraction_intent AS intent, " +
        "(SELECT COUNT(*) FROM dealer_quotes dq WHERE dq.message_id = m.message_id " +
        "  AND dq.search_profile_id = m.search_profile_id) AS quoteCount " +
        "FROM messages m JOIN threads t ON t.thread_id = m.thread_id " +
        "WHERE m.search_profile_id = ? AND t.dealer_id = ? AND m.direction = 'inbound'",
    )
    .all(args.profileId, args.dealerId) as Array<{
    messageId: string;
    senderEmail: string | null;
    senderName: string | null;
    subject: string | null;
    bodyText: string | null;
    receivedAt: string | number | null;
    intent: string | null;
    quoteCount: number;
  }>;

  return rows
    .filter(
      (r) =>
        !isNonSubstantiveReply({
          senderEmail: r.senderEmail ?? "",
          subject: r.subject ?? "",
          bodyText: r.bodyText ?? "",
          quoteExtractionIntent: r.intent,
          hasExtractedQuote: r.quoteCount > 0,
        }),
    )
    .map((r) => ({
      messageId: r.messageId,
      senderEmail: r.senderEmail,
      senderName: r.senderName,
      subject: r.subject,
      bodyText: r.bodyText,
      receivedAt: r.receivedAt,
      receivedAtMs: toEpochMs(r.receivedAt),
    }))
    .sort((a, b) => {
      const am = a.receivedAtMs ?? -Infinity;
      const bm = b.receivedAtMs ?? -Infinity;
      if (am !== bm) return bm - am; // newest first
      return a.messageId < b.messageId ? 1 : a.messageId > b.messageId ? -1 : 0; // stable
    });
}

/** One reply row the detail modal renders (budget-redacted, capped excerpt). */
export interface NegotiationReplyRow {
  /** React key only — never rendered as a bare id. */
  message_id: string;
  sender_name: string | null;
  sender_email: string | null;
  subject: string | null;
  /** Redacted + capped body excerpt (never the buyer's budget). */
  body_excerpt: string | null;
  /** Raw timestamp (ISO string OR epoch-ms) for the UI's absolute render. */
  received_at: string | number | null;
}

/** One contact row the detail modal renders (budget-free; id is a key only). */
export interface NegotiationContactRow {
  contact_id: string;
  display_name: string | null;
  email: string | null;
  role: string | null;
  is_primary_reply_target: boolean;
}

/** The per-dealer negotiation detail the modal renders. Budget-free; the competing
 *  dealer is never named (only the scalar OTD + gap cross). */
export interface DealerNegotiationDetail {
  dealer_id: string;
  name: string | null;
  city: string | null;
  state: string | null;
  /** The dealer's public website URL (or null) — the modal footer link. */
  website: string | null;
  negotiation_status: NegotiationStatus | null;
  email_count: number;
  quote_sent: boolean;
  /** MIN competing OTD over OTHER dealers' quality quotes — NO competitor name. */
  best_competing_otd: number | null;
  /** max(0, currentOtd - bestCompetingOtd) — the scalar gap, or null. */
  batna_gap_usd: number | null;
  status_line: string;
  strategy: string;
  next_steps: string[];
  contacts: NegotiationContactRow[];
  replies: NegotiationReplyRow[];
}

/** Map a shared contact read to the modal row shape (id is a key only). */
function toContactRow(c: DealerContactRead): NegotiationContactRow {
  return {
    contact_id: c.contactId,
    display_name: c.displayName,
    email: c.email,
    role: c.role,
    is_primary_reply_target: c.isPrimaryReplyTarget === 1,
  };
}

/**
 * The per-DEALER negotiation detail for the modal: the dealer's contacts, its
 * substantive inbound replies (T2-filtered, budget-redacted, capped excerpt,
 * newest first), the competing-OTD scalars (NO competitor name), and the composed
 * status line / strategy / next-steps advisory. Returns null when the dealer is
 * not bound to the profile (the route answers 404). Read-only; every figure is
 * recomputed each read (no stored column).
 *
 * The advice is composed for the dealer's MOST-ACTIONABLE thread (lowest
 * NEGOTIATION_STATUS_RANK, newest-activity tie-break — the same reduction the grid
 * uses), so the modal mirrors the card's status chip.
 */
export function readDealerNegotiationDetail(
  db: Db,
  args: { profileId: string; dealerId: string; nowMs?: number },
): DealerNegotiationDetail | null {
  const nowMs = args.nowMs ?? Date.now();

  const dealer = db.$client
    .prepare(
      "SELECT d.name AS name, d.city AS city, d.state AS state, d.website AS website " +
        "FROM profile_dealers pd JOIN dealers d ON d.dealer_id = pd.dealer_id " +
        "WHERE pd.search_profile_id = ? AND pd.dealer_id = ?",
    )
    .get(args.profileId, args.dealerId) as
    | { name: string | null; city: string | null; state: string | null; website: string | null }
    | undefined;
  if (dealer === undefined) return null; // foreign dealer → 404

  const contacts = readDealerContacts(db, args.dealerId).map(toContactRow);

  const replies: NegotiationReplyRow[] = readSubstantiveInboundReplies(db, args).map((r) => ({
    message_id: r.messageId,
    sender_name: r.senderName,
    sender_email: r.senderEmail,
    subject: r.subject,
    body_excerpt: r.bodyText === null ? null : cap(redactBudget(r.bodyText), MODAL_REPLY_EXCERPT_MAX),
    received_at: r.receivedAt,
  }));

  // Both-directions message count (matches the grid's email_count).
  const emailRow = db.$client
    .prepare(
      "SELECT COUNT(*) AS cnt FROM messages m JOIN threads t ON t.thread_id = m.thread_id " +
        "WHERE m.search_profile_id = ? AND t.dealer_id = ?",
    )
    .get(args.profileId, args.dealerId) as { cnt: number };
  const emailCount = emailRow.cnt;

  // The give-up inputs (per-dealer): current/prior OTD, itemization, the symmetric
  // BATNA competing OTD. batna_gap_usd is the raw scalar gap per the contract.
  const inputs = readDealerGiveUpInputs(db, { profileId: args.profileId, dealerId: args.dealerId, nowMs });
  // The give_up_switch VERDICT uses the strict itemized-symmetric BATNA; the
  // TONE/display "at or below best" claim + the batna gap use the lowest REAL
  // competing OTD (a bottom-line competitor counts for the advisory but never for
  // a switch) — so a $49-above quote no longer reads "at or below best"
  // (PIC-20260629r2-4).
  const bestCompetingOtd = inputs.bestCompetingOtd;
  const bestCompetingRealOtd = inputs.bestCompetingRealOtd;
  const priorOtd = inputs.otdTrajectory[1] ?? null;
  const batnaGapUsd =
    inputs.currentOtd !== null && bestCompetingRealOtd !== null
      ? Math.max(0, inputs.currentOtd - bestCompetingRealOtd)
      : null;
  // The strict itemized gap drives ONLY the give_up_switch wording ("a fully
  // itemized competing quote is $X lower"); the tone/display use the real gap above.
  const itemizedBatnaGapUsd =
    inputs.currentOtd !== null && bestCompetingOtd !== null
      ? Math.max(0, inputs.currentOtd - bestCompetingOtd)
      : null;
  // quote_sent matches the grid (quoteAggByDealer): presence of ANY dealer_quotes
  // row for this dealer in this profile — so a quote row with a null otd_total
  // reads quote_sent on the card AND the modal consistently.
  const quoteRow = db.$client
    .prepare("SELECT COUNT(*) AS cnt FROM dealer_quotes WHERE search_profile_id = ? AND dealer_id = ?")
    .get(args.profileId, args.dealerId) as { cnt: number };
  const quoteSent = quoteRow.cnt > 0;

  // Reduce the dealer's threads to its MOST-ACTIONABLE one (status rank min, newest
  // activity tie-break) via the shared reduction, keeping that thread's gate/cap for
  // the advisory. No thread → the no-candidate gate/cap defaults + a null status.
  const winner = mostActionableThreadByDealer(db, args.profileId, {
    nowMs,
    dealerId: args.dealerId,
  }).get(args.dealerId);
  const repStatus: NegotiationStatus | null = winner?.status ?? null;
  const repGate =
    winner?.gate ?? gateDecisionForTarget(null, null, { maxGapDays: BATCH_SILENCE_WINDOW_DAYS, nowMs });
  const repCap = winner?.cap ?? followupCapDecision(0, 0);

  const tone = classifyQuoteSituation({
    isItemized: inputs.isItemized,
    bestCompetingOtd: bestCompetingRealOtd,
    currentOtd: inputs.currentOtd,
  });
  const giveUp = dealerGiveUpDecision({
    gate: repGate,
    cap: repCap,
    otdTrajectory: inputs.otdTrajectory,
    isItemized: inputs.isItemized,
    currentOtd: inputs.currentOtd,
    bestCompetingOtd,
  });

  const auditSuggestions = readDealerAuditSuggestions(db, args);

  const strategy = composeNegotiationStrategy({
    tone,
    verdict: giveUp.verdict,
    reason: giveUp.reason,
    batnaGapUsd,
    itemizedBatnaGapUsd,
    isItemized: inputs.isItemized,
  });
  const nextSteps = composeNextSteps({
    gate: repGate,
    cap: repCap,
    verdict: giveUp.verdict,
    hasQuote: quoteSent,
    auditSuggestions,
  });
  const statusLine = composeStatusLine({
    status: repStatus ?? "replied",
    emailCount,
    quoteSent,
    currentOtd: inputs.currentOtd,
    priorOtd,
    gate: repGate,
    batnaGapUsd,
  });

  return {
    dealer_id: args.dealerId,
    name: dealer.name,
    city: dealer.city,
    state: dealer.state,
    website: dealer.website,
    negotiation_status: repStatus,
    email_count: emailCount,
    quote_sent: quoteSent,
    best_competing_otd: bestCompetingRealOtd,
    batna_gap_usd: batnaGapUsd,
    status_line: statusLine,
    strategy,
    next_steps: nextSteps,
    contacts,
    replies,
  };
}

/**
 * The dealer's audit-finding suggestion strings (latest audit per quote, the same
 * correlated-latest join the quote-compare ranker uses), deduped in first-seen
 * order. Feeds composeNextSteps. Profile + dealer scoped, read-only.
 */
function readDealerAuditSuggestions(
  db: Db,
  args: { profileId: string; dealerId: string },
): string[] {
  const rows = db.$client
    .prepare(
      "SELECT qa.flags_json AS flagsJson FROM dealer_quotes q " +
        "LEFT JOIN quote_audits qa ON qa.audit_id = ( " +
        "  SELECT qa2.audit_id FROM quote_audits qa2 WHERE qa2.dealer_quote_id = q.quote_id " +
        "  ORDER BY qa2.audited_at DESC, qa2.audit_id DESC LIMIT 1 " +
        ") " +
        "WHERE q.search_profile_id = ? AND q.dealer_id = ? " +
        "ORDER BY q.quote_received_at DESC, q.quote_id",
    )
    .all(args.profileId, args.dealerId) as Array<{ flagsJson: unknown }>;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    for (const s of flagSuggestionsFromJson(r.flagsJson)) {
      if (!seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
  }
  return out;
}

/**
 * The dealer's substantive inbound reply BODIES for the T8 LLM summary: the SAME
 * T2-filtered set as the modal replies, each budget-redacted and capped at the
 * summary length (longer than the modal excerpt). Newest first. Read-only.
 */
export function readDealerSubstantiveReplyBodies(
  db: Db,
  args: { profileId: string; dealerId: string },
): string[] {
  return readSubstantiveInboundReplies(db, args)
    .map((r) => (r.bodyText === null ? null : cap(redactBudget(r.bodyText), SUMMARY_REPLY_BODY_MAX)))
    .filter((b): b is string => b !== null);
}
