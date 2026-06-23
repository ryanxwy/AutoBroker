/**
 * replyTargets — the deterministic reply routing for a negotiation follow-up:
 *   - which dealer threads to reply to next (recency rank over inbound),
 *   - whether a given thread is due (the timing gate),
 *   - who on a dealer's side to address (the 4-level reply-target ladder),
 *   - and a budget-safe, untrusted-input-fenced snapshot of a thread to hand a
 *     drafting step.
 *
 * Every function here is PURE: it takes already-fetched rows and returns a
 * decision. No DB handle, no network — the queries that fetch these rows live in
 * the inbox/reads layer; this module only decides.
 */

import { redactBudget } from "../gmail.js";

import { wrapUntrustedDealerInput } from "./constants.js";

// ---------------------------------------------------------------------------
// next reply targets — INBOUND-recency rank
// ---------------------------------------------------------------------------

/** A candidate dealer thread to potentially reply to. */
export interface ReplyCandidateThread {
  threadId: string;
  /** The most recent INBOUND timestamp (epoch ms), or null when the dealer has
   *  never replied. */
  lastInboundAtMs: number | null;
  /** Negotiation state — `agreed`/`closed` threads are never re-contacted. */
  state: string;
}

/**
 * Rank the threads to reply to next, most-recently-heard-from first.
 *   - threads in an agreed/closed state are excluded outright;
 *   - a thread with no inbound (null) sorts last;
 *   - ties on inbound recency break by `threadId` ascending (stable, so the
 *     same input always yields the same order).
 */
export function selectNextReplyTargets(
  threads: readonly ReplyCandidateThread[],
): ReplyCandidateThread[] {
  return threads
    .filter((t) => t.state !== "agreed" && t.state !== "closed")
    .slice()
    .sort((a, b) => {
      const aMs = a.lastInboundAtMs ?? -Infinity;
      const bMs = b.lastInboundAtMs ?? -Infinity;
      if (aMs !== bMs) return bMs - aMs;
      return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;
    });
}

// ---------------------------------------------------------------------------
// the timing gate
// ---------------------------------------------------------------------------

