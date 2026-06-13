/**
 * FakeGmailAdapter — the deterministic, local-only Gmail backend.
 *
 * It implements the SAME `GmailAdapter` contract as the live backend, so every
 * consumer (the send seam, the sync engine, the per-message extractor, the
 * Settings health probe) is byte-for-byte agnostic to which backend is live;
 * swapping fake↔real is a factory-string change, never a consumer edit.
 *
 * STORAGE: the four fake_mailbox_* / sandbox_state tables — a SEPARATE sandbox
 * from the PRODUCT email tables (threads / messages / message_attachments). The
 * fake never reads or writes a product row. Bytes are reached through the raw
 * better-sqlite3 handle (db.$client), the same way the sibling tools-layer
 * writers do — the tools layer must not import drizzle-orm operators.
 *
 * MUTATION POSTURE: `send(raw)` is the only write a consumer triggers. For the
 * fake it is NOT a real external send — it writes one outbound sandbox row with
 * a monotonic `internalDateMs` and returns a synthetic id. The L2 gate + the
 * BLOCK fuse that wrap a real send live in the send seam (gmail.ts), not here;
 * the fake performs no network I/O on any path.
 *
 * WATERMARK: a Gmail `historyId` is an opaque server cursor. The fake models it
 * as the max `internalDateMs` it has stored (its monotonic clock), so
 * `getCurrentHistoryId()` returns that ceiling and `historyList(startId)`
 * reports every message strictly newer than `startId`. The fake never reports
 * `expired` — its history never rolls off.
 */

import { getDb, type Db } from "@autobroker/db";

import type {
  AttachmentData,
  AttachmentRef,
  GmailAdapter,
  HealthResult,
  HistoryPage,
  HistoryRecord,
  Message,
  MessageDirection,
  Thread,
  ThreadRef,
} from "./types.js";

// ---------------------------------------------------------------------------
// Row shapes (the raw better-sqlite3 results) + parsed-message mapping
// ---------------------------------------------------------------------------

interface MessageRow {
  message_id: string;
  thread_id: string;
  raw: string;
  to: string;
  from: string;
  subject: string | null;
  internal_date_ms: number;
  direction: string;
  is_delivered: number;
  search_profile_id: string | null;
}

interface AttachmentRow {
  attachment_id: string;
  message_id: string;
  filename: string;
  mime_type: string;
  size: number;
  data_base64: string;
}

const SELECT_MESSAGE = "SELECT * FROM fake_mailbox_messages WHERE message_id = ?";
const SELECT_THREAD_MESSAGES =
  "SELECT * FROM fake_mailbox_messages WHERE thread_id = ? ORDER BY internal_date_ms ASC, message_id ASC";
const SELECT_ATTACHMENTS = "SELECT * FROM fake_mailbox_attachments WHERE message_id = ?";
const SELECT_ATTACHMENT =
  "SELECT * FROM fake_mailbox_attachments WHERE message_id = ? AND attachment_id = ?";
const SELECT_MAX_DATE = "SELECT MAX(internal_date_ms) AS m FROM fake_mailbox_messages";
const SELECT_COUNT = "SELECT COUNT(*) AS n FROM fake_mailbox_messages";
const SELECT_NEWER =
  "SELECT * FROM fake_mailbox_messages WHERE internal_date_ms > ? ORDER BY internal_date_ms ASC, message_id ASC";

const INSERT_THREAD =
  "INSERT INTO fake_mailbox_threads (thread_id, subject, search_profile_id) VALUES (?, ?, ?) " +
  "ON CONFLICT(thread_id) DO NOTHING";
const INSERT_MESSAGE =
  "INSERT INTO fake_mailbox_messages " +
  "(message_id, thread_id, raw, `to`, `from`, subject, internal_date_ms, direction, is_delivered, search_profile_id) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)";

/**
 * Pull the simple top-level header off a decoded RFC-2822 message. The send seam
 * assembles `To:`/`From:`/`Subject:` as unfolded top-level headers, so a flat
 * line scan over the header block is enough to recover them for the row — the
 * fake does not need a full MIME parse for outbound store.
 */
