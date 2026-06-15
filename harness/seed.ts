/**
 * seed — the sanctioned harness writes into the product DB, strictly scoped to
 * the run's ISOLATED throwaway DB (the --db file preflight already pinned) and
 * to a single consuming step's input bootstrap:
 *   - dealer_inventory_sources → pending rows for an inventory_link_scan case
 *     (written through the @autobroker/tools seeder; the frozen parity id
 *     construction lives in product code, never here);
 *   - dealer_replies           → the dealer + thread + fake_mailbox message +
 *     matching inbound `messages` candidate row a dealer_reply_extract live run
 *     reads (the fake_mailbox half via the @autobroker/tools seedFakeMailbox).
 * Everything else keeps the dbReads trust boundary: the harness only ever
 * CHANGES product state through the SUT's HTTP.
 *
 * Why a direct write at all: the skill's input is "rows already pending in
 * the DB" (dev-period sources are manual/seeded; the dealer_reply_extract
 * pipeline that will write them in production is a later skill). There is no
 * product HTTP surface that creates these rows yet, so the case bootstrap
 * writes them the same way an operator would — and ONLY into the isolated
 * case DB, after the server host booted it, before the consuming step runs.
 *
 * Dealer resolution: each seed entry names a dealer (exact name match first,
 * else a UNIQUE case-insensitive substring) among the profile's BOUND dealers
 * (profile_dealers ⋈ dealers) — the live geosearch step created those rows
 * minutes earlier, so exact names cannot be authored ahead of time. Zero or
 * ambiguous matches fail LOUD with the available names listed (the live
 * operator adjusts the case's dealer/url pairs to the real discovered world).
 *
 * Dependency wall: harness layer. Imports @autobroker/db (openDb at the
 * explicit isolated path) + @autobroker/tools (the seeder) — the same two
 * permitted channels serverHost.ts already uses for its boot-time bootstrap.
 */

import { openDb } from "@autobroker/db";
import { seedFakeMailbox, seedInventorySource } from "@autobroker/tools";

import type { CaseSeedReply, CaseSeedSource } from "./cases.js";

/** One bound dealer row (the name-resolution domain). */
interface BoundDealer {
  dealerId: string;
  name: string;
}

/**
 * Resolve a seed entry's dealer name against the bound dealers: exact match
 * first, else a UNIQUE case-insensitive substring. Exported pure for tests.
 */
export function resolveSeedDealer(match: string, dealers: readonly BoundDealer[]): BoundDealer {
  const want = match.trim();
  const exact = dealers.filter((d) => d.name.trim() === want);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) {
    throw new Error(`seed: dealer "${want}" matches ${exact.length} bound dealers exactly`);
  }
  const wantLc = want.toLowerCase();
  const fuzzy = dealers.filter((d) => d.name.toLowerCase().includes(wantLc));
  if (fuzzy.length === 1) return fuzzy[0]!;
  if (fuzzy.length === 0) {
    throw new Error(
      `seed: dealer "${want}" matched NO bound dealer (bound: ${
        dealers.map((d) => d.name).join(" | ") || "(none)"
      })`,
    );
  }
  throw new Error(
    `seed: dealer "${want}" is ambiguous (${fuzzy.map((d) => d.name).join(" | ")})`,
  );
}

export interface ApplySeedsResult {
  /** Rows actually inserted (an idempotent re-apply inserts 0). */
  seeded: number;
  /** Every entry's resolved source id, in seed order. */
  sourceIds: string[];
}

/**
 * Apply a case's [[seed.dealer_inventory_sources]] entries to the ISOLATED
 * case DB at `dbPath`, scoped to `profileId`. Idempotent (the tools seeder's
 * frozen-id ON CONFLICT DO NOTHING). Opens its own short-lived handle.
 */
