/**
 * dealer_reply_extract candidate reader — the read-only SELECT of the inbound
 * messages a reply-extract run must process for a profile, plus the identity a
 * row needs to be persisted.
 *
 * The candidate set is every INBOUND message whose extraction state machine is
 * not yet terminal-succeeded:
 *   quote_extraction_status IN ('pending','failed')
 * AND search_profile_id = ?   -- profile-scoped only; NULL rows are not candidates
 * A `succeeded` row is NEVER re-processed (idempotent re-extract skips it); a
 * `failed` row is re-attempted on a re-run.
 *
 * For each candidate the reader resolves the persist identity:
 *   - dealer_id          — via the message's thread_id → threads.dealer_id (the
 *     orphan-row discipline: a message with no resolvable dealer is NOT a
 *     candidate — there is nothing valid to key a quote to);
 *   - source_gmail_message_id — the message's gmail_message_id (the UNIQUE
 *     upsert key + the handle the gmail adapter fetches attachment bytes by);
 *   - search_profile_id  — the message's own profile (the NON-NULL provenance).
 *
 * Read-only: one prepared SELECT, no writes, no external I/O. Funnelled through
 * the tools layer per the SQLite invariant.
 */

import type { Db } from "@autobroker/db";

import { getDb } from "../db.js";

/** One inbound message that warrants an extraction attempt, with the identity
 *  the persist writer stamps. */
export interface ReplyExtractCandidate {
  /** The messages.message_id PK. */
  messageId: string;
  /** The dealer resolved from the message's thread (threads.dealer_id). */
  dealerId: string;
  /** The message's gmail_message_id → the UNIQUE upsert key + the adapter
   *  handle used to fetch the per-message content + attachment bytes. */
  sourceGmailMessageId: string;
  /** The owning profile (NON-NULL on every persisted quote). */
  searchProfileId: string;
  /** The message body (the text-quote source + the LLM prompt material). */
  body: string;
}

/** Rows whose status is one of these are candidates. A succeeded row is
 *  terminal and never re-processed. */
const SELECT_CANDIDATES = `
SELECT
  m.message_id          AS message_id,
  t.dealer_id           AS dealer_id,
  m.gmail_message_id    AS gmail_message_id,
  m.search_profile_id   AS search_profile_id,
  m.body_text           AS body_text
FROM messages m
JOIN threads t ON t.thread_id = m.thread_id
WHERE m.direction = 'inbound'
  AND m.quote_extraction_status IN ('pending', 'failed')
  AND m.search_profile_id = ?
  AND m.gmail_message_id IS NOT NULL
  AND m.search_profile_id IS NOT NULL  -- provenance guard: exclude NULL-profile rows
ORDER BY m.message_id
`;

interface CandidateRow {
  message_id: string;
  dealer_id: string;
  gmail_message_id: string;
  search_profile_id: string;
  body_text: string | null;
}

/**
 * Load the pending/failed inbound candidates for one profile. The JOIN onto
 * threads enforces the orphan-row discipline (a message with no resolvable
 * dealer thread is silently excluded — nothing valid to key a quote to). Only
 * messages with `search_profile_id = searchProfileId` are candidates; rows
 * with a NULL profile are excluded (no valid provenance to stamp on the quote).
 */
export function loadReplyExtractCandidates(
  searchProfileId: string,
  db: Db = getDb(),
): ReplyExtractCandidate[] {
  const rows = db.$client.prepare(SELECT_CANDIDATES).all(searchProfileId) as CandidateRow[];
  return rows.map((r) => ({
    messageId: r.message_id,
    dealerId: r.dealer_id,
    sourceGmailMessageId: r.gmail_message_id,
    searchProfileId: r.search_profile_id,
    body: r.body_text ?? "",
  }));
}