function readHeader(rfc2822: string, name: string): string {
  const headerBlock = rfc2822.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const prefix = `${name.toLowerCase()}:`;
  for (const line of headerBlock.split(/\r?\n/)) {
    if (line.toLowerCase().startsWith(prefix)) {
      return line.slice(line.indexOf(":") + 1).trim();
    }
  }
  return "";
}

/** Map a stored row to the canonical parsed Message the contract returns. The
 *  fake stores only the raw header set on send, so bodyText/bodyHtml come from
 *  decoding the raw; attachments are listed from the side table. */
function rowToMessage(db: Db, row: MessageRow): Message {
  const rfc2822 = Buffer.from(row.raw, "base64url").toString("utf8");
  const bodyText = rfc2822.split(/\r?\n\r?\n/).slice(1).join("\n\n");
  const attachments: AttachmentRef[] = (
    db.$client.prepare(SELECT_ATTACHMENTS).all(row.message_id) as AttachmentRow[]
  ).map((a) => ({
    attachmentId: a.attachment_id,
    filename: a.filename,
    mimeType: a.mime_type,
    sizeBytes: a.size,
  }));
  return {
    messageId: row.message_id,
    threadId: row.thread_id,
    direction: row.direction as MessageDirection,
    from: row.from,
    to: row.to,
    subject: row.subject ?? "",
    bodyText,
    bodyHtml: "",
    internalDateMs: row.internal_date_ms,
    attachments,
  };
}

export class FakeGmailAdapter implements GmailAdapter {
  private readonly db: Db;

  constructor(db: Db = getDb()) {
    this.db = db;
  }

  // ── read paths ──────────────────────────────────────────────────────────

  /**
   * Find threads whose any message matches the query. The fake supports a
   * pragmatic subset: a substring match over subject/from/to (case-insensitive),
   * plus the `newer_than:Nd|Nh` window the sync resync path passes. An empty
   * query returns every thread. Read-only, no gate.
   */
  search(query: string, maxResults = 100): Promise<ThreadRef[]> {
    const rows = this.db.$client
      .prepare("SELECT * FROM fake_mailbox_messages ORDER BY internal_date_ms ASC, message_id ASC")
      .all() as MessageRow[];

    const minDateMs = parseNewerThan(query);
    const term = stripNewerThan(query).trim().toLowerCase();

    const byThread = new Map<string, string[]>();
    for (const row of rows) {
      if (minDateMs !== null && row.internal_date_ms < minDateMs) continue;
      if (term !== "" && !rowMatchesTerm(row, term)) continue;
      const ids = byThread.get(row.thread_id) ?? [];
      ids.push(row.message_id);
      byThread.set(row.thread_id, ids);
    }

    const refs: ThreadRef[] = [...byThread.entries()].map(([threadId, messageIds]) => ({
      threadId,
      messageIds,
    }));
    return Promise.resolve(refs.slice(0, maxResults));
  }

  getThread(threadId: string): Promise<Thread> {
    const rows = this.db.$client.prepare(SELECT_THREAD_MESSAGES).all(threadId) as MessageRow[];
    const messages = rows.map((r) => rowToMessage(this.db, r));
    return Promise.resolve({ threadId, messages });
  }

  getMessage(messageId: string): Promise<Message> {
    const row = this.db.$client.prepare(SELECT_MESSAGE).get(messageId) as MessageRow | undefined;
    if (row === undefined) {
      return Promise.reject(new Error(`fake mailbox: no message ${messageId}`));
    }
    return Promise.resolve(rowToMessage(this.db, row));
  }

  downloadAttachment(messageId: string, ref: AttachmentRef): Promise<AttachmentData> {
    const row = this.db.$client
      .prepare(SELECT_ATTACHMENT)
      .get(messageId, ref.attachmentId) as AttachmentRow | undefined;
    if (row === undefined) {
      return Promise.reject(
        new Error(`fake mailbox: no attachment ${ref.attachmentId} on message ${messageId}`),
      );
    }
    return Promise.resolve({
      filename: row.filename,
      mimeType: row.mime_type,
      bytes: new Uint8Array(Buffer.from(row.data_base64, "base64")),
    });
  }

