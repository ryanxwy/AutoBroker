/**
 * sendCloseSuppress — the closeout skill's two deterministic tools.
 *
 *   - assembleCloseoutTargets: the bound dealers eligible for a closeout. A
 *     dealer is eligible when it is BOUND to the profile, has an OPEN (non
 *     closed/agreed) thread, and is NOT already closeout-suppressed. Each
 *     surviving dealer's reply address is resolved by the 4-level ladder; a
 *     dealer with no resolvable address is skipped (counted, never a card row).
 *     An already-closeout-suppressed dealer is filtered out HERE — that is the
 *     idempotency floor: a second run re-assembles zero targets for a dealer
 *     already closed, so the whole run is a no-op (Δ0).
 *
 *   - closeAndSuppressDealer: the ONE atomic per-dealer unit. It calls the
 *     gated send (X0 `sendAndRecord`) and then folds the LOCAL close+suppress
 *     into a SINGLE better-sqlite3 transaction. The local writes are the durable
 *     record that a future inbox check never re-picks this dealer, so they run
 *     ON APPROVE regardless of the L1 fuse — exactly the lead-submission split:
 *     the network email is separately fuse-gated (under BLOCK=1 the send returns
 *     `blocked` with zero `messages` rows), but the close+suppress still commit.
 *     A gate DECLINE (no approval) writes NOTHING.
 *
 * STATE-ONLY: the close is `UPDATE threads SET state='closed'` and the suppress
 * is an INSERT — this tool NEVER deletes a row. The destructive wipe lives in
 * the separate reset skill.
 *
 * SQLITE INVARIANT: raw better-sqlite3 handle only (`db.$client`), no drizzle.
 * Dependency wall: imports the already-landed X0 send + closeout-draft + reply
 * ladder pieces and @autobroker/db — all within Layer 4.
 */

import type { Db } from "../db.js";
import type { Approver } from "../gate/index.js";
import { sendAndRecord } from "../gmail/sendRecord.js";
import type { GmailAdapter } from "../gmail/types.js";
import {
  resolveReplyTarget,
  type ContactRow,
  type InboundMessageRow,
  type LeadSubmissionRow,
} from "../dealerComm/replyTargets.js";
import { assertNoBudget, assertUnicodeSafe } from "../validators.js";

// ---------------------------------------------------------------------------
// assembleCloseoutTargets
// ---------------------------------------------------------------------------

/** One dealer the closeout will (try to) email + close. */
export interface CloseoutTarget {
  dealerId: string;
  dealerName: string;
  /** The open thread to close, or null when the dealer has none (a new
   *  top-level message; no thread row to flip). */
  threadId: string | null;
  /** The backend thread id the reply rides into; both reply flags travel
   *  together (null with a null threadId). */
  gmailThreadId: string | null;
  /** The reply address resolved by the 4-level ladder. */
  replyTo: string;
  /** The contact display name, for an optional greeting. */
  contactName: string | null;
}

/** The assemble result: the addressable targets + a count of dealers dropped
 *  for having no resolvable reply address (shown BEFORE the gate). */
export interface AssembleResult {
  targets: CloseoutTarget[];
  skippedNoAddress: number;
}

const BOUND_DEALERS_FOR_PROFILE =
  "SELECT d.dealer_id, d.name, d.contact_email " +
  "FROM profile_dealers pd JOIN dealers d ON d.dealer_id = pd.dealer_id " +
  "WHERE pd.search_profile_id = ? AND pd.status = 'bound' " +
  "ORDER BY d.dealer_id";

// Dealers already closed out (this run is idempotent on the suppression row).
const CLOSEOUT_SUPPRESSED_DEALER_IDS =
  "SELECT DISTINCT dealer_id FROM thread_suppression WHERE reason LIKE 'closeout:%'";

// The newest OPEN thread for a dealer on this profile (agreed/closed excluded).
const OPEN_THREAD_FOR_DEALER =
  "SELECT thread_id, gmail_thread_id FROM threads " +
  "WHERE search_profile_id = ? AND dealer_id = ? " +
  "AND state NOT IN ('closed', 'agreed') " +
  "ORDER BY updated_at DESC, thread_id LIMIT 1";

// The 4-level ladder inputs for one dealer (already-fetched rows). Each query is
// scoped to the dealer; contacts/inbound also scoped to the profile so a reply
// ingested under another search never leaks an address here.
const CONTACTS_FOR_DEALER =
  "SELECT contact_id, email, display_name, role, is_primary_reply_target " +
  "FROM dealer_contacts WHERE dealer_id = ?";
const INBOUND_FOR_DEALER =
  "SELECT m.contact_id, m.sender_email, m.received_at, m.message_id " +
  "FROM messages m JOIN threads t ON t.thread_id = m.thread_id " +
  "WHERE t.dealer_id = ? AND m.search_profile_id = ? AND m.direction = 'inbound'";
