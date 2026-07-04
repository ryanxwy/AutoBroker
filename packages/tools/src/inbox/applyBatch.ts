/**
 * applyInboxBatch — THE ONE atomic write of the dealer-inbox sweep. Everything
 * the user approved (and everything they rejected) lands in a SINGLE
 * db.$client.transaction: a mid-write failure rolls the whole batch back, so the
 * product DB never holds a half-ingested sweep.
 *
 * THE ORPHAN-ROW FIX (load-bearing): `searchProfileId` is a REQUIRED, NON-NULL
 * parameter. Every ingested `messages` row is stamped with it. The legacy bug
 * was a missing profile id that let the insert "succeed" while the reply stayed
 * invisible to every profile-scoped view (an orphan). The type system now
 * forbids that — there is no code path that writes an inbox message without a
 * profile id.
 *
 * APPROVE (per accepted thread): upsert the `threads` row, upsert the sender's
 *   `dealer_contacts` row, insert each inbound `messages` row (direction
 *   'inbound', quote_extraction_status 'pending' so the extractor later picks it
 *   up, search_profile_id = the NON-NULL param), and write the `thread_routing`
 *   binding (boundBy 'user'). Dedup is on `messages.gmail_message_id` — a
 *   re-sweep that re-sees the same message inserts nothing (the whole apply is a
 *   no-op on re-run).
 *
 * REJECT (per rejected thread): insert exactly ONE `thread_suppression` row
 *   (scope 'thread', action 'suppress', approved_by 'user') — NO message row,
 *   NO thread row. Idempotent on (thread_id, action).
 *
 * SQLITE INVARIANT: raw better-sqlite3 handle only — no drizzle-orm.
 *
 * Dependency wall: imports @autobroker/db (getDb + the Db type) only.
 */

import { getDb, type Db } from "@autobroker/db";

/** One inbound message to ingest under an approved thread. */
export interface InboxMessageInput {
  /** Stable product message id (the ingest key; deterministic upstream). */
  messageId: string;
  /** The backend message id — the dedup key (a re-seen message is a no-op). */
  gmailMessageId: string;
  /** The inbound RFC-2822 Message-ID header (null when the mail carried none) —
   *  the recipient-side reply-threading anchor persisted for later sends. */
  rfcMessageId: string | null;
  sender: string;
  senderEmail: string;
  senderName: string | null;
  recipient: string | null;
  subject: string | null;
  bodyText: string | null;
  /** ISO receive timestamp (the backend's authoritative receive time). */
  receivedAt: string | null;
}

/** One thread decision — the dealer it routed to + its inbound messages. The
 *  same shape carries an APPROVE (messages ingested) and a REJECT (one
 *  suppression row; messages ignored). dealerId is non-null: an unrouted thread
 *  is never an apply target. */
export interface ThreadDecision {
  threadId: string;
  /** The backend thread id (stamped on threads + suppression for traceability). */
  gmailThreadId: string | null;
  dealerId: string;
  /** The dealer-contact display name for the sender (null when unknown). */
  contactDisplayName: string | null;
  /** The parsed dealer-contact role from the reply signature (null when none).
   *  COALESCE-kept on conflict — a later null never overwrites a known role. */
  contactRole: string | null;
  contactId: string;
  normalizedSenderEmail: string;
  isCrmPlatformSender: boolean;
  subject: string | null;
  classification: string;
  messages: readonly InboxMessageInput[];
}

export interface ApplyInboxBatchArgs {
  /** The NON-NULL profile every ingested row is stamped with (the orphan fix). */
  searchProfileId: string;
  /** The run id — recorded in the suppression reason for the audit trail. */
  runId: string;
  approve: readonly ThreadDecision[];
  reject: readonly ThreadDecision[];
  db?: Db;
}

export interface ApplyInboxBatchResult {
  newThreads: number;
  newMessages: number;
  newContacts: number;
  rejected: number;
}

const UPSERT_THREAD =
  "INSERT INTO threads (thread_id, dealer_id, gmail_thread_id, channel, subject, state, search_profile_id) " +
  "VALUES (?, ?, ?, 'email', ?, ?, ?) " +
  "ON CONFLICT(thread_id) DO UPDATE SET " +
  "gmail_thread_id = excluded.gmail_thread_id, subject = excluded.subject, " +
  "state = excluded.state, search_profile_id = excluded.search_profile_id";

const UPSERT_CONTACT =
  "INSERT INTO dealer_contacts " +
  "(contact_id, dealer_id, email, display_name, normalized_email, last_seen_at, " +
  "is_crm_platform_sender, role, search_profile_id) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(dealer_id, normalized_email) DO UPDATE SET " +
  "display_name = COALESCE(excluded.display_name, dealer_contacts.display_name), " +
  "last_seen_at = excluded.last_seen_at, " +
  "is_crm_platform_sender = excluded.is_crm_platform_sender, " +
  "role = COALESCE(excluded.role, dealer_contacts.role)";

