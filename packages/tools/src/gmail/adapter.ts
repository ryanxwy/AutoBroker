/**
 * RealGmailAdapter — the live @googleapis/gmail backend behind the shared
 * GmailAdapter contract.
 *
 * It maps the wire JSON (and the MIME tree, via ./mime.js) into the canonical
 * parsed shapes every consumer depends on, so swapping fake↔real is a
 * factory-string change, never a consumer edit. Read methods are free (no gate);
 * `send` is the single mutation and only ever runs behind the L2 gate + the
 * BLOCK fuse that the send seam (gmail.ts) wraps around it — this adapter does
 * NOT itself enforce the gate.
 *
 * TESTABILITY: the adapter takes a thin `GmailApiClient` (just the API methods
 * it calls) so a unit test can inject a stub and exercise the mapping with ZERO
 * network. Production wires the real client lazily from the authorized OAuth2
 * client (see `createRealGmailAdapter`). The lazy `_service()` factory is only
 * the default path; an injected client skips it entirely.
 *
 * HISTORY EXPIRY: Gmail answers a stale startHistoryId with HTTP 404. The
 * contract turns that into `{ expired: true }` (never throws) so the sync layer
 * full-resyncs; every other API error propagates.
 *
 * historyId IS NOT A TIMESTAMP: the watermark floor comes from
 * users.getProfile().historyId (an opaque server cursor), never a clock value.
 */

import { gmail as gmailApi, type gmail_v1 } from "@googleapis/gmail";

import { stripHtmlToText } from "../html/htmlToText.js";
import { loadAuthorizedClient } from "./auth.js";
import { walkParts } from "./mime.js";
import type {
  AttachmentData,
  AttachmentRef,
  GmailAdapter,
  GmailBackend,
  HealthResult,
  HistoryPage,
  HistoryRecord,
  Message,
  MessageDirection,
  Thread,
  ThreadRef,
} from "./types.js";

/** The mailbox owner's own address, used to label a message inbound vs
 *  outbound. Resolved once from the profile on first use. */
const ME = "me";

/**
 * The thin slice of the gmail API the adapter calls — exactly the methods used,
 * nothing more, so a test stub is small and the production gmail client (which
 * is structurally a superset) drops in unchanged.
 */
export interface GmailApiClient {
  users: {
    getProfile(params: { userId: string }): Promise<{ data: gmail_v1.Schema$Profile }>;
    messages: {
      list(params: {
        userId: string;
        q?: string;
        maxResults?: number;
      }): Promise<{ data: gmail_v1.Schema$ListMessagesResponse }>;
      get(params: {
        userId: string;
        id: string;
        format?: string;
      }): Promise<{ data: gmail_v1.Schema$Message }>;
      send(params: {
        userId: string;
        requestBody: { raw: string };
      }): Promise<{ data: gmail_v1.Schema$Message }>;
      attachments: {
        get(params: {
          userId: string;
          messageId: string;
          id: string;
        }): Promise<{ data: gmail_v1.Schema$MessagePartBody }>;
      };
    };
    threads: {
      get(params: {
        userId: string;
        id: string;
        format?: string;
      }): Promise<{ data: gmail_v1.Schema$Thread }>;
    };
    history: {
      list(params: {
        userId: string;
        startHistoryId: string;
      }): Promise<{ data: gmail_v1.Schema$ListHistoryResponse }>;
    };
  };
}

/** True when an error is a Gmail HTTP 404 (the documented stale-historyId
 *  signal). Reads the Gaxios-style `status`/`code`/response status without
 *  importing gaxios. */
function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  return e.status === 404 || e.code === 404 || e.response?.status === 404;
}

/** Read a single header value off the top-level payload headers. */
function readHeader(payload: gmail_v1.Schema$MessagePart | undefined, name: string): string {
  const headers = payload?.headers ?? [];
  const lower = name.toLowerCase();
  for (const h of headers) {
    if ((h.name ?? "").toLowerCase() === lower) return h.value ?? "";
  }
  return "";
}

/** Map a wire Schema$Message (format=full) into the canonical parsed Message.
 *  `direction` is decided from the SENT label (outbound) when present. */
function mapMessage(wire: gmail_v1.Schema$Message): Message {
  const payload = wire.payload ?? undefined;
  const { bodyText, bodyHtml, attachments } = walkParts(payload);
  // HTML-only dealer emails carry a text/html part with NO text/plain part, so
  // walkParts returns an empty bodyText and the quote text would be silently
  // lost downstream. When bodyText is blank (or whitespace-only), recover the
  // readable text from the HTML so consumers still see the quote.
  const effectiveBodyText = bodyText.trim() !== "" ? bodyText : stripHtmlToText(bodyHtml);
  const labels = wire.labelIds ?? [];
  const direction: MessageDirection = labels.includes("SENT") ? "outbound" : "inbound";
  const internalDateMs = Number.parseInt(wire.internalDate ?? "0", 10);
  return {
    messageId: wire.id ?? "",
    threadId: wire.threadId ?? "",
    direction,
    from: readHeader(payload, "From"),
    to: readHeader(payload, "To"),
    subject: readHeader(payload, "Subject"),
    bodyText: effectiveBodyText,
    bodyHtml,
    internalDateMs: Number.isFinite(internalDateMs) ? internalDateMs : 0,
    attachments,
  };
}

export class RealGmailAdapter implements GmailAdapter {
  /** This backend is the live mailbox — a send it performs leaves the process. */
  readonly kind: GmailBackend = "real";

  private service: GmailApiClient | undefined;
  private readonly serviceFactory: (() => GmailApiClient) | undefined;