/** Whether a thread is due for a follow-up, given when we last heard / spoke. */
export type GateDecision = "skip" | "wait" | "ready";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The timing gate (defaults: min 24h between our sends, max 14d since the
 * dealer's last reply):
 *   - skip — the dealer last replied more than `maxGapDays` ago (the thread has
 *     gone cold; do not keep poking it).
 *   - wait — we sent something less than `minGapHours` ago (too soon to follow
 *     up again).
 *   - ready — neither condition fires.
 */
export function gateDecisionForTarget(
  lastInboundAtMs: number | null,
  lastOutboundAtMs: number | null,
  opts: { minGapHours?: number; maxGapDays?: number; nowMs?: number } = {},
): GateDecision {
  const minGapHours = opts.minGapHours ?? 24;
  const maxGapDays = opts.maxGapDays ?? 14;
  const now = opts.nowMs ?? Date.now();

  if (lastInboundAtMs !== null && now - lastInboundAtMs > maxGapDays * DAY_MS) {
    return "skip";
  }
  if (lastOutboundAtMs !== null && now - lastOutboundAtMs < minGapHours * HOUR_MS) {
    return "wait";
  }
  return "ready";
}

// ---------------------------------------------------------------------------
// the responsive-aware follow-up cap
// ---------------------------------------------------------------------------

/**
 * Max CONSECUTIVE UNANSWERED buyer follow-ups before a silent thread is held off
 * (anti-pester). Two = one substantive reply plus one nudge at a dealer who has
 * gone quiet; a third unanswered poke is suppressed. A dealer reply resets the
 * unanswered count to 0, so this never throttles an actively-countering thread.
 */
export const MAX_UNANSWERED_FOLLOWUPS = 2;

/**
 * Hard backstop ceiling on TOTAL follow-ups ever sent on one thread, regardless
 * of how responsive the dealer is. Well above a realistic deep email negotiation
 * (~4-8 buyer turns); a runaway-loop guard, not the normal limiter.
 */
export const MAX_TOTAL_FOLLOWUPS = 10;

/** Why a follow-up was (not) allowed on a thread. */
export type FollowupCapDecision = "ok" | "unanswered_cap" | "total_cap";

/**
 * The responsive-aware follow-up cap. Supersedes the old flat 3-round cap
 * (owner-directed, 2026-06-22): a real OTD negotiation is a MUTUAL back-and-forth,
 * so a buyer responding to a dealer who keeps countering is normal — not pestering.
 * Only consecutive UNANSWERED follow-ups (the dealer has not replied since our last
 * send) are throttled; a dealer reply resets that count and the thread runs deep.
 * The total ceiling is a runaway backstop. Pure: takes already-fetched counts.
 *   - total_cap     — total follow-ups hit the hard backstop (checked first).
 *   - unanswered_cap — too many consecutive un-replied-to follow-ups (silent dealer).
 *   - ok            — under both limits; send.
 */
export function followupCapDecision(
  unansweredFollowups: number,
  totalFollowups: number,
  opts: { maxUnanswered?: number; maxTotal?: number } = {},
): FollowupCapDecision {
  const maxUnanswered = opts.maxUnanswered ?? MAX_UNANSWERED_FOLLOWUPS;
  const maxTotal = opts.maxTotal ?? MAX_TOTAL_FOLLOWUPS;
  if (totalFollowups >= maxTotal) return "total_cap";
  if (unansweredFollowups >= maxUnanswered) return "unanswered_cap";
  return "ok";
}

// ---------------------------------------------------------------------------
// the 4-level reply-target ladder
// ---------------------------------------------------------------------------

/** Where a resolved reply target came from. */
export type ReplyTargetSource =
  | "primary_reply_target"
  | "latest_inbound_contact"
  | "lead_submission_email"
  | "dealer_contact_email";

/** The resolved address to reply to, plus its provenance. */
export interface ReplyTarget {
  email: string;
  source: ReplyTargetSource;
  contactId: string | null;
  displayName: string | null;
  role: string | null;
}

/** A dealer contact row (already fetched). */
export interface ContactRow {
  contactId: string;
  email: string | null;
  displayName: string | null;
  role: string | null;
  isPrimaryReplyTarget: number | null;
}

/** An inbound message row (already fetched), used as the second ladder rung. */
export interface InboundMessageRow {
  contactId: string | null;
  senderEmail: string | null;
  receivedAtMs: number | null;
  messageId: string;
}

/** A lead-submission row (already fetched), the third ladder rung. */
export interface LeadSubmissionRow {
  submissionId: string;
  submittedEmail: string | null;
}

/** The dealer row, the final fallback rung. */
export interface DealerRow {
  contactEmail: string | null;
}

/** All already-fetched rows the ladder considers. */
export interface ReplyTargetInputs {
  contacts: readonly ContactRow[];
  inboundMessages: readonly InboundMessageRow[];
  leadSubmissions: readonly LeadSubmissionRow[];
  dealer: DealerRow;
}

/**
 * Resolve who to address on a dealer's side, walking four rungs in order and
 * returning the first that yields an address:
 *   1. a contact explicitly flagged as the primary reply target (lowest
 *      contactId on a tie);
 *   2. the contact on the latest inbound message that carries a contact;
 *   3. the latest lead-submission's submitted email;
 *   4. the dealer's contact email.
 * Returns null only when no rung yields anything.
 */
export function resolveReplyTarget(inputs: ReplyTargetInputs): ReplyTarget | null {
  // 1. primary reply target — first by contactId ascending.
  const primaries = inputs.contacts
    .filter((c) => (c.isPrimaryReplyTarget ?? 0) === 1 && nonEmpty(c.email))
    .slice()
    .sort((a, b) => (a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0));
  if (primaries.length > 0) {
    const c = primaries[0]!;
    return {
      email: c.email!,
      source: "primary_reply_target",
      contactId: c.contactId,
      displayName: c.displayName,
      role: c.role,
    };
  }

  // 2. latest inbound message that carries a contact id — newest first, then
  //    messageId descending as a stable tie-break.
  const withContact = inputs.inboundMessages
    .filter((m) => m.contactId !== null)
    .slice()
    .sort((a, b) => {
      const aMs = a.receivedAtMs ?? -Infinity;
      const bMs = b.receivedAtMs ?? -Infinity;
      if (aMs !== bMs) return bMs - aMs;
      return a.messageId < b.messageId ? 1 : a.messageId > b.messageId ? -1 : 0;
    });
  for (const m of withContact) {
    const contact = inputs.contacts.find((c) => c.contactId === m.contactId);
    const email = contact?.email ?? m.senderEmail;
    if (nonEmpty(email)) {
      return {
        email: email!,
        source: "latest_inbound_contact",
        contactId: m.contactId,
        displayName: contact?.displayName ?? null,
        role: contact?.role ?? null,
      };
    }
  }

  // 3. latest lead-submission email — latest row (highest submissionId).
  const subs = inputs.leadSubmissions
    .filter((s) => nonEmpty(s.submittedEmail))
    .slice()
    .sort((a, b) => (a.submissionId < b.submissionId ? 1 : a.submissionId > b.submissionId ? -1 : 0));
  if (subs.length > 0) {
    return {
      email: subs[0]!.submittedEmail!,
      source: "lead_submission_email",
      contactId: null,
      displayName: null,
      role: null,
    };
  }

  // 4. dealer contact email fallback.
  if (nonEmpty(inputs.dealer.contactEmail)) {
    return {
      email: inputs.dealer.contactEmail!,
      source: "dealer_contact_email",
      contactId: null,
      displayName: null,
      role: null,
    };
  }

  return null;
}

function nonEmpty(s: string | null | undefined): boolean {
  return typeof s === "string" && s.trim() !== "";
}

// ---------------------------------------------------------------------------
// draft context + thread reuse
// ---------------------------------------------------------------------------

/** One message in a thread, for the draft snapshot. */
export interface ThreadMessageRow {
  direction: string;
  senderName: string | null;
  bodyText: string | null;
  receivedAtMs: number | null;
}

/** A thread plus its messages, the input to `buildDraftContext`. */
export interface ThreadSnapshotInput {
  threadId: string;
  subject: string | null;
  messages: readonly ThreadMessageRow[];
}

/** One redacted, fenced message line in a draft snapshot. */
export interface DraftContextMessage {
  direction: string;
  senderName: string | null;
  /** Budget-redacted, untrusted-fenced body. Inbound dealer text is wrapped so
   *  a drafting step treats it as quoted data, never instructions. */
  body: string;
}

/** A model-safe snapshot of a thread: budget redacted everywhere, and every
 *  inbound (dealer-authored) body wrapped in untrusted fences. */
export interface DraftContext {
  threadId: string;
  subject: string;
  messages: DraftContextMessage[];
}

/**
 * Build a draft snapshot of a thread that is safe to hand to a drafting step:
 * every body is budget-redacted, and inbound dealer bodies are wrapped in
 * untrusted fences so their content can never be read as an instruction.
 */
export function buildDraftContext(thread: ThreadSnapshotInput): DraftContext {
  return {
    threadId: thread.threadId,
    subject: redactBudget(thread.subject ?? ""),
    messages: thread.messages.map((m) => {
      const redacted = redactBudget(m.bodyText ?? "");
      const body = m.direction === "inbound" ? wrapUntrustedDealerInput(redacted) : redacted;
      return { direction: m.direction, senderName: m.senderName, body };
    }),
  };
}

/** A negotiation follow-up always replies in the existing Gmail thread — it
 *  never starts a new one. This is the explicit passthrough that records that
 *  invariant at the call site. */
export function reuseThreadIdForReply(threadId: string): string {
  return threadId;
}
