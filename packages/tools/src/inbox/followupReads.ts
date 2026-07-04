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

import { toEpochMs } from "./time.js";

// ---------------------------------------------------------------------------
// the give-up verdict inputs — same-vehicle trajectory + symmetric BATNA
// ---------------------------------------------------------------------------

/** The give-up trajectory + competing reads only trust quotes whose extraction
 *  confidence clears this floor. A NULL confidence (unrecorded) PASSES — only an
 *  explicitly-low confidence is dropped — so a garbled re-extract cannot fake a
 *  concession, a re-trade, or a phantom competing lowball. Named constant, never
 *  env (owner anti-config bias). */
const DEALER_QUOTE_MIN_CONFIDENCE = 0.5;
/** How many recent SAME-vehicle quotes the concession trajectory reads (newest
 *  first); three gives the two consecutive pairs the non-improving check needs. */
const GIVEUP_TRAJECTORY_WINDOW = 3;
/** Confidence floor as a reusable SQL fragment (NULL-tolerant, see above). */
const CONFIDENCE_FLOOR_PREDICATE = "(confidence IS NULL OR confidence >= ?)";

/** The DB inputs the pure dealerGiveUpDecision consumes. */
export interface DealerGiveUpInputsRead {
  /** Recent OTDs for this dealer's CURRENT vehicle (vin, else source_listing_id),
   *  NEWEST first, confidence-floored. Length < 2 cannot show movement. */
  otdTrajectory: number[];
  /** Whether the current open quote is fully itemized. */
  isItemized: boolean;
  /** This dealer's current open OTD (raw), or null when not quoted. */
  currentOtd: number | null;
  /** Best competing OTD over OTHER dealers' open quotes that are ITEMIZED AND
   *  confidence-floored — the SYMMETRIC BATNA guard. null when no quality
   *  competitor exists, so a lone non-itemized lowball can never justify a switch.
   *  Drives the give_up_switch verdict ONLY. */
  bestCompetingOtd: number | null;
  /** Best competing REAL OTD over OTHER dealers' open same-mode quotes WITHOUT the
   *  itemization gate ($0/null excluded) — the lowest real competing number, for
   *  the TONE/display "at or below best" advisory. A bottom-line OTD counts here
   *  (it is a real competing number) but never triggers give_up_switch
   *  (PIC-20260629r2-4). null when no real competitor exists. */
  bestCompetingRealOtd: number | null;
}

/**
 * Read the give-up verdict's inputs for one dealer + profile. The adversarial-
 * review must-fixes live here:
 *   - the trajectory is scoped to the current quote's SAME vehicle (vin, else
 *     source_listing_id) AND its SAME financing_mode, so neither a cross-trim
 *     pair nor the cash/finance/lease siblings of ONE email (which share a vin and
 *     a received_at) ever read as a concession/stall; with no vehicle key it
 *     degrades to the single current OTD (no movement);
 *   - EVERY input is confidence-floored — the current quote too, so a garbled
 *     low-confidence newest row can never become the current OTD / vehicle key and
 *     skew the BATNA;
 *   - rows are ordered newest-first in JS (toEpochMs) because quote_received_at is
 *     ISO OR epoch-ms and no single SQL sort orders both, and the trajectory's
 *     direction (conceding vs re-trade) is load-bearing across rows;
 *   - the competing OTD only counts ITEMIZED, confidence-floored other-dealer
 *     quotes in the SAME financing_mode as the current quote (the symmetric guard),
 *     so neither a phantom lowball nor an off-mode (finance/lease) OTD that isn't
 *     comparable to a cash OTD can drive a switch.
 * OTD figures are RAW otd_total. Read-only.
 */
