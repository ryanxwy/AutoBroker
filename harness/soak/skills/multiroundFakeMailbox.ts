/**
 * multiroundFakeMailbox — the multiround_fake_mailbox helper the dealer.md TODO
 * names. It writes ONE Sonnet-dealer reply into the fake mailbox so the NEXT
 * /dealer_inbox_check round DISCOVERS it through the FakeGmailAdapter and the SUT
 * does the product-table ingestion itself.
 *
 * WHAT IT WRITES (and ONLY this): an INBOUND row in fake_mailbox_threads +
 * fake_mailbox_messages, in the EXACT FakeGmailAdapter row shape:
 *   - `raw` = base64url RFC-2822 (To/From/Subject headers, blank line, body) —
 *     the adapter decodes it back to recover the body;
 *   - `internal_date_ms` strictly greater than every stored row (the monotonic
 *     watermark the adapter's getCurrentHistoryId / historyList trust, so the
 *     reply reads as "newer than the last sync cursor" and is discovered);
 *   - `direction = 'inbound'`, `is_delivered = 1`.
 * It NEVER touches the product `threads`/`messages`/`dealer_quotes`/anything — the
 * dealer turn is pure environment; the SUT's own /dealer_inbox_check is the only
 * thing that writes the product tables (the trust-boundary rule). It also never
 * runs an AutoBroker skill, never sends real email, never drives the browser.
 *
 * IMPLEMENTATION: it reuses the canonical tools-layer writer `seedFakeMailbox`
 * (which owns the four fake_mailbox_* tables + builds the same base64url raw the
 * adapter writes/reads and enforces the strictly-increasing-watermark invariant),
 * so the row this helper produces is byte-identical to a real fake-mailbox row.
 * The helper picks the next monotonic internalDateMs off the current ceiling so a
 * mid-round dealer reply always sorts AFTER our just-sent outbound.
 *
 * CLOCK NOTE: the timing gate (gateDecisionForTarget, minGapHours=24,
 * maxGapDays=7) reads wall-clock. A multi-round soak fires rounds within seconds,
 * so the inbound the dealer writes must be RECENT (now-ish) for the next round to
 * read `ready` not `skip`/`wait`. The helper stamps the row at `nowMs` by default
 * (mapped through the monotonic ceiling), and a caller can pass an explicit
 * `agedMs` to make the dealer go COLD (the dealer_stalls / silence-window class:
 * an inbound older than maxGapDays makes the next batch DROP the thread).
 *
 * Dependency wall: harness layer. Imports @autobroker/db (the Db type) +
 * @autobroker/tools (seedFakeMailbox — the sanctioned fake_mailbox writer). NEVER
 * better-sqlite3/drizzle directly, never a product-table write.
 */

import type { Db } from "@autobroker/db";
import {
  openReadHandleAt,
} from "../../dbReads.js";
import { seedFakeMailbox, type SeedFakeMailboxResult } from "@autobroker/tools";

/** One Sonnet-dealer reply to land in the fake mailbox for a multi-round round. */
export interface DealerReplyTurn {
  /** The fake_mailbox thread the reply lands in. To be discovered + ingested as a
   *  reply on the SAME conversation, reuse a stable per-(profile,dealer) thread id
   *  (e.g. `fake-soak-<dealerId>`) across rounds so the adapter groups them. */
  fakeThreadId: string;
  /** The dealer's from-address (a dealer rep email). */
  from: string;
  /** Our buyer's address the reply is addressed to (the To header). */
  to: string;
  /** The subject (reuse the thread subject so it reads as an in-thread reply). */
  subject: string;
  /** The Sonnet-dealer-generated reply body (verbatim — inbound dealer prose is
   *  stored as-is; the SUT fences it as untrusted on the next draft). */
  bodyText: string;
  /** The profile this fake thread is scoped to (the adapter stamps it on the row). */
  searchProfileId: string | null;
  /** A unique message id for the reply (the fake message id IS the inbound row's
   *  gmail_message_id once the SUT ingests it). Deterministic per (thread, round). */
  messageId: string;
}