  /**
   * Construct with EITHER an explicit client (tests, or an already-built one) OR
   * a lazy factory (production — the client is built on first use so
   * construction stays cheap and side-effect free).
   */
  constructor(opts: { client?: GmailApiClient; serviceFactory?: () => GmailApiClient } = {}) {
    this.service = opts.client;
    this.serviceFactory = opts.serviceFactory;
  }

  private getService(): GmailApiClient {
    if (this.service !== undefined) return this.service;
    if (this.serviceFactory === undefined) {
      throw new Error("RealGmailAdapter: no gmail client or service factory provided");
    }
    this.service = this.serviceFactory();
    return this.service;
  }

  // ── read paths (free, no gate) ────────────────────────────────────────────

  /**
   * Find threads matching a Gmail search query. The API lists matching MESSAGES
   * (id + threadId only); we group them by thread into ThreadRefs in result
   * order, so a consumer can then hydrate on demand via getThread/getMessage.
   */
  async search(query: string, maxResults = 100): Promise<ThreadRef[]> {
    const res = await this.getService().users.messages.list({
      userId: ME,
      q: query,
      maxResults,
    });
    const byThread = new Map<string, string[]>();
    for (const m of res.data.messages ?? []) {
      const threadId = m.threadId ?? "";
      const id = m.id ?? "";
      if (threadId === "" || id === "") continue;
      const ids = byThread.get(threadId) ?? [];
      ids.push(id);
      byThread.set(threadId, ids);
    }
    return [...byThread.entries()].map(([threadId, messageIds]) => ({ threadId, messageIds }));
  }

  async getThread(threadId: string): Promise<Thread> {
    const res = await this.getService().users.threads.get({
      userId: ME,
      id: threadId,
      format: "full",
    });
    const messages = (res.data.messages ?? []).map(mapMessage);
    return { threadId, messages };
  }

  async getMessage(messageId: string): Promise<Message> {
    const res = await this.getService().users.messages.get({
      userId: ME,
      id: messageId,
      format: "full",
    });
    return mapMessage(res.data);
  }

  async downloadAttachment(messageId: string, ref: AttachmentRef): Promise<AttachmentData> {
    const res = await this.getService().users.messages.attachments.get({
      userId: ME,
      messageId,
      id: ref.attachmentId,
    });
    const data = res.data.data ?? "";
    return {
      filename: ref.filename,
      mimeType: ref.mimeType,
      bytes: new Uint8Array(Buffer.from(data, "base64url")),
    };
  }

  /**
   * Incremental history since startHistoryId. A 404 means the start watermark is
   * too old to serve → returns `{ expired: true }` (the sync layer full-resyncs)
   * rather than throwing. Otherwise flattens the per-record changed message ids
   * and reports the mailbox's current historyId as the new watermark.
   */
  async historyList(startHistoryId: string): Promise<HistoryPage> {
    let data: gmail_v1.Schema$ListHistoryResponse;
    try {
      const res = await this.getService().users.history.list({
        userId: ME,
        startHistoryId,
      });
      data = res.data;
    } catch (err) {
      if (isNotFound(err)) {
        return { expired: true, records: [], newHistoryId: null };
      }
      throw err;
    }

    const records: HistoryRecord[] = (data.history ?? []).map((h) => ({
      messageIds: collectChangedIds(h),
    }));
    return {
      expired: false,
      records,
      newHistoryId: data.historyId ?? null,
    };
  }

  /** The mailbox's current historyId floor (an opaque server cursor, NOT a
   *  timestamp) — the watermark to adopt after a full resync. */
  async getCurrentHistoryId(): Promise<string> {
    const res = await this.getService().users.getProfile({ userId: ME });
    return res.data.historyId ?? "0";
  }

  // ── the single mutation (gate-wrapped by the send seam, not here) ──────────

  /**
   * POST the assembled base64url raw RFC-2822 message via users.messages.send.
   * This reaches the network — it must only ever be called from inside the
   * send seam's approved gate commit, after the BLOCK fuse. This adapter does
   * not assert the fuse itself (that wall lives in the seam, kept FIRST).
   */
  async send(raw: string): Promise<{ messageId: string }> {
    const res = await this.getService().users.messages.send({
      userId: ME,
      requestBody: { raw },
    });
    return { messageId: res.data.id ?? "" };
  }

  // ── liveness (never throws) ────────────────────────────────────────────────

  async health(): Promise<HealthResult> {
    try {
      const res = await this.getService().users.getProfile({ userId: ME });
      const total = res.data.messagesTotal ?? 0;
      return { ok: true, detail: `gmail: ${total} messages` };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, detail };
    }
  }
}

/**
 * Production wiring: a RealGmailAdapter whose client is built lazily from the
 * persisted token (the authorized OAuth2 client + the gmail API factory). The
 * client is constructed on first use — construction here is side-effect free, so
 * importing the adapter never touches disk or the network. The live gmail client
 * is a structural superset of GmailApiClient, so it satisfies the thin interface.
 */
export function createRealGmailAdapter(): RealGmailAdapter {
  return new RealGmailAdapter({
    serviceFactory: () =>
      gmailApi({ version: "v1", auth: loadAuthorizedClient() }) as unknown as GmailApiClient,
  });
}

/** Collect the changed message ids from one history record. messagesAdded is
 *  the relevant change type for the inbox sync; we also fold the generic
 *  `messages` list (the API may duplicate, the sync layer dedupes downstream). */
function collectChangedIds(h: gmail_v1.Schema$History): string[] {
  const ids: string[] = [];
  for (const ma of h.messagesAdded ?? []) {
    const id = ma.message?.id;
    if (id !== undefined && id !== null && id !== "") ids.push(id);
  }
  for (const m of h.messages ?? []) {
    const id = m.id;
    if (id !== undefined && id !== null && id !== "") ids.push(id);
  }
  return ids;
}