export function readDealerGiveUpInputs(
  db: Db,
  args: { profileId: string; dealerId: string; nowMs?: number },
): DealerGiveUpInputsRead {
  const nowMs = args.nowMs ?? Date.now();

  // Open-ness is evaluated in JS (toEpochMs), not a SQL CAST: quote_expires_at —
  // like quote_received_at — is ISO OR epoch-ms, so CAST(... AS INTEGER) would
  // mis-judge a FUTURE ISO expiry as already-expired.
  const isOpen = (expiresAt: string | number | null): boolean => {
    const ms = toEpochMs(expiresAt);
    return ms === null || ms > nowMs;
  };

  // All of this dealer's confidence-floored quotes (a garbled low-confidence row is
  // never trusted as the current quote nor in the trajectory). Open-ness + newest-
  // first ordering are done in JS: quote_received_at is ISO OR epoch-ms (the
  // schema's dual format), and neither a SQL CAST-to-INTEGER (collapses an ISO
  // string to its year) nor a string sort (breaks epoch-ms numbers) orders both.
  const rows = db.$client
    .prepare(
      "SELECT otd_total AS otd, selling_price AS selling, doc_fee AS doc, dealer_fee AS dealer, sales_tax AS tax, " +
        "vin, source_listing_id AS sli, financing_mode AS mode, quote_received_at AS receivedAt, " +
        "quote_expires_at AS expiresAt, quote_id AS quoteId " +
        "FROM dealer_quotes WHERE search_profile_id = ? AND dealer_id = ? AND " +
        CONFIDENCE_FLOOR_PREDICATE,
    )
    .all(args.profileId, args.dealerId, DEALER_QUOTE_MIN_CONFIDENCE) as Array<{
    otd: number | null;
    selling: number | null;
    doc: number | null;
    dealer: number | null;
    tax: number | null;
    vin: string | null;
    sli: string | null;
    mode: string | null;
    receivedAt: string | number | null;
    expiresAt: string | number | null;
    quoteId: string;
  }>;

  const sorted = rows
    .filter((r) => isOpen(r.expiresAt))
    .map((r) => ({ ...r, ms: toEpochMs(r.receivedAt) }))
    .sort((a, b) => {
      const am = a.ms ?? -Infinity;
      const bm = b.ms ?? -Infinity;
      if (am !== bm) return bm - am; // newest first
      return a.quoteId < b.quoteId ? 1 : a.quoteId > b.quoteId ? -1 : 0; // stable tiebreak
    });
  // Anchor "current" on the newest row with a REAL OTD: a no-number reply
  // (a hold/payment-only/come-onsite) normalizes to null at write, and `> 0` is
  // additionally robust to a pre-existing $0 row — so a dealer who declines to
  // re-quote keeps their last real OTD as the current quote (PIC-20260629r2-5).
  // Falls back to the newest row when the dealer has no real OTD at all.
  const current = sorted.find((r) => r.otd !== null && r.otd > 0) ?? sorted[0];

  const currentOtd = current?.otd ?? null;
  const isItemized =
    current !== undefined &&
    current.selling !== null &&
    (current.doc !== null || current.dealer !== null || current.tax !== null);

  // Same-vehicle (vin else sli) AND same-financing-mode trajectory, newest first,
  // capped at the window. The mode filter keeps the cash/finance/lease siblings of
  // ONE email (they share a vin + a received_at) out of the round-over-round
  // series. The window is coupled to dealerGiveUpDecision's fixed 3-quote / 2-pair
  // nonImproving check — keep GIVEUP_TRAJECTORY_WINDOW and that check in step.
  let otdTrajectory: number[] = [];
  if (current !== undefined && currentOtd !== null) {
    const hasVin = current.vin !== null && current.vin !== "";
    const hasSli = current.sli !== null && current.sli !== "";
    if (hasVin || hasSli) {
      otdTrajectory = sorted
        .filter(
          (r) =>
            r.otd !== null &&
            r.otd > 0 &&
            r.mode === current.mode &&
            (hasVin ? r.vin === current.vin : r.sli === current.sli),
        )
        .slice(0, GIVEUP_TRAJECTORY_WINDOW)
        .map((r) => r.otd!);
    } else {
      // No vehicle key — we can't prove two quotes are the same car, so the
      // trajectory is just the current OTD (no movement can be inferred).
      otdTrajectory = [currentOtd];
    }
  }

  // The symmetric BATNA: the cheapest OTHER-dealer open quote that is ITEMIZED,
  // confidence-floored, AND in the SAME financing_mode as the current quote — a
  // finance/lease OTD is a different payment structure, not comparable to a cash
  // OTD, so a cheaper off-mode quote must never fabricate a switch (the same
  // non-comparability the trajectory's mode filter closes, here on the cross-dealer
  // side that actually triggers give_up_switch). null when there is no current
  // quote to compare against, or no quality same-mode competitor.
  let bestCompetingOtd: number | null = null;
  // The TONE/display baseline: the lowest REAL same-mode other-dealer OTD WITHOUT
  // the give-up itemization gate. A bottom-line OTD (no full breakdown) is a
  // genuine competing number for the "at or below best" advisory, even though it
  // must never trigger give_up_switch (PIC-20260629r2-4). $0/null excluded so a
  // hold can't read as the best competitor.
  let bestCompetingRealOtd: number | null = null;
  if (current !== undefined) {
    const competingRows = db.$client
      .prepare(
        "SELECT otd_total AS otd, quote_expires_at AS expiresAt FROM dealer_quotes " +
          "WHERE search_profile_id = ? AND dealer_id != ? AND otd_total > 0 AND " +
          CONFIDENCE_FLOOR_PREDICATE +
          " AND financing_mode = ? AND selling_price IS NOT NULL " +
          "AND (doc_fee IS NOT NULL OR dealer_fee IS NOT NULL OR sales_tax IS NOT NULL)",
      )
      .all(args.profileId, args.dealerId, DEALER_QUOTE_MIN_CONFIDENCE, current.mode) as Array<{
      otd: number;
      expiresAt: string | number | null;
    }>;
    const openOtds = competingRows.filter((r) => isOpen(r.expiresAt)).map((r) => r.otd);
    bestCompetingOtd = openOtds.length > 0 ? Math.min(...openOtds) : null;

    const realRows = db.$client
      .prepare(
        "SELECT otd_total AS otd, quote_expires_at AS expiresAt FROM dealer_quotes " +
          "WHERE search_profile_id = ? AND dealer_id != ? AND otd_total > 0 AND " +
          CONFIDENCE_FLOOR_PREDICATE +
          " AND financing_mode = ?",
      )
      .all(args.profileId, args.dealerId, DEALER_QUOTE_MIN_CONFIDENCE, current.mode) as Array<{
      otd: number;
      expiresAt: string | number | null;
    }>;
    const realOpenOtds = realRows.filter((r) => isOpen(r.expiresAt)).map((r) => r.otd);
    bestCompetingRealOtd = realOpenOtds.length > 0 ? Math.min(...realOpenOtds) : null;
  }

  return { otdTrajectory, isItemized, currentOtd, bestCompetingOtd, bestCompetingRealOtd };
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
  /** The BACKEND Gmail thread id (threads.gmail_thread_id) — the send's
   *  requestBody.threadId that Gmail groups the sent copy by. NOT part of the
   *  reply double-flag. null on rows with no captured backend id → a plain
   *  top-level send. */
  gmailThreadId: string | null;
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
  /** The latest INBOUND message's rfc_message_id (RFC-2822 Message-ID) — the
   *  recipient-side reply-threading anchor emitted as In-Reply-To/References.
   *  null on legacy rows with no captured header (→ no threading headers). */
  latestInboundRfcMessageId: string | null;
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
    .prepare("SELECT subject, gmail_thread_id AS gmailThreadId FROM threads WHERE thread_id = ?")
    .get(threadId) as { subject: string | null; gmailThreadId: string | null } | undefined;

  const messageRows = db.$client
    .prepare(
      "SELECT direction, sender_name AS senderName, body_text AS bodyText, received_at AS receivedAt, gmail_message_id AS gmailMessageId, rfc_message_id AS rfcMessageId " +
        "FROM messages WHERE thread_id = ? " +
        "ORDER BY CAST(received_at AS INTEGER) ASC, message_id ASC",
    )
    .all(threadId) as Array<{
    direction: string;
    senderName: string | null;
    bodyText: string | null;
    receivedAt: string | number | null;
    gmailMessageId: string | null;
    rfcMessageId: string | null;
  }>;

  // The latest inbound gmail id = the last inbound row in ascending order that
  // carries a gmail_message_id. The latest inbound rfc id follows the SAME
  // last-inbound-wins loop (its own anchor; null on legacy rows).
  let latestInboundGmailMessageId: string | null = null;
  let latestInboundRfcMessageId: string | null = null;
  for (const m of messageRows) {
    if (m.direction === "inbound" && m.gmailMessageId !== null && m.gmailMessageId !== "") {
      latestInboundGmailMessageId = m.gmailMessageId;
    }
    if (m.direction === "inbound" && m.rfcMessageId !== null && m.rfcMessageId !== "") {
      latestInboundRfcMessageId = m.rfcMessageId;
    }
  }

  return {
    threadId,
    subject: thread?.subject ?? null,
    gmailThreadId: thread?.gmailThreadId ?? null,
    messages: messageRows.map((m) => ({
      direction: m.direction,
      senderName: m.senderName,
      bodyText: m.bodyText,
      receivedAtMs: toEpochMs(m.receivedAt),
    })),
    latestInboundGmailMessageId,
    latestInboundRfcMessageId,
  };
}