export interface WriteDealerReplyOpts {
  /** The isolated soak DB path (the same db the SUT host reads/writes). */
  dbPath: string;
  reply: DealerReplyTurn;
  /**
   * How old to stamp the reply, in ms BEFORE now. Default 0 → a fresh inbound
   * (the next round reads `ready`). Pass a value > maxGapDays (e.g. 8 days) to
   * make the dealer go COLD for the silence-window / dealer_stalls class.
   */
  agedMs?: number;
  /** Test/clock seam (defaults to Date.now). */
  nowMs?: () => number;
}

const SELECT_MAX_DATE = "SELECT MAX(internal_date_ms) AS m FROM fake_mailbox_messages";

/** The current fake-mailbox monotonic ceiling (max internal_date_ms, 0 when
 *  empty). Read-only. */
function currentCeiling(db: Db): number {
  const row = db.$client.prepare(SELECT_MAX_DATE).get() as { m: number | null };
  return row.m ?? 0;
}

/**
 * Write one Sonnet-dealer reply into the fake mailbox (fake_mailbox_* ONLY) so the
 * next /dealer_inbox_check discovers it. Picks an internalDateMs that is BOTH:
 *   - the intended wall-clock recency (now - agedMs, so the timing gate reads it
 *     correctly), AND
 *   - strictly greater than the current ceiling (the monotonic-watermark invariant
 *     seedFakeMailbox enforces) — if the recency value would tie/regress against a
 *     just-sent outbound, we bump to ceiling+1 (recency still within the window).
 * Returns the seedFakeMailbox result (1 thread attempted, 1 message) + the
 * effective internalDateMs stamped.
 */
export function writeDealerReplyToFakeMailbox(
  opts: WriteDealerReplyOpts,
): SeedFakeMailboxResult & { internalDateMs: number } {
  const now = (opts.nowMs ?? Date.now)();
  const aged = opts.agedMs ?? 0;
  const desired = now - aged;

  const { db, close } = openReadHandleAt(opts.dbPath);
  try {
    const ceiling = currentCeiling(db);
    // Strictly-increasing watermark: never tie/regress against the current
    // ceiling. For a FRESH reply (aged=0) the desired now-stamp is almost always
    // already > ceiling; the bump only matters when two writes share a ms. For a
    // COLD reply (aged large) we deliberately keep the old timestamp ONLY when it
    // is still > ceiling; otherwise the monotonic invariant wins (ceiling+1) — but
    // a cold thread is exercised by aging the SEEDED inbound, not by back-dating
    // below the ceiling, so this branch stays consistent in practice.
    const internalDateMs = desired > ceiling ? desired : ceiling + 1;

    const result = seedFakeMailbox({
      db,
      threads: [
        {
          threadId: opts.reply.fakeThreadId,
          subject: opts.reply.subject,
          searchProfileId: opts.reply.searchProfileId,
          messages: [
            {
              messageId: opts.reply.messageId,
              direction: "inbound",
              from: opts.reply.from,
              to: opts.reply.to,
              subject: opts.reply.subject,
              bodyText: opts.reply.bodyText,
              internalDateMs,
            },
          ],
        },
      ],
    });
    return { ...result, internalDateMs };
  } finally {
    close();
  }
}

/** Count INBOUND fake-mailbox messages (the discovery witness — proves the dealer
 *  turn landed an inbound row the next /dealer_inbox_check will ingest). Read-only. */
export function countInboundFakeMessages(dbPath: string): number {
  const { db, close } = openReadHandleAt(dbPath);
  try {
    const row = db.$client
      .prepare("SELECT COUNT(*) AS n FROM fake_mailbox_messages WHERE direction = 'inbound'")
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  } finally {
    close();
  }
}

/** Assert the dealer turn wrote ZERO product threads/messages rows attributable to
 *  it (the dealer never touches the product tables). The caller passes the product
 *  threads/messages counts captured immediately BEFORE and AFTER the helper write;
 *  both deltas MUST be 0 (only /dealer_inbox_check later writes product rows). */
export function dealerTurnTouchedNoProductTables(args: {
  productThreadsBefore: number;
  productThreadsAfter: number;
  productMessagesBefore: number;
  productMessagesAfter: number;
}): boolean {
  return (
    args.productThreadsAfter - args.productThreadsBefore === 0 &&
    args.productMessagesAfter - args.productMessagesBefore === 0
  );
}
