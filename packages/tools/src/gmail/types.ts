/**
 * Gmail adapter CONTRACT — the single source of the method set every Gmail
 * backend implements. The real adapter (live @googleapis/gmail + loopback auth +
 * MIME parse) and the fake adapter (local sandbox DB) BOTH implement this exact
 * interface, so every consumer (the send seam, the inbox sync layer, the
 * per-message reply extractor) depends only on this shape — never on a concrete
 * backend. Swapping fake↔real is a factory-string change, not a consumer edit.
 *
 * This file is pure TYPES: no runtime value, no I/O, no DB, no network. It is the
 * disjoint boundary that lets the real arm, the fake arm, and the sync arm build
 * in parallel — each imports only `import type` from here.
 *
 * The canonical domain types below (Message / Thread / Attachment refs) are the
 * adapter's OWN parsed shapes, NOT the raw Gmail API JSON. A real adapter maps
 * the wire JSON (and the MIME tree) into these; the fake adapter builds them from
 * its sandbox rows. Consumers see one stable shape regardless of backend. Keep
 * every field flat and explicit (no nested wire envelopes) so the contract reads
 * the same on both sides.
 */

// ---------------------------------------------------------------------------
// Canonical domain types — the adapter's parsed return shapes
// ---------------------------------------------------------------------------

/** Inbound vs outbound, from the mailbox owner's point of view. */
export type MessageDirection = "inbound" | "outbound";

/**
 * A reference to one attachment part inside a message — enough to fetch its
 * bytes later via `downloadAttachment(messageId, ref)` without re-walking the
 * MIME tree. `attachmentId` is the backend's opaque handle (the Gmail
 * `body.attachmentId` on the real side; a synthetic id on the fake side).
 */
export interface AttachmentRef {
  /** Opaque backend handle used to fetch the bytes. */
  attachmentId: string;
  /** Original filename as declared in the part headers (may be empty). */
  filename: string;
  /** Declared MIME type (e.g. "application/pdf", "image/png"). */
  mimeType: string;
  /** Declared size in bytes (0 when the backend does not report it). */
  sizeBytes: number;
}

/** Downloaded attachment bytes plus the resolved metadata. */
export interface AttachmentData {
  filename: string;
  mimeType: string;
  /** Decoded raw bytes (base64url already decoded). */
  bytes: Uint8Array;
}

/**
 * One parsed message. `bodyText` is the first text/plain part; `bodyHtml` is the
 * first text/html part; either may be empty when absent. `attachments` lists
 * every part that carries a `body.attachmentId`. `internalDateMs` is the
 * backend's authoritative receive timestamp in epoch-ms (the monotonic ordering
 * key the fake side guarantees and the sync watermark trusts).
 */
export interface Message {
  messageId: string;
  threadId: string;
  direction: MessageDirection;
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  internalDateMs: number;
  attachments: AttachmentRef[];
}

/** A lightweight thread pointer returned by `search` — id + message ids only.
 *  Full per-message content is fetched on demand via `getThread`/`getMessage`. */
export interface ThreadRef {
  threadId: string;
  messageIds: string[];
}

/** A fully hydrated thread — its messages in receive order. */
export interface Thread {
  threadId: string;
  messages: Message[];
}

/**
 * One history delta — the messages whose state changed since a prior
 * `historyId`. The sync layer only needs the changed message ids plus the new
 * watermark; it leaves the local "is this relevant?" predicate to the consumer
 * (inbox skill), per the layering split.
 */
export interface HistoryRecord {
  /** Message ids added/changed in this history step. */
  messageIds: string[];
}

/** The result of one `historyList` page from a backend. `expired === true` means
 *  the backend reported the start watermark is too old to serve (the real Gmail
 *  API answers 404 here); the sync layer treats that as the documented
 *  full-resync trigger, never an error. */
export interface HistoryPage {
  /** True when the start `historyId` was stale/expired (real Gmail → HTTP 404). */
  expired: boolean;
  /** History deltas since the start watermark (empty when nothing changed). */
  records: HistoryRecord[];
  /** The newest `historyId` the backend knows — the watermark to advance to.
   *  Null when `expired` (the caller must full-resync to learn the new floor). */
  newHistoryId: string | null;
}

/** A liveness probe result. `health()` NEVER throws — a dead/unconfigured
 *  backend returns `{ ok: false, detail }` so the caller can render it. */
export interface HealthResult {
  ok: boolean;
  /** Human-readable status (a message count on success; the error on failure). */
  detail: string;
}

// ---------------------------------------------------------------------------
// The injected adapter interface — the C1 boundary
// ---------------------------------------------------------------------------

/**
 * Every Gmail backend implements this. Read methods are free (no gate); the
 * `send` method is the ONLY mutation and is the single fake/real switch point —
 * its real implementation reaches the network ONLY behind the L2 gate + the
 * BLOCK fuse (wired in the send seam, not here).
 *
 * Consumers (by skill):
 *   - the send seam needs `send`;
 *   - inbox_check (E1) needs `historyList` (incremental sync) + `search` +
 *     `getMessage` (the resync read path);
 *   - reply_extract (E2) needs `getMessage` / `getThread` (per-message content)
 *     + `downloadAttachment` (attachment bytes for text extraction);
 *   - the Settings card / preflight needs `health`.
 */
export interface GmailAdapter {
  /** Find threads matching a Gmail search query. Read-only, no gate. */
  search(query: string, maxResults?: number): Promise<ThreadRef[]>;

  /** Hydrate one thread (all messages, receive order). Read-only, no gate. */
  getThread(threadId: string): Promise<Thread>;

  /** Fetch one fully-parsed message. Read-only, no gate. */
  getMessage(messageId: string): Promise<Message>;

  /** Download one attachment's decoded bytes. Read-only, no gate. */
  downloadAttachment(messageId: string, ref: AttachmentRef): Promise<AttachmentData>;

  /**
   * Incremental history since `startHistoryId`. Returns the changed message ids
   * and the new watermark; signals `expired` (Gmail 404) instead of throwing so
   * the sync layer can full-resync. Read-only, no gate.
   */
  historyList(startHistoryId: string): Promise<HistoryPage>;

  /** The mailbox's current historyId floor — the watermark to adopt after a full
   *  resync (search returns threads, not a historyId). Real adapter →
   *  users.getProfile().historyId; fake adapter → its max internalDateMs / monotonic
   *  counter. */
  getCurrentHistoryId(): Promise<string>;

  /**
   * The single mutation. Takes the assembled base64url `raw` RFC-2822 message
   * and returns the backend message id. The real backend asserts the BLOCK fuse
   * first and only ever runs inside an approved gate commit; the fake backend
   * writes a sandbox row. This interface does NOT itself enforce the gate — the
   * send seam wraps every call through L2 (see the gmail send tool).
   */
  send(raw: string): Promise<{ messageId: string }>;

  /** Liveness probe. MUST NOT throw — returns `{ ok: false, detail }` on failure. */
  health(): Promise<HealthResult>;
}