export function applyInventorySourceSeeds(opts: {
  dbPath: string;
  profileId: string;
  seeds: readonly CaseSeedSource[];
}): ApplySeedsResult {
  const db = openDb(opts.dbPath);
  try {
    const dealers = (
      db.$client
        .prepare(
          "SELECT d.dealer_id AS dealerId, d.name AS name FROM dealers d " +
            "JOIN profile_dealers pd ON pd.dealer_id = d.dealer_id " +
            "WHERE pd.search_profile_id = ?",
        )
        .all(opts.profileId) as Array<{ dealerId: string; name: string }>
    ).map((r) => ({ dealerId: r.dealerId, name: r.name }));

    let seeded = 0;
    const sourceIds: string[] = [];
    for (const seed of opts.seeds) {
      const dealer = resolveSeedDealer(seed.dealer, dealers);
      const result = seedInventorySource({
        searchProfileId: opts.profileId,
        dealerId: dealer.dealerId,
        sourceUrl: seed.url,
        sourceType: seed.sourceType,
        discoveryMethod: "manual",
        db,
      });
      if (result.inserted) seeded += 1;
      sourceIds.push(result.sourceId);
    }
    return { seeded, sourceIds };
  } finally {
    db.$client.close();
  }
}

// ---------------------------------------------------------------------------
// dealer_replies — the dealer_reply_extract LIVE corpus bootstrap
// ---------------------------------------------------------------------------

/**
 * Unlike the inventory seeder (which RESOLVES against geosearch's bound
 * dealers), the reply seeder CREATES the corpus a dealer_reply_extract live run
 * consumes. A valid candidate needs BOTH halves to line up, so each reply mints
 * all of them, keyed off ONE deterministic per-reply id so a re-apply is a
 * complete no-op:
 *
 *   - dealers + profile_dealers  — the dealer the quote keys to, BOUND to the
 *     scoped profile (the candidate JOIN onto threads.dealer_id requires it);
 *   - threads                    — profile-scoped, bound to the dealer (the
 *     candidate SELECT resolves dealer_id via the message's thread_id);
 *   - fake_mailbox thread+message — the adapter's read source: getMessage()
 *     keys on fake_mailbox_messages.message_id, so the inbound `messages` row's
 *     gmail_message_id MUST equal it (the body + optional attachment bytes the
 *     extractor reads ride here);
 *   - messages                   — the inbound candidate the loadCandidates
 *     SELECT reads: direction='inbound', quote_extraction_status='pending'
 *     (so quote_extraction_intent stays NULL per the CHECK), gmail_message_id =
 *     the fake message id, search_profile_id = the scoped profile (the orphan
 *     fix's NON-NULL provenance).
 *
 * internal_date_ms is strictly increasing across the batch (seedFakeMailbox
 * asserts it). Idempotent: every insert is ON CONFLICT DO NOTHING.
 */

export interface ApplyReplySeedsResult {
  dealers: number;
  threads: number;
  messages: number;
  attachments: number;
}

// A bound dealer (idempotent on the dealer_id PK / the composite profile PK).
const INSERT_DEALER =
  "INSERT INTO dealers (dealer_id, name, website, country) VALUES (?, ?, ?, 'US') " +
  "ON CONFLICT(dealer_id) DO NOTHING";
const BIND_DEALER =
  "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound') " +
  "ON CONFLICT(search_profile_id, dealer_id) DO NOTHING";
// The product thread the candidate SELECT joins (dealer_id resolves through it).
const INSERT_THREAD =
  "INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id) " +
  "VALUES (?, ?, ?, 'replied', ?) ON CONFLICT(thread_id) DO NOTHING";
// The inbound candidate row: pending → intent NULL (the CHECK), gmail_message_id
// = the fake message id so the adapter's getMessage() finds the body+attachment.
const INSERT_MESSAGE =
  "INSERT INTO messages " +
  "(message_id, thread_id, gmail_message_id, direction, sender, subject, body_text, " +
  "received_at, search_profile_id, quote_extraction_status, quote_extraction_intent) " +
  "VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, 'pending', NULL) " +
  "ON CONFLICT(message_id) DO NOTHING";

