/**
 * hygiene writes — the THREE staged-action writers, each with a throwing typed
 * guard (defense in depth). They are called ONLY inside commitHygiene's single
 * transaction, so a thrown guard rolls back the WHOLE run (all-or-nothing).
 *
 * SOFT-DELETE over HARD-DELETE (load-bearing):
 *   - suppressContact / demoteCrmContact — SOFT: sets
 *     dealer_contacts.is_crm_platform_sender = 1. NEVER deletes a contact.
 *   - suppressThread — SUPPRESS: inserts ONE thread_suppression row
 *     (action 'cleanup', approved_by 'user') + flips the thread state. NEVER
 *     deletes the thread.
 *   - deleteOrphanThread — the ONE allowed HARD DELETE, and only after an
 *     internal SELECT re-confirms a TRUE orphan (zero messages + the
 *     gmail_thread_id is a real message-id). A non-orphan is a no-op (false).
 *
 * ORPHAN RED-LINE (load-bearing): deleteOrphanThread NEVER writes the orphan's
 * gmail_thread_id (which is actually a message-id) into thread_suppression. The
 * orphan path DELETEs; it does not suppress.
 *
 * TYPED GUARDS (throwing): suppressThread rejects any thread with an offers row
 * OR a current value-class intent {quote, pricing, qualification}; demoteCrmContact
 * rejects a contact owning any dealer_quote OR flagged primary reply target. The
 * throw (HygieneRejectedError) aborts commitHygiene's transaction.
 *
 * IDEMPOTENT: each writer is a no-op on a second application (deterministic
 * suppression_id PK conflict; the demote flag is already set; a deleted orphan
 * is gone).
 *
 * SQLITE INVARIANT: raw better-sqlite3 handle (db.$client) only — no drizzle-orm.
 *
 * Dependency wall: imports @autobroker/db (the Db handle type) + the pure
 * classifier only.
 */

import type { Db } from "@autobroker/db";

import { isValueIntent } from "./classify.js";

/** The typed rejection a write guard throws — carries a stable machine code.
 *  A throw inside commitHygiene rolls back the whole transaction. */
export class HygieneRejectedError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "HygieneRejectedError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 6a — delete an orphan thread (the ONE hard delete; orphan red-line honored)
// ---------------------------------------------------------------------------

const SELECT_THREAD_FOR_ORPHAN =
  "SELECT gmail_thread_id FROM threads WHERE thread_id = ?";
const COUNT_THREAD_MESSAGES =
  "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?";
const EXISTS_MESSAGE_ID =
  "SELECT 1 AS hit FROM messages WHERE gmail_message_id = ? LIMIT 1";
const DELETE_THREAD = "DELETE FROM threads WHERE thread_id = ?";

/**
 * Hard-DELETE a thread that an internal SELECT re-confirms is a TRUE orphan
 * (zero messages AND its gmail_thread_id is a real message-id). A non-orphan (or
 * an already-deleted row) is a no-op returning false. NEVER suppresses — the
 * orphan's gmail_thread_id (a message-id) is never written anywhere.
 */