  /**
   * Incremental history since `startHistoryId`: every stored message strictly
   * newer than the start cursor, plus the current ceiling as the new watermark.
   * The fake's history never rolls off, so `expired` is always false. A
   * malformed/non-numeric start is treated as 0 (report everything).
   */
  historyList(startHistoryId: string): Promise<HistoryPage> {
    const start = Number.parseInt(startHistoryId, 10);
    const floor = Number.isFinite(start) ? start : 0;
    const rows = this.db.$client.prepare(SELECT_NEWER).all(floor) as MessageRow[];
    const records: HistoryRecord[] = rows.map((r) => ({ messageIds: [r.message_id] }));
    const newHistoryId = this.maxDateMs().toString();
    return Promise.resolve({ expired: false, records, newHistoryId });
  }

  /** The fake's monotonic clock floor — the max stored `internalDateMs` (0 when
   *  empty). The contract returns it as a string (an opaque cursor). */
  getCurrentHistoryId(): Promise<string> {
    return Promise.resolve(this.maxDateMs().toString());
  }

  // ── the single mutation ───────────────────────────────────────────────────

  /**
   * Store the assembled base64url `raw` as one OUTBOUND sandbox row with a
   * monotonic `internalDateMs` (strictly greater than every prior row, so the
   * watermark ordering never ties), and return a synthetic id. This is NOT a
   * real send — the fake performs no network I/O; the L2 gate + BLOCK fuse that
   * wrap a real send live in the send seam, not here.
   */
  send(raw: string): Promise<{ messageId: string }> {
    const rfc2822 = Buffer.from(raw, "base64url").toString("utf8");
    const to = readHeader(rfc2822, "To");
    const from = readHeader(rfc2822, "From");
    const subject = readHeader(rfc2822, "Subject");

    // Monotonic: one tick past the current ceiling so two sends in the same
    // millisecond still order strictly — the watermark proof depends on it.
    const internalDateMs = this.maxDateMs() + 1;
    const messageId = `fake-msg-${internalDateMs}`;
    const threadId = `fake-thread-${internalDateMs}`;

    const txn = this.db.$client.transaction(() => {
      this.db.$client.prepare(INSERT_THREAD).run(threadId, subject === "" ? null : subject, null);
      this.db.$client
        .prepare(INSERT_MESSAGE)
        .run(
          messageId,
          threadId,
          raw,
          to,
          from,
          subject === "" ? null : subject,
          internalDateMs,
          "outbound",
          null,
        );
    });
    txn();

    return Promise.resolve({ messageId });
  }

  // ── liveness ───────────────────────────────────────────────────────────────

  /** Never throws — a stored-message count is the success detail; a query
   *  failure (e.g. the migration not applied) is reported as `{ ok: false }`. */
  health(): Promise<HealthResult> {
    try {
      const row = this.db.$client.prepare(SELECT_COUNT).get() as { n: number };
      return Promise.resolve({ ok: true, detail: `fake mailbox: ${row.n} messages` });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return Promise.resolve({ ok: false, detail });
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private maxDateMs(): number {
    const row = this.db.$client.prepare(SELECT_MAX_DATE).get() as { m: number | null };
    return row.m ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Query helpers — the pragmatic search subset the fake supports
// ---------------------------------------------------------------------------

const NEWER_THAN_RE = /\bnewer_than:(\d+)([dh])\b/i;

/** Resolve a `newer_than:Nd|Nh` clause to a min epoch-ms relative to now, or
 *  null when the query carries no window clause. */
function parseNewerThan(query: string): number | null {
  const m = NEWER_THAN_RE.exec(query);
  if (m === null) return null;
  const n = Number.parseInt(m[1] as string, 10);
  const unitMs = (m[2] as string).toLowerCase() === "d" ? 86_400_000 : 3_600_000;
  return Date.now() - n * unitMs;
}

/** Drop the `newer_than:` clause so the remaining text is the free-text term. */
function stripNewerThan(query: string): string {
  return query.replace(NEWER_THAN_RE, "");
}

/** Case-insensitive substring match over the addressable header fields. */
function rowMatchesTerm(row: MessageRow, term: string): boolean {
  const haystack = `${row.subject ?? ""} ${row.from} ${row.to}`.toLowerCase();
  return haystack.includes(term);
}
