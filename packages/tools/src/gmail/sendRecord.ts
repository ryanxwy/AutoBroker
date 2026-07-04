/**
 * sendRecord — the single skill-facing outbound-message writer for the
 * irreversible-send skills (X1/X2/X3). It does the WHOLE draft-then-promote
 * send+record INSIDE one approved gate commit, so a side effect (the send — real
 * in buyer mode, fake in test mode) and its durable record can only happen
 * together, and only after approval.
 *
 * THE DRAFT-THEN-PROMOTE FLOW (inside `withGate`, in this exact order):
 *   1. test-mode brake (`assertFakeMailboxSendOnly`) — fake adapter only when
 *      not in buyer mode (fail-CLOSED);
 *   2. INSERT a draft `messages` row with `gmail_message_id = NULL` — the durable
 *      checkpoint that survives a later send failure;
 *   3. `adapter.send(raw)` — the irreversible boundary (real in buyer mode, fake in test mode);
 *   4. PROMOTE: UPDATE the draft, backfilling `gmail_message_id`, only WHERE it
 *      is still NULL — so a double-fire promote is a harmless no-op.
 *
 * The three outcomes follow from WHERE control left the flow:
 *   - sent     — buyer mode (or an approved fake) + approve: one draft →
 *                promoted once.
 *   - declined — the L2 gate verdict was not approved: the commit callback never
 *                ran, so `draftRowId` stays null and ZERO rows were written.
 *   - partial  — the send threw AFTER the draft was inserted: the draft row is
 *                retained with `gmail_message_id` still NULL (a reconcile hook
 *                can later promote or discard it).
 *
 * SQLITE INVARIANT: raw better-sqlite3 handle only — no drizzle-orm.
 * Dependency wall: imports @autobroker/db (the Db type), the gate, the send
 * seam, and the preflight — all within Layer 4.
 */

import { randomUUID } from "node:crypto";

import { getDb, type Db } from "../db.js";
import { withGate, type Approver } from "../gate/index.js";
import {
  buildRaw,
  createGmailAdapter,
  type OutboundEmail,
  type SendMode,
} from "../gmail.js";
import { gmailLimiter } from "../limiter/index.js";
import { isBuyerMode } from "../realSend.js";
import { assertFakeMailboxSendOnly } from "./sendPreflight.js";
import type { GmailAdapter } from "./types.js";

/** One outbound message to send + record. */
export interface SendRecordTarget {
  /** The assembled outbound email ({to, from, subject, body}). */
  email: OutboundEmail;
  /** Existing thread to reply into, or null for a new top-level message. */
  threadId: string | null;
  /** The profile this send belongs to (stamped on the row), or null. */
  searchProfileId: string | null;
  /**
   * The backend message id this is a reply to, when `threadId` is set. Both must
   * be set together or both unset (the reply double-flag invariant). */
  inReplyToGmailId?: string | null;
}

/** A send that threw AFTER its draft row was durably inserted. The draft is
 *  retained (NULL gmail id) so a later reconcile can promote or discard it. */
export interface PartialSendResult {
  message_recorded: boolean;
  state_updated: boolean;
  reconcile_hint: string;
  external_id: string | null;
}

/** The result of one `sendAndRecord`, discriminated by where the flow ended. */
export type SendRecordOutcome =
  | { kind: "sent"; messageRowId: string; gmailMessageId: string; mode: SendMode }
  | { kind: "declined"; messageRowId: string | null }
  | { kind: "partial"; messageRowId: string; partial: PartialSendResult };

/** Injected dependencies. `adapter`/`db` default to the live factory/connection;
 *  tests inject a spy adapter + an isolated DB handle. */
export interface SendRecordDeps {
  approver: Approver;
  runId: string;
  adapter?: GmailAdapter;
  db?: Db;
}

/** Thrown when the reply double-flag invariant is violated: a reply MUST carry
 *  both `threadId` AND `inReplyToGmailId`, or neither. Exactly one set is an
 *  inconsistent reply target and is refused before any send is attempted. */
export class ThreadFlagMismatchError extends Error {
  constructor(detail: string) {
    super(`thread_flag_mismatch: ${detail}`);
    this.name = "ThreadFlagMismatchError";
  }
}

/**
 * Reply double-flag invariant: `threadId` and `inReplyToGmailId` are set together
 * or not at all. A thread reply also requires a non-empty subject (an empty
 * subject on an existing thread is a malformed reply). Throws on violation.
 */
function validateThreadFlags(target: SendRecordTarget): void {
  const hasThread = target.threadId !== null && target.threadId !== "";
  const inReplyTo = target.inReplyToGmailId ?? null;
  const hasReplyId = inReplyTo !== null && inReplyTo !== "";
  if (hasThread !== hasReplyId) {
    throw new ThreadFlagMismatchError(
      "a reply must set BOTH threadId and inReplyToGmailId, or neither",
    );
  }
  if (hasThread && target.email.subject.trim() === "") {
    throw new ThreadFlagMismatchError("a thread reply must carry a non-empty subject");
  }
}