export function deleteOrphanThread(db: Db, threadId: string): boolean {
  const c = db.$client;
  const thread = c.prepare(SELECT_THREAD_FOR_ORPHAN).get(threadId) as
    | { gmail_thread_id: string | null }
    | undefined;
  if (thread === undefined) return false; // already gone — no-op.
  const gmailThreadId = thread.gmail_thread_id;
  if (gmailThreadId === null || gmailThreadId === "") return false; // not an orphan shape.

  const msgs = c.prepare(COUNT_THREAD_MESSAGES).get(threadId) as { n: number };
  if (msgs.n > 0) return false; // has real messages — NOT an orphan, no-op.

  const isStrayMessageId =
    (c.prepare(EXISTS_MESSAGE_ID).get(gmailThreadId) as { hit: number } | undefined) !== undefined;
  if (!isStrayMessageId) return false; // the id is a real thread id — not an orphan.

  const info = c.prepare(DELETE_THREAD).run(threadId);
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// 6b — suppress a CRM-only thread (soft: a suppression row + state flag)
// ---------------------------------------------------------------------------

const SELECT_THREAD_FOR_SUPPRESS =
  "SELECT dealer_id, gmail_thread_id, state FROM threads WHERE thread_id = ?";
const EXISTS_OFFER_FOR_THREAD =
  "SELECT 1 AS hit FROM offers WHERE thread_id = ? LIMIT 1";
const SELECT_CURRENT_INTENTS_FOR_THREAD =
  "SELECT DISTINCT ma.intent AS intent FROM message_analysis ma " +
  "JOIN messages m ON m.message_id = ma.message_id " +
  "WHERE m.thread_id = ? AND ma.is_current = 1 AND ma.intent IS NOT NULL";
const INSERT_SUPPRESSION =
  "INSERT INTO thread_suppression " +
  "(suppression_id, thread_id, dealer_id, gmail_thread_id, scope, action, " +
  "reason, approved_by, approved_at, search_profile_id) " +
  "VALUES (?, ?, ?, ?, 'thread', 'cleanup', ?, 'user', ?, ?) " +
  "ON CONFLICT(suppression_id) DO NOTHING";
const UPDATE_THREAD_SUPPRESSED =
  "UPDATE threads SET state = 'suppressed' WHERE thread_id = ?";

/**
 * Suppress a CRM-only thread: one thread_suppression row (action 'cleanup',
 * approved_by 'user') + the thread state flipped to 'suppressed'. NEVER deletes.
 * Idempotent on the deterministic (thread_id, cleanup) suppression_id.
 *
 * GUARD (throws HygieneRejectedError): a thread with any offers row OR a current
 * value-class intent {quote, pricing, qualification} is rejected.
 */
export function suppressThread(db: Db, threadId: string, runId: string): boolean {
  const c = db.$client;
  const thread = c.prepare(SELECT_THREAD_FOR_SUPPRESS).get(threadId) as
    | { dealer_id: string; gmail_thread_id: string | null; state: string | null }
    | undefined;
  if (thread === undefined) return false; // gone — no-op.

  // Guard: an offer on this thread means it carries real value → reject.
  const hasOffer =
    (c.prepare(EXISTS_OFFER_FOR_THREAD).get(threadId) as { hit: number } | undefined) !== undefined;
  if (hasOffer) {
    throw new HygieneRejectedError(
      "thread_has_offer_or_quote_intent",
      `thread ${threadId} has an offer — never suppressed`,
    );
  }
  // Guard: a value-class current intent means it carries real value → reject.
  const intents = c.prepare(SELECT_CURRENT_INTENTS_FOR_THREAD).all(threadId) as Array<{
    intent: string;
  }>;
  if (intents.some((r) => isValueIntent(r.intent))) {
    throw new HygieneRejectedError(
      "thread_has_offer_or_quote_intent",
      `thread ${threadId} carries a quote-class intent — never suppressed`,
    );
  }

  const suppressionId = `hygiene:${threadId}:cleanup`;
  const info = c
    .prepare(INSERT_SUPPRESSION)
    .run(
      suppressionId,
      threadId,
      thread.dealer_id,
      thread.gmail_thread_id,
      `hygiene:${runId}`,
      new Date().toISOString(),
      null,
    );
  c.prepare(UPDATE_THREAD_SUPPRESSED).run(threadId);
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// 6c — demote a CRM platform contact (SOFT: flag only, never delete)
// ---------------------------------------------------------------------------

const SELECT_CONTACT_FOR_DEMOTE =
  "SELECT dealer_id, is_primary_reply_target, is_crm_platform_sender FROM dealer_contacts WHERE contact_id = ?";
const EXISTS_QUOTE_FOR_CONTACT =
  "SELECT 1 AS hit FROM dealer_quotes dq " +
  "JOIN messages m ON m.message_id = dq.message_id " +
  "WHERE m.contact_id = ? LIMIT 1";
const UPDATE_CONTACT_DEMOTE =
  "UPDATE dealer_contacts SET is_crm_platform_sender = 1 WHERE contact_id = ?";
// The demotion is recorded as a contact-scope cleanup suppression row so a
// re-run's detection excludes it (the flag column is both the detection signal
// and the flip target, so the suppression row is the idempotent gate). Keyed on
// a deterministic suppression_id → the PK conflict absorbs a re-demote.
const INSERT_CONTACT_SUPPRESSION =
  "INSERT INTO thread_suppression " +
  "(suppression_id, thread_id, contact_id, dealer_id, scope, action, " +
  "reason, approved_by, approved_at, search_profile_id) " +
  "VALUES (?, NULL, ?, ?, 'contact', 'cleanup', ?, 'user', ?, ?) " +
  "ON CONFLICT(suppression_id) DO NOTHING";

/**
 * SOFT-demote a CRM platform contact: set is_crm_platform_sender = 1. NEVER
 * deletes. Idempotent (the flag is already 1 on a re-run). Returns true when the
 * flag changed.
 *
 * GUARD (throws HygieneRejectedError): a contact owning any dealer_quote OR
 * flagged is_primary_reply_target is rejected.
 */
export function demoteCrmContact(db: Db, contactId: string, runId: string): boolean {
  const c = db.$client;
  const contact = c.prepare(SELECT_CONTACT_FOR_DEMOTE).get(contactId) as
    | { dealer_id: string; is_primary_reply_target: number | null; is_crm_platform_sender: number | null }
    | undefined;
  if (contact === undefined) return false; // gone — no-op.

  if ((contact.is_primary_reply_target ?? 0) === 1) {
    throw new HygieneRejectedError(
      "contact_is_primary_reply_target",
      `contact ${contactId} is the primary reply target — never demoted`,
    );
  }
  const ownsQuote =
    (c.prepare(EXISTS_QUOTE_FOR_CONTACT).get(contactId) as { hit: number } | undefined) !== undefined;
  if (ownsQuote) {
    throw new HygieneRejectedError(
      "contact_owns_quote",
      `contact ${contactId} owns a quote — never demoted`,
    );
  }

  c.prepare(UPDATE_CONTACT_DEMOTE).run(contactId);
  // Record the demotion as a contact-scope cleanup row (the idempotent gate).
  // dealer_id is read from the contact row (NOT NULL + FK) we already loaded.
  const info = c
    .prepare(INSERT_CONTACT_SUPPRESSION)
    .run(
      `hygiene:${contactId}:cleanup`,
      contactId,
      contact.dealer_id,
      `hygiene:${runId}`,
      new Date().toISOString(),
      null,
    );
  return info.changes > 0;
}

/** Alias for the demote writer under the spec's `suppressContact` name. */
export const suppressContact = demoteCrmContact;