// ---------------------------------------------------------------------------
// the reply-target ladder inputs — the 4 rungs' rows for resolveReplyTarget
// ---------------------------------------------------------------------------

/** One dealer-scoped contact row (id is a key only; carries the role + the
 *  primary-reply-target flag). Shared by the reply-target ladder and the
 *  negotiation detail read — one SELECT, no near-duplicate. */
export interface DealerContactRead {
  contactId: string;
  email: string | null;
  displayName: string | null;
  role: string | null;
  isPrimaryReplyTarget: number | null;
}

/**
 * The dealer's contacts (id key + email + display name + role + the primary-
 * reply-target flag), dealer-scoped. The single contact SELECT both the reply-
 * target ladder (readReplyTargetInputs) and the negotiation detail read share.
 * Read-only.
 */
export function readDealerContacts(db: Db, dealerId: string): DealerContactRead[] {
  return db.$client
    .prepare(
      "SELECT contact_id AS contactId, email, display_name AS displayName, role, " +
        "is_primary_reply_target AS isPrimaryReplyTarget " +
        "FROM dealer_contacts WHERE dealer_id = ?",
    )
    .all(dealerId) as DealerContactRead[];
}

/** The already-fetched rows the 4-rung reply-target ladder considers, in the
 *  exact shape resolveReplyTarget's ReplyTargetInputs expects. */
export interface ReplyTargetInputsRead {
  contacts: DealerContactRead[];
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
  const contacts = readDealerContacts(db, args.dealerId);

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