const INSERT_DRAFT =
  "INSERT INTO messages " +
  "(message_id, thread_id, gmail_message_id, direction, sender, recipient, subject, " +
  "body_text, processed_at, search_profile_id, quote_extraction_status) " +
  "VALUES (?, ?, NULL, 'outbound', ?, ?, ?, ?, ?, ?, 'pending')";

// Promote ONLY a still-unsent draft: the NULL guard makes a second promote (a
// double-fire) a no-op rather than a clobber.
const PROMOTE_DRAFT =
  "UPDATE messages SET gmail_message_id = ? WHERE message_id = ? AND gmail_message_id IS NULL";

/** INSERT the draft outbound row (gmail_message_id NULL) and return its id. The
 *  draft is the durable checkpoint: it is written BEFORE the send so a send that
 *  throws still leaves a retained record. */
function insertOutboundDraft(db: Db, target: SendRecordTarget): string {
  const messageRowId = randomUUID();
  db.$client
    .prepare(INSERT_DRAFT)
    .run(
      messageRowId,
      target.threadId,
      target.email.from,
      target.email.to,
      target.email.subject,
      target.email.body,
      new Date().toISOString(),
      target.searchProfileId,
    );
  return messageRowId;
}

/** Backfill the draft's gmail_message_id — EXACTLY once (the NULL guard makes a
 *  re-call a no-op). Exposed for the double-fire-safety test. */
export function promoteOutbound(db: Db, messageRowId: string, gmailMessageId: string): void {
  db.$client.prepare(PROMOTE_DRAFT).run(gmailMessageId, messageRowId);
}

/**
 * Send one outbound message and record it, draft-then-promote, inside one gated
 * commit. Returns a discriminated outcome; NEVER throws for the expected
 * declined/partial paths (those are returned as outcomes). An error thrown
 * BEFORE any draft exists (e.g. a failed preflight) re-throws — fail closed, no
 * state.
 */
export async function sendAndRecord(
  target: SendRecordTarget,
  deps: SendRecordDeps,
): Promise<SendRecordOutcome> {
  validateThreadFlags(target);

  const raw = buildRaw(target.email); // redact + assertNoBudget + assertUnicodeSafe.
  const adapter = deps.adapter ?? createGmailAdapter();
  const db = deps.db ?? getDb();

  // `draftRowId` is the witness of how far the gated flow got: it stays null if
  // the commit callback never ran (decline) or threw before the insert (a failed
  // preflight, rethrown fail-closed); it is set once the draft is durable.
  let draftRowId: string | null = null;

  try {
    const result = await withGate(
      {
        kind: "gmail_send",
        runId: deps.runId,
        summary: `Send email to ${target.email.to} — "${target.email.subject}"`,
        payload: { to: target.email.to, subject: target.email.subject },
      },
      deps.approver,
      async () => {
        // Mode brake: in test mode this seam is fake-only (fail-closed). In buyer
        // mode the resolved (real) adapter is allowed — but ONLY after the L2
        // approval above. AUTOBROKER_MODE is the sole send-control var.
        if (!isBuyerMode()) assertFakeMailboxSendOnly({ adapter });
        draftRowId = insertOutboundDraft(db, target); // durable checkpoint, gmail id NULL.
        // The Gmail send limiter paces ONLY real sends (combined ≤ 60/min, daily
        // budget, 429 backoff, 403 circuit) — strictly BELOW this already-approved
        // L2 commit. Test-mode fake sends bypass it (no real quota to protect).
        const { messageId } = isBuyerMode()
          ? await gmailLimiter.runGmailSend(() => adapter.send(raw)) // irreversible boundary.
          : await adapter.send(raw); // fake mailbox row.
        promoteOutbound(db, draftRowId, messageId); // backfill gmail id, exactly once.
        return { messageRowId: draftRowId, gmailMessageId: messageId, mode: adapter.kind };
      },
    );

    // A gate verdict (not the callback's return) means the gate did NOT approve;
    // the callback never ran, so `draftRowId` is still null and zero rows exist.
    if ("decision" in result) {
      return { kind: "declined", messageRowId: draftRowId };
    }
    return { kind: "sent", ...result };
  } catch (err) {
    // The send threw AFTER the draft was inserted (an adapter throw): retain the
    // draft (NULL gmail id) and report a partial so a reconcile pass can promote
    // or discard it.
    if (draftRowId !== null) {
      return {
        kind: "partial",
        messageRowId: draftRowId,
        partial: {
          message_recorded: true,
          state_updated: false,
          reconcile_hint: "send_failed_draft_retained",
          external_id: null,
        },
      };
    }
    // Threw before any draft existed (e.g. the preflight rejected the adapter) —
    // fail closed with no state.
    throw err;
  }
}