// gmail_message_id is the dedup key — ON CONFLICT on the message PK absorbs a
// re-ingest of the same product id, and the pre-insert existence check on
// gmail_message_id absorbs a re-sweep that minted a different product id for the
// same backend message.
const SELECT_MESSAGE_BY_GMAIL_ID =
  "SELECT message_id FROM messages WHERE gmail_message_id = ? LIMIT 1";
const INSERT_MESSAGE =
  "INSERT INTO messages " +
  "(message_id, thread_id, gmail_message_id, rfc_message_id, direction, sender, recipient, subject, " +
  "body_text, received_at, contact_id, sender_email, sender_name, search_profile_id, " +
  "quote_extraction_status) " +
  "VALUES (?, ?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending') " +
  "ON CONFLICT(message_id) DO NOTHING";

const UPSERT_ROUTING =
  "INSERT INTO thread_routing (thread_id, search_profile_id, bound_at, bound_by) " +
  "VALUES (?, ?, ?, 'user') " +
  "ON CONFLICT(thread_id) DO UPDATE SET " +
  "search_profile_id = excluded.search_profile_id, bound_at = excluded.bound_at";

// Idempotent on (thread_id, action): a re-sweep that re-rejects the same thread
// writes nothing new. suppression_id is deterministic per (thread, action) so
// the PK conflict absorbs the re-run.
const INSERT_SUPPRESSION =
  "INSERT INTO thread_suppression " +
  "(suppression_id, thread_id, dealer_id, gmail_thread_id, scope, action, " +
  "classification, reason, approved_by, approved_at, search_profile_id) " +
  "VALUES (?, ?, ?, ?, 'thread', 'suppress', ?, ?, 'user', ?, ?) " +
  "ON CONFLICT(suppression_id) DO NOTHING";

/** Apply the approved + rejected thread decisions in ONE transaction. */
export function applyInboxBatch(args: ApplyInboxBatchArgs): ApplyInboxBatchResult {
  const db = args.db ?? getDb();
  const c = db.$client;
  const profileId = args.searchProfileId;
  const now = new Date().toISOString();

  const upsertThread = c.prepare(UPSERT_THREAD);
  const upsertContact = c.prepare(UPSERT_CONTACT);
  const selectMsg = c.prepare(SELECT_MESSAGE_BY_GMAIL_ID);
  const insertMsg = c.prepare(INSERT_MESSAGE);
  const upsertRouting = c.prepare(UPSERT_ROUTING);
  const insertSuppression = c.prepare(INSERT_SUPPRESSION);

  const txn = c.transaction((): ApplyInboxBatchResult => {
    let newThreads = 0;
    let newMessages = 0;
    let newContacts = 0;
    let rejected = 0;

    for (const d of args.approve) {
      const threadInfo = upsertThread.run(
        d.threadId,
        d.dealerId,
        d.gmailThreadId,
        d.subject,
        d.classification,
        profileId,
      );
      if (threadInfo.changes > 0) newThreads += 1;

      upsertContact.run(
        d.contactId,
        d.dealerId,
        d.normalizedSenderEmail,
        d.contactDisplayName,
        d.normalizedSenderEmail,
        now,
        d.isCrmPlatformSender ? 1 : 0,
        d.contactRole,
        profileId,
      );

      for (const m of d.messages) {
        const existing = selectMsg.get(m.gmailMessageId) as { message_id: string } | undefined;
        if (existing !== undefined) continue; // already ingested — dedup no-op.
        const info = insertMsg.run(
          m.messageId,
          d.threadId,
          m.gmailMessageId,
          m.rfcMessageId,
          m.sender,
          m.recipient,
          m.subject,
          m.bodyText,
          m.receivedAt,
          d.contactId,
          m.senderEmail,
          m.senderName,
          profileId,
        );
        if (info.changes > 0) newMessages += 1;
      }

      upsertRouting.run(d.threadId, profileId, now);
    }

    // newContacts is the count of distinct dealer contacts the approve set
    // touched (one per approved dealer-group). Deterministic and stable.
    newContacts = new Set(args.approve.map((d) => d.contactId)).size;

    for (const d of args.reject) {
      // A rejected thread is NOT ingested, so there is no `threads` row to
      // reference — the suppression's thread_id stays NULL and identity rides
      // gmail_thread_id (the deterministic suppression_id keys the idempotent
      // re-reject). This avoids a dangling thread_id FK into a row that was
      // deliberately never written.
      const suppressionId = `inbox_sweep:${d.gmailThreadId ?? d.threadId}:suppress`;
      const info = insertSuppression.run(
        suppressionId,
        null,
        d.dealerId,
        d.gmailThreadId,
        d.classification,
        `inbox_sweep:${args.runId}`,
        now,
        profileId,
      );
      if (info.changes > 0) rejected += 1;
    }

    return { newThreads, newMessages, newContacts, rejected };
  });

  return txn();
}