const LEAD_SUBS_FOR_DEALER =
  "SELECT submission_id, submitted_email FROM lead_submissions " +
  "WHERE dealer_id = ? AND search_profile_id = ?";

interface BoundDealerRow {
  dealer_id: string;
  name: string;
  contact_email: string | null;
}
interface OpenThreadRow {
  thread_id: string;
  gmail_thread_id: string | null;
}

/** Parse a received_at value (ISO string or epoch-ms numeric) to epoch ms, or
 *  null. Mirrors the convention used elsewhere for the timestamp column. */
function toMs(raw: string | number | null): number | null {
  if (raw === null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (raw.trim() === "") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** Resolve one dealer's reply address via the 4-level ladder over its fetched
 *  contacts / inbound messages / lead submissions / dealer row. */
function resolveDealerReplyTo(
  db: Db,
  dealerId: string,
  searchProfileId: string,
  contactEmail: string | null,
): string | null {
  const contacts = (
    db.$client.prepare(CONTACTS_FOR_DEALER).all(dealerId) as Array<{
      contact_id: string;
      email: string | null;
      display_name: string | null;
      role: string | null;
      is_primary_reply_target: number | null;
    }>
  ).map(
    (r): ContactRow => ({
      contactId: r.contact_id,
      email: r.email,
      displayName: r.display_name,
      role: r.role,
      isPrimaryReplyTarget: r.is_primary_reply_target,
    }),
  );
  const inbound = (
    db.$client.prepare(INBOUND_FOR_DEALER).all(dealerId, searchProfileId) as Array<{
      contact_id: string | null;
      sender_email: string | null;
      received_at: string | number | null;
      message_id: string;
    }>
  ).map(
    (r): InboundMessageRow => ({
      contactId: r.contact_id,
      senderEmail: r.sender_email,
      receivedAtMs: toMs(r.received_at),
      messageId: r.message_id,
    }),
  );
  const leadSubmissions = (
    db.$client.prepare(LEAD_SUBS_FOR_DEALER).all(dealerId, searchProfileId) as Array<{
      submission_id: string;
      submitted_email: string | null;
    }>
  ).map(
    (r): LeadSubmissionRow => ({
      submissionId: r.submission_id,
      submittedEmail: r.submitted_email,
    }),
  );

  const resolved = resolveReplyTarget({
    contacts,
    inboundMessages: inbound,
    leadSubmissions,
    dealer: { contactEmail },
  });
  return resolved?.email ?? null;
}

/** The contact display name to greet (the primary-reply-target contact's name,
 *  else the newest-named contact, else null). Read-only. */
function pickContactName(db: Db, dealerId: string): string | null {
  const rows = db.$client
    .prepare(
      "SELECT display_name, is_primary_reply_target FROM dealer_contacts " +
        "WHERE dealer_id = ? AND display_name IS NOT NULL " +
        "ORDER BY is_primary_reply_target DESC, contact_id LIMIT 1",
    )
    .all(dealerId) as Array<{ display_name: string | null }>;
  return rows[0]?.display_name ?? null;
}

/**
 * Assemble the closeout targets for a profile: bound dealers with an OPEN
 * thread, minus dealers already closeout-suppressed, each resolved to a reply
 * address. A dealer with no resolvable address is dropped and counted in
 * `skippedNoAddress`. Deterministic; read-only.
 */
export function assembleCloseoutTargets(
  db: Db,
  searchProfileId: string,
): AssembleResult {
  const suppressed = new Set(
    (
      db.$client.prepare(CLOSEOUT_SUPPRESSED_DEALER_IDS).all() as Array<{ dealer_id: string }>
    ).map((r) => r.dealer_id),
  );

  const bound = db.$client
    .prepare(BOUND_DEALERS_FOR_PROFILE)
    .all(searchProfileId) as BoundDealerRow[];

  const targets: CloseoutTarget[] = [];
  let skippedNoAddress = 0;

  for (const d of bound) {
    if (suppressed.has(d.dealer_id)) continue; // idempotency floor — already closed.

    const open = db.$client
      .prepare(OPEN_THREAD_FOR_DEALER)
      .get(searchProfileId, d.dealer_id) as OpenThreadRow | undefined;
    if (open === undefined) continue; // no open thread → nothing to close out.

    const replyTo = resolveDealerReplyTo(db, d.dealer_id, searchProfileId, d.contact_email);
    if (replyTo === null) {
      skippedNoAddress += 1; // shown before the gate; never a card row.
      continue;
    }

    targets.push({
      dealerId: d.dealer_id,
      dealerName: d.name,
      threadId: open.thread_id,
      gmailThreadId: open.gmail_thread_id,
      replyTo,
      contactName: pickContactName(db, d.dealer_id),
    });
  }

  return { targets, skippedNoAddress };
}

// ---------------------------------------------------------------------------
// closeAndSuppressDealer — the ONE atomic per-dealer unit
// ---------------------------------------------------------------------------

// thread_suppression CHECKs (schema): scope IN ('thread','contact','dealer'),
// action IN ('suppress','cleanup','unsubscribed'), approved_by IN ('user',
// 'pending'). The closeout row: scope='dealer', action='suppress',
// approved_by='user', reason='closeout:<profileId>' (the reason LIKE
// 'closeout:%' is the idempotency key the assemble filter reads back).
const INSERT_CLOSEOUT_SUPPRESSION =
  "INSERT INTO thread_suppression " +
  "(suppression_id, thread_id, dealer_id, gmail_thread_id, scope, action, " +
  "reason, approved_by, approved_at, search_profile_id) " +
  "VALUES (?, ?, ?, ?, 'dealer', 'suppress', ?, 'user', ?, ?) " +
  "ON CONFLICT(suppression_id) DO NOTHING";
const CLOSE_THREAD = "UPDATE threads SET state = 'closed' WHERE thread_id = ?";

/** The outcome of one closeout: `closed` once the local close+suppress
 *  committed (whether the send went out or was fuse-blocked), or
 *  `short_circuit` when the gate declined — nothing was written and the batch
 *  halts. */
export type CloseoutDealerOutcome =
  | { kind: "closed"; messageRowId: string | null; sendBlocked: boolean }
  | { kind: "short_circuit"; reconcileHint: string };

/** The arguments for one per-dealer closeout. `body`/`subject` are the
 *  deterministic default draft, OR the user's EDITed text (re-asserted here). */
export interface CloseAndSuppressArgs {
  db: Db;
  approver: Approver;
  runId: string;
  searchProfileId: string;
  target: CloseoutTarget;
  body: string;
  subject: string;
  /** The buyer follow-up email the closeout is sent from (no budget; redacted
   *  by the send's own buildRaw). */
  fromEmail: string;
  /** Optional adapter override (tests inject a FakeGmailAdapter to exercise the
   *  `sent`/promote path; production uses the factory default). */
  adapter?: GmailAdapter;
}

/**
 * Send one closeout (fake), then close the thread + write the closeout
 * suppression row in ONE local transaction. The send is L1-fuse-gated; the
 * close+suppress are local writes that run on APPROVE regardless of the fuse —
 * a gate DECLINE writes nothing and short-circuits the batch.
 */
export async function closeAndSuppressDealer(
  args: CloseAndSuppressArgs,
): Promise<CloseoutDealerOutcome> {
  // Belt: an EDITed body/subject must re-pass the deterministic asserts BEFORE
  // the draft insert (the send's buildRaw also asserts; this fails loud sooner).
  assertUnicodeSafe(args.body);
  assertNoBudget(args.body);
  assertUnicodeSafe(args.subject);
  assertNoBudget(args.subject);

  // 1) The GATED send (X0). Under BLOCK=1 → {blocked} (zero messages rows); a
  //    disarmed fuse + approve → {sent}. NEVER throws for blocked/declined/
  //    partial. A `declined` outcome means the gate said no → we do NOT close.
  const outcome = await sendAndRecord(
    {
      email: {
        to: args.target.replyTo,
        from: args.fromEmail,
        subject: args.subject,
        body: args.body,
      },
      threadId: args.target.threadId,
      searchProfileId: args.searchProfileId,
      inReplyToGmailId: args.target.gmailThreadId,
    },
    // Only pass `adapter` when one was injected — under exactOptionalPropertyTypes
    // an explicit `undefined` is not assignable to the optional field.
    args.adapter === undefined
      ? { approver: args.approver, runId: args.runId, db: args.db }
      : { approver: args.approver, runId: args.runId, db: args.db, adapter: args.adapter },
  );
  if (outcome.kind === "declined") {
    return { kind: "short_circuit", reconcileHint: "gate_declined" };
  }

  // 2) The LOCAL close+suppress in ONE txn — runs on approve whether the send
  //    was `sent` (offline) or `blocked` (BLOCK=1). Deterministic suppression
  //    id → idempotent (a re-run is a no-op via ON CONFLICT DO NOTHING).
  const suppressionId = `closeout:${args.searchProfileId}:${args.target.dealerId}`;
  const reason = `closeout:${args.searchProfileId}`;
  const txn = args.db.$client.transaction(() => {
    if (args.target.threadId !== null) {
      args.db.$client.prepare(CLOSE_THREAD).run(args.target.threadId);
    }
    args.db.$client
      .prepare(INSERT_CLOSEOUT_SUPPRESSION)
      .run(
        suppressionId,
        args.target.threadId,
        args.target.dealerId,
        args.target.gmailThreadId,
        reason,
        new Date().toISOString(),
        args.searchProfileId,
      );
  });
  txn();

  return {
    kind: "closed",
    messageRowId: "messageRowId" in outcome ? outcome.messageRowId : null,
    sendBlocked: outcome.kind !== "sent",
  };
}
