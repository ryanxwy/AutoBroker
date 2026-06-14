/**
 * fakeSeed — deterministic INBOUND-corpus row builder for the fake mailbox.
 *
 * The FakeGmailAdapter's only write is `send()`, which stores OUTBOUND rows. To
 * stage a deterministic dealer-reply corpus (the inbound side every read path
 * and the sync engine consume) there is no consumer-facing write — so this is
 * it. A pure tools-layer helper: it inserts inbound (and optional outbound) rows
 * into the four fake_mailbox_* tables through the raw better-sqlite3 handle, the
 * same seam the adapter uses. Keeping it in the tools layer honors the SQLite
 * invariant (only this layer touches the DB) and lets both the harness fixture
 * and the email-skill unit tests seed the same way.
 *
 * The stored `raw` is a base64url RFC-2822 blob the FakeGmailAdapter decodes
 * back to recover To/From/Subject + body (it splits on the first blank line).
 * The assembly here is a tiny local helper — it deliberately does NOT route
 * through the outbound send seam's budget redactor/asserter: that wall guards
 * user-authored OUTBOUND sends, whereas inbound corpus is dealer prose that must
 * be stored verbatim.
 *
 * INVARIANT: internalDateMs must be strictly increasing across the inserted
 * batch — the monotonic clock the watermark (getCurrentHistoryId, sync) trusts.
 * A tie or regression throws loud rather than corrupt the ordering.
 */

import { getDb, type Db } from "@autobroker/db";

import type { MessageDirection } from "./types.js";

export interface FakeMailboxSeedAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  /** Decoded bytes as base64; `size` is derived from the decoded length. */
  dataBase64: string;
}

export interface FakeMailboxSeedMessage {
  messageId: string;
  direction: MessageDirection;
  from: string;
  to: string;
  subject: string | null;
  bodyText: string;
  /** Caller-assigned receive clock; the helper asserts strictly increasing
   *  across the whole batch (every message of every thread, in array order). */
  internalDateMs: number;
  attachments?: readonly FakeMailboxSeedAttachment[];
}

export interface FakeMailboxSeedThread {
  threadId: string;
  subject: string | null;
  searchProfileId: string | null;
  messages: readonly FakeMailboxSeedMessage[];
}

export interface SeedFakeMailboxResult {
  threads: number;
  messages: number;
  attachments: number;
}

const INSERT_THREAD =
  "INSERT INTO fake_mailbox_threads (thread_id, subject, search_profile_id) VALUES (?, ?, ?) " +
  "ON CONFLICT(thread_id) DO NOTHING";

// `to` and `from` are SQLite reserved words — backtick-quote them, matching the
// adapter's write so the column order is byte-identical.
const INSERT_MESSAGE =
  "INSERT INTO fake_mailbox_messages " +
  "(message_id, thread_id, raw, `to`, `from`, subject, internal_date_ms, direction, is_delivered, search_profile_id) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?) " +
  "ON CONFLICT(message_id) DO NOTHING";

const INSERT_ATTACHMENT =
  "INSERT INTO fake_mailbox_attachments " +
  "(attachment_id, message_id, filename, mime_type, size, data_base64) " +
  "VALUES (?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(attachment_id) DO NOTHING";

/** Assemble the simple base64url RFC-2822 blob the FakeGmailAdapter decodes:
 *  unfolded top-level To/From/Subject headers, a blank line, then the body. */
function buildRfc2822Local(
  to: string,
  from: string,
  subject: string | null,
  bodyText: string,
): string {
  const rfc2822 =
    `To: ${to}\r\n` +
    `From: ${from}\r\n` +
    `Subject: ${subject ?? ""}\r\n` +
    `\r\n` +
    bodyText;
  return Buffer.from(rfc2822, "utf8").toString("base64url");
}

/**
 * Insert a deterministic inbound (+ optional outbound) fake-mailbox corpus.
 * Idempotent: every INSERT is ON CONFLICT DO NOTHING, so a re-run with the same
 * ids is a no-op (re-running still returns the attempted counts).
 */
export function seedFakeMailbox(opts: {
  threads: readonly FakeMailboxSeedThread[];
  db?: Db;
}): SeedFakeMailboxResult {
  const db = opts.db ?? getDb();
  const c = db.$client;

  // The strictly-increasing watermark check spans the WHOLE batch (every
  // message of every thread, in array order) — assert BEFORE any write so a bad
  // batch never leaves a partial corpus behind.
  let prev: number | null = null;
  for (const thread of opts.threads) {
    for (const msg of thread.messages) {
      if (prev !== null && msg.internalDateMs <= prev) {
        throw new Error(
          `seedFakeMailbox: internalDateMs must be strictly increasing across the batch ` +
            `(message ${msg.messageId} has ${msg.internalDateMs}, not > ${prev})`,
        );
      }
      prev = msg.internalDateMs;
    }
  }

  const insertThread = c.prepare(INSERT_THREAD);
  const insertMessage = c.prepare(INSERT_MESSAGE);
  const insertAttachment = c.prepare(INSERT_ATTACHMENT);

  let threads = 0;
  let messages = 0;
  let attachments = 0;

  const txn = c.transaction(() => {
    for (const thread of opts.threads) {
      insertThread.run(thread.threadId, thread.subject, thread.searchProfileId);
      threads += 1;
      for (const msg of thread.messages) {
        const raw = buildRfc2822Local(msg.to, msg.from, msg.subject, msg.bodyText);
        insertMessage.run(
          msg.messageId,
          thread.threadId,
          raw,
          msg.to,
          msg.from,
          msg.subject,
          msg.internalDateMs,
          msg.direction,
          thread.searchProfileId,
        );
        messages += 1;
        for (const att of msg.attachments ?? []) {
          const size = Buffer.from(att.dataBase64, "base64").length;
          insertAttachment.run(
            att.attachmentId,
            msg.messageId,
            att.filename,
            att.mimeType,
            size,
            att.dataBase64,
          );
          attachments += 1;
        }
      }
    }
  });
  txn();

  return { threads, messages, attachments };
}
