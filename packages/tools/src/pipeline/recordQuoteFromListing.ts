/**
 * recordQuoteFromListing — the single write path for a targeted-VIN
 * dealer_quotes row (the quote captured from the OTD ask on one specific
 * listing). Idempotent on quote_id: a replay with the same quote_id is a no-op
 * (the row already exists), so re-running the targeted path never duplicates.
 *
 * message_id is REQUIRED and must resolve to a REAL `messages` row — the tool
 * reads that row's gmail_message_id to populate dealer_quotes.source_gmail_message_id
 * (the column that, with financing_mode, forms the table's UNIQUE idempotency
 * key). Synthesizing a local id is rejected: an id that does not resolve to a
 * messages row throws MessageNotFoundError, because a fabricated id breaks the
 * messages→threads provenance join the rest of the pipeline trusts. (A real
 * messages row whose gmail_message_id is itself NULL is still acceptable — the
 * provenance value falls back to the messages.message_id, but the row MUST
 * exist.)
 *
 * source_listing_id is set to the targeting listing id (the nullable
 * back-pointer to the VIN that was asked about — NOT a unique key; multiple
 * quotes may legitimately point at one listing).
 *
 * SQLITE INVARIANT: raw better-sqlite3 via db.$client (no drizzle-orm).
 */

import type { Db } from "@autobroker/db";

/** The required message_id did not resolve to a real `messages` row. A
 *  synthesized / local id is rejected here. */
export class MessageNotFoundError extends Error {
  constructor(readonly messageId: string) {
    super(
      `recordQuoteFromListing: message_id ${messageId} does not resolve to a real messages row`,
    );
    this.name = "MessageNotFoundError";
  }
}

/** A message_id was missing/blank. */
export class MissingMessageIdError extends Error {
  constructor() {
    super("recordQuoteFromListing: a non-empty message_id is required");
    this.name = "MissingMessageIdError";
  }
}

export interface RecordQuoteFromListingArgs {
  quoteId: string;
  /** REQUIRED — must resolve to a real messages row (no synthesized ids). */
  messageId: string;
  sourceListingId: string;
  dealerId: string;
  searchProfileId: string;
  financingMode: string;
  vin?: string | null;
  otdTotal?: number | null;
  db?: Db;
}

export interface RecordQuoteFromListingResult {
  /** True when this call inserted the row; false on an idempotent replay (the
   *  quote_id already existed). */
  recorded: boolean;
}

const SELECT_QUOTE_EXISTS = `SELECT 1 FROM dealer_quotes WHERE quote_id = ? LIMIT 1`;

// Resolve the real messages row → its gmail_message_id (provenance source).
const SELECT_MESSAGE = `
SELECT message_id, gmail_message_id
  FROM messages
 WHERE message_id = ?
 LIMIT 1
`;

const INSERT_QUOTE = `
INSERT INTO dealer_quotes
  (quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id,
   vin, otd_total, financing_mode, source_listing_id)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Insert exactly one dealer_quotes row for the targeted listing, idempotent on
 * quote_id. Throws MissingMessageIdError on a blank id and MessageNotFoundError
 * when the id does not resolve to a real messages row.
 */
export function recordQuoteFromListing(
  args: RecordQuoteFromListingArgs,
): RecordQuoteFromListingResult {
  const db = args.db;
  if (db === undefined) {
    throw new Error("recordQuoteFromListing: a db handle is required");
  }

  const messageId = args.messageId.trim();
  if (messageId === "") {
    throw new MissingMessageIdError();
  }

  // Idempotent replay: the quote already exists → no write.
  if (db.$client.prepare(SELECT_QUOTE_EXISTS).get(args.quoteId) !== undefined) {
    return { recorded: false };
  }

  const messageRow = db.$client.prepare(SELECT_MESSAGE).get(messageId) as
    | { message_id: string; gmail_message_id: string | null }
    | undefined;
  if (messageRow === undefined) {
    throw new MessageNotFoundError(messageId);
  }

  // source_gmail_message_id is NOT NULL — fall back to the messages.message_id
  // when the gmail id is itself null (a real row that simply lacks a gmail id),
  // never to a fabricated value.
  const sourceGmailMessageId = messageRow.gmail_message_id ?? messageRow.message_id;

  db.$client
    .prepare(INSERT_QUOTE)
    .run(
      args.quoteId,
      args.dealerId,
      messageId,
      sourceGmailMessageId,
      args.searchProfileId,
      args.vin ?? null,
      args.otdTotal ?? null,
      args.financingMode,
      args.sourceListingId,
    );

  return { recorded: true };
}
