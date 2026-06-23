/**
 * followupReads — the profile-scoped DB reads the negotiation-follow-up workflow
 * feeds to its PURE deciders (selectNextReplyTargets / gateDecisionForTarget /
 * resolveReplyTarget / buildDraftContext / classifyQuoteSituation). Every
 * decision is a pure function over already-fetched rows; this module is the only
 * SQLite touch — the workflow never opens the product DB (the SQLite invariant).
 *
 * Read-only, raw better-sqlite3 (db.$client). Timestamps in the product schema
 * are stored as either ISO strings or epoch-ms numbers; the read layer parses
 * them to epoch-ms here so the pure timing gate sees plain numbers (mirrors the
 * readFirstLeadSubmitAtMs convention).
 *
 * Dependency wall: imports @autobroker/db (the Db handle type) only.
 */

import type { Db } from "@autobroker/db";

/** Parse a numeric|ISO-string timestamp column to epoch-ms, or null. Mirrors the
 *  readFirstLeadSubmitAtMs convention: a number passes through (finite check), an
 *  ISO string is Date.parse'd, empty/non-finite → null. */
function toEpochMs(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (raw.trim() === "") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// the quote situation — current vs best-competing OTD, itemization
// ---------------------------------------------------------------------------

/** The tone inputs for ONE thread's dealer (already classifyQuoteSituation-shaped). */
export interface QuoteSituationRead {
  /** Whether the current open quote is itemized (a real selling price AND at
   *  least one itemized fee column) — an estimate-only quote reads NOT itemized. */
  isItemized: boolean;
  /** The current dealer's latest open OTD, or null when not quoted. */
  currentOtd: number | null;
  /** MIN(otd_total) across OTHER dealers' open quotes for the same profile, or
   *  null when no competing open quote exists. */
  bestCompetingOtd: number | null;
}

/** "Open" = not yet expired (quote_expires_at null or in the future), evaluated
 *  in SQL with a passed nowMs so the read is deterministic under test. */
const OPEN_QUOTE_PREDICATE =
  "(quote_expires_at IS NULL OR CAST(quote_expires_at AS INTEGER) > ?)";

/**
 * Read the negotiation tone inputs for one thread's dealer:
 *   - current_otd = the latest open quote's otd_total for THIS dealer + profile
 *     (highest quote_received_at), with is_itemized = it has a real selling_price
 *     AND at least one itemized fee column (doc_fee / dealer_fee / sales_tax);
 *   - best_competing_otd = MIN(otd_total) across OTHER dealers' open quotes for
 *     the SAME profile.
 * Reads dealer_quotes (the comprehensive extracted quote with itemization), NOT
 * offers (which carries only an estimated OTD). Read-only, profile-scoped.
 */
export function readQuoteSituationForThread(
  db: Db,
  args: { profileId: string; dealerId: string; nowMs?: number },
): QuoteSituationRead {
  const nowMs = args.nowMs ?? Date.now();

  const current = db.$client
    .prepare(
      "SELECT otd_total AS otd, selling_price AS selling, doc_fee AS doc, dealer_fee AS dealer, sales_tax AS tax " +
        "FROM dealer_quotes " +
        "WHERE search_profile_id = ? AND dealer_id = ? AND " +
        OPEN_QUOTE_PREDICATE +
        " ORDER BY CAST(quote_received_at AS INTEGER) DESC, quote_id DESC LIMIT 1",
    )
    .get(args.profileId, args.dealerId, nowMs) as
    | { otd: number | null; selling: number | null; doc: number | null; dealer: number | null; tax: number | null }
    | undefined;

  const currentOtd = current?.otd ?? null;
  const isItemized =
    current !== undefined &&
    current.selling !== null &&
    (current.doc !== null || current.dealer !== null || current.tax !== null);

  const competing = db.$client
    .prepare(
      "SELECT MIN(otd_total) AS best " +
        "FROM dealer_quotes " +
        "WHERE search_profile_id = ? AND dealer_id != ? AND otd_total IS NOT NULL AND " +
        OPEN_QUOTE_PREDICATE,
    )
    .get(args.profileId, args.dealerId, nowMs) as { best: number | null };

  return { isItemized, currentOtd, bestCompetingOtd: competing.best ?? null };
}

// ---------------------------------------------------------------------------
// the candidate threads — needs-response rows for selectNextReplyTargets
// ---------------------------------------------------------------------------

/** One needs-response candidate thread row (already fetched; the pure ranker +
 *  timing gate decide over these). */
export interface FollowupCandidateThread {
  threadId: string;
  dealerId: string;
  dealerName: string | null;
  state: string;
  /** Latest INBOUND message timestamp (epoch ms), or null when never replied. */
  lastInboundAtMs: number | null;
  /** Latest OUTBOUND message timestamp (epoch ms), or null when never sent. */
  lastOutboundAtMs: number | null;
  /** Total follow-ups we have ever sent on this thread (the hard backstop ceiling
   *  is applied in code over this count). */
  roundsSent: number;
  /** Consecutive UNANSWERED follow-ups: outbound messages whose insertion order
   *  (rowid) is after the latest inbound reply — i.e. follow-ups the dealer has
   *  not yet answered. Resets to 0 the moment a dealer reply lands. The
   *  responsive-aware cap throttles THIS (anti-pester at a silent dealer) while
   *  leaving an actively-countering thread free to run deep. rowid (insertion
   *  order), NOT received_at, is the signal: outbound rows carry no received_at
   *  (they timestamp processed_at), and an append-only message log's insertion
   *  order is the authoritative conversational sequence. */
  unansweredFollowups: number;
}

/**
 * The needs-response threads for one profile, joined to their dealer name with
 * the latest inbound / latest outbound timestamps and the outbound (follow-up)
 * round count per thread. The pure deciders downstream do the ranking, the
 * timing gate, and the responsive follow-up cap; this read only assembles the rows. Read-only,
 * profile-scoped.
 */
export function listFollowupCandidateThreads(
  db: Db,
  profileId: string,
): FollowupCandidateThread[] {
  const rows = db.$client
    .prepare(
      "SELECT t.thread_id AS threadId, t.dealer_id AS dealerId, d.name AS dealerName, t.state AS state, " +
        "(SELECT MAX(m.received_at) FROM messages m WHERE m.thread_id = t.thread_id AND m.direction = 'inbound') AS lastInbound, " +
        "(SELECT MAX(m.received_at) FROM messages m WHERE m.thread_id = t.thread_id AND m.direction = 'outbound') AS lastOutbound, " +
        "(SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.thread_id AND m.direction = 'outbound') AS roundsSent, " +
        // Consecutive unanswered follow-ups = outbound rows whose rowid (insertion
        // order) is past the latest inbound rowid. rowid, not received_at: outbound
        // has no received_at, and insertion order is the authoritative thread
        // sequence (immune to inbound timestamps that may be backfilled out of band).
        // COALESCE(...,0) → with no inbound yet, every outbound counts as unanswered.
        "(SELECT COUNT(*) FROM messages mo WHERE mo.thread_id = t.thread_id AND mo.direction = 'outbound' " +
        "  AND mo.rowid > COALESCE((SELECT MAX(mi.rowid) FROM messages mi WHERE mi.thread_id = t.thread_id AND mi.direction = 'inbound'), 0)) AS unansweredFollowups " +
        "FROM threads t LEFT JOIN dealers d ON d.dealer_id = t.dealer_id " +
        "WHERE t.search_profile_id = ? " +
        "ORDER BY t.thread_id",
    )
    .all(profileId) as Array<{
    threadId: string;
    dealerId: string;
    dealerName: string | null;
    state: string;
    lastInbound: string | number | null;
    lastOutbound: string | number | null;
    roundsSent: number;
    unansweredFollowups: number;
  }>;

  return rows.map((r) => ({
    threadId: r.threadId,
    dealerId: r.dealerId,
    dealerName: r.dealerName,
    state: r.state,
    lastInboundAtMs: toEpochMs(r.lastInbound),
    lastOutboundAtMs: toEpochMs(r.lastOutbound),
    roundsSent: r.roundsSent,
    unansweredFollowups: r.unansweredFollowups,
  }));
}

// ---------------------------------------------------------------------------
// the thread snapshot — subject + message rows for buildDraftContext
// ---------------------------------------------------------------------------

/** A thread snapshot for the draft context + the reply double-flag anchor. */
export interface ThreadSnapshotRead {
  threadId: string;
  subject: string | null;
  /** Message rows, oldest first, in the shape buildDraftContext consumes. */
  messages: Array<{
    direction: string;
    senderName: string | null;
    bodyText: string | null;
    receivedAtMs: number | null;
  }>;
  /** The latest INBOUND message's gmail_message_id — the in_reply_to anchor the
   *  reply double-flag needs (threadId AND inReplyToGmailId both set). null when
   *  the dealer never replied with a gmail id. */
  latestInboundGmailMessageId: string | null;
}

/**
 * Read one thread's subject + ordered message rows (oldest first) plus the latest
 * inbound gmail_message_id. Feeds buildDraftContext (which redacts budget and
 * fences inbound dealer bodies) and supplies the reply double-flag anchor. The
 * thread's own search_profile_id is NOT re-checked here — the caller already
 * resolved the thread within the pinned profile. Read-only.
 */
export function readThreadSnapshotForDraft(db: Db, threadId: string): ThreadSnapshotRead {
  const thread = db.$client
    .prepare("SELECT subject FROM threads WHERE thread_id = ?")
    .get(threadId) as { subject: string | null } | undefined;

  const messageRows = db.$client
    .prepare(
      "SELECT direction, sender_name AS senderName, body_text AS bodyText, received_at AS receivedAt, gmail_message_id AS gmailMessageId " +
        "FROM messages WHERE thread_id = ? " +
        "ORDER BY CAST(received_at AS INTEGER) ASC, message_id ASC",
    )
    .all(threadId) as Array<{
    direction: string;
    senderName: string | null;
    bodyText: string | null;
    receivedAt: string | number | null;
    gmailMessageId: string | null;
  }>;

  // The latest inbound gmail id = the last inbound row in ascending order that
  // carries a gmail_message_id.
  let latestInboundGmailMessageId: string | null = null;
  for (const m of messageRows) {
    if (m.direction === "inbound" && m.gmailMessageId !== null && m.gmailMessageId !== "") {
      latestInboundGmailMessageId = m.gmailMessageId;
    }
  }

  return {
    threadId,
    subject: thread?.subject ?? null,
    messages: messageRows.map((m) => ({
      direction: m.direction,
      senderName: m.senderName,
      bodyText: m.bodyText,
      receivedAtMs: toEpochMs(m.receivedAt),
    })),
    latestInboundGmailMessageId,
  };
}

// ---------------------------------------------------------------------------
// the reply-target ladder inputs — the 4 rungs' rows for resolveReplyTarget
// ---------------------------------------------------------------------------

/** The already-fetched rows the 4-rung reply-target ladder considers, in the
 *  exact shape resolveReplyTarget's ReplyTargetInputs expects. */
export interface ReplyTargetInputsRead {
  contacts: Array<{
    contactId: string;
    email: string | null;
    displayName: string | null;
    role: string | null;
    isPrimaryReplyTarget: number | null;
  }>;
  inboundMessages: Array<{
    contactId: string | null;
    senderEmail: string | null;
    receivedAtMs: number | null;
    messageId: string;
  }>;
  leadSubmissions: Array<{ submissionId: string; submittedEmail: string | null }>;
  dealer: { contactEmail: string | null };
}

/**
 * Read the four reply-target ladder rungs for one dealer + thread + profile:
 *   1. the dealer's contacts (with the primary-reply-target flag);
 *   2. this thread's inbound messages (the latest-inbound contact rung);
 *   3. the profile's lead submissions for this dealer (the submitted-email rung);
 *   4. the dealer's contact email (the final fallback rung).
 * Hand the result straight to resolveReplyTarget. Read-only, scoped.
 */
export function readReplyTargetInputs(
  db: Db,
  args: { profileId: string; dealerId: string; threadId: string },
): ReplyTargetInputsRead {
  const contacts = db.$client
    .prepare(
      "SELECT contact_id AS contactId, email, display_name AS displayName, role, " +
        "is_primary_reply_target AS isPrimaryReplyTarget " +
        "FROM dealer_contacts WHERE dealer_id = ?",
    )
    .all(args.dealerId) as ReplyTargetInputsRead["contacts"];

  const inboundRows = db.$client
    .prepare(
      "SELECT contact_id AS contactId, sender_email AS senderEmail, received_at AS receivedAt, message_id AS messageId " +
        "FROM messages WHERE thread_id = ? AND direction = 'inbound'",
    )
    .all(args.threadId) as Array<{
    contactId: string | null;
    senderEmail: string | null;
    receivedAt: string | number | null;
    messageId: string;
  }>;

  const leadSubmissions = db.$client
    .prepare(
      "SELECT submission_id AS submissionId, submitted_email AS submittedEmail " +
        "FROM lead_submissions WHERE dealer_id = ? AND search_profile_id = ?",
    )
    .all(args.dealerId, args.profileId) as ReplyTargetInputsRead["leadSubmissions"];

  const dealer = db.$client
    .prepare("SELECT contact_email AS contactEmail FROM dealers WHERE dealer_id = ?")
    .get(args.dealerId) as { contactEmail: string | null } | undefined;

  return {
    contacts,
    inboundMessages: inboundRows.map((m) => ({
      contactId: m.contactId,
      senderEmail: m.senderEmail,
      receivedAtMs: toEpochMs(m.receivedAt),
      messageId: m.messageId,
    })),
    leadSubmissions,
    dealer: { contactEmail: dealer?.contactEmail ?? null },
  };
}