/**
 * Apply a case's [[seed.dealer_replies]] entries to the ISOLATED case DB at
 * `dbPath`, scoped to `profileId`. Opens its own short-lived handle and reuses
 * it for both the direct product writes and the @autobroker/tools fake-mailbox
 * seeder (the sanctioned inbound-corpus writer).
 */
export function applyDealerReplySeeds(opts: {
  dbPath: string;
  profileId: string;
  replies: readonly CaseSeedReply[];
}): ApplyReplySeedsResult {
  const db = openDb(opts.dbPath);
  try {
    const insertDealer = db.$client.prepare(INSERT_DEALER);
    const bindDealer = db.$client.prepare(BIND_DEALER);
    const insertThread = db.$client.prepare(INSERT_THREAD);
    const insertMessage = db.$client.prepare(INSERT_MESSAGE);

    let dealers = 0;
    let threads = 0;
    let messagesCount = 0;
    let attachments = 0;

    // The fake-mailbox watermark must strictly increase across the WHOLE batch;
    // a fixed base + index keeps it deterministic (and reproducible re-applies).
    const BASE_MS = 1_717_000_000_000; // a fixed wall-clock floor for the corpus.

    opts.replies.forEach((reply, i) => {
      // Deterministic per-reply ids: a re-apply hits every ON CONFLICT no-op.
      const slug = `${opts.profileId}-reply-${i}`;
      const dealerId = `dre-seed-dealer-${slug}`;
      const threadId = `dre-seed-thread-${slug}`;
      const messageId = `dre-seed-msg-${slug}`;
      // The fake-mailbox message id IS the inbound row's gmail_message_id (the
      // adapter's getMessage handle + the UNIQUE upsert key the extractor uses).
      const gmailMessageId = `dre-seed-gmsg-${slug}`;
      const internalDateMs = BASE_MS + i;
      const receivedAt = new Date(internalDateMs).toISOString();

      // dealer (bound to the profile) + product thread.
      const dInfo = insertDealer.run(dealerId, reply.dealerName, reply.dealerWebsite);
      if (dInfo.changes > 0) dealers += 1;
      bindDealer.run(opts.profileId, dealerId);
      const tInfo = insertThread.run(threadId, dealerId, reply.subject, opts.profileId);
      if (tInfo.changes > 0) threads += 1;

      // fake_mailbox thread+message (the adapter's read source): body + the
      // optional quote attachment bytes. seedFakeMailbox owns the four
      // fake_mailbox_* tables; reuse the open handle.
      const attachment =
        reply.attachment === null
          ? undefined
          : [
              {
                attachmentId: `dre-seed-att-${slug}`,
                filename: reply.attachment.filename,
                mimeType: reply.attachment.mimeType,
                dataBase64: reply.attachment.dataBase64,
              },
            ];
      const fakeResult = seedFakeMailbox({
        db,
        threads: [
          {
            threadId: `fake-${threadId}`,
            subject: reply.subject,
            searchProfileId: opts.profileId,
            messages: [
              {
                messageId: gmailMessageId,
                direction: "inbound",
                from: reply.from,
                to: "buyer@example.com",
                subject: reply.subject,
                bodyText: reply.body,
                internalDateMs,
                ...(attachment !== undefined ? { attachments: attachment } : {}),
              },
            ],
          },
        ],
      });
      attachments += fakeResult.attachments;

      // the inbound candidate row (gmail_message_id ties it to the fake message).
      const mInfo = insertMessage.run(
        messageId,
        threadId,
        gmailMessageId,
        reply.from,
        reply.subject,
        reply.body,
        receivedAt,
        opts.profileId,
      );
      if (mInfo.changes > 0) messagesCount += 1;
    });

    return { dealers, threads, messages: messagesCount, attachments };
  } finally {
    db.$client.close();
  }
}
