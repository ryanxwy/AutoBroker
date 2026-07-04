/**
 * Unit tests — RealGmailAdapter against a MOCKED gmail client (zero network).
 * The adapter is constructed with an injected `GmailApiClient` stub so the
 * wire→canonical mapping is proven deterministically:
 *   - search lists messages and groups them into ThreadRefs (in result order);
 *   - getThread / getMessage map the payload (via the MIME walk) + headers +
 *     internalDate + SENT-label direction;
 *   - downloadAttachment base64url-decodes the attachment bytes;
 *   - historyList flattens changed ids + reports the new historyId;
 *   - historyList on a 404 returns { expired: true } (never throws);
 *   - getCurrentHistoryId reads users.getProfile().historyId (NOT a timestamp);
 *   - send forwards the raw and returns the backend id;
 *   - health never throws (ok on success, { ok:false } on error).
 *
 * No live Gmail, no auth, no disk — the stub IS the API surface.
 */

import { describe, expect, it, vi } from "vitest";

import { RealGmailAdapter, type GmailApiClient } from "./adapter.js";
import type { gmail_v1 } from "@googleapis/gmail";

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** A 404-shaped error like Gaxios raises on a stale startHistoryId. */
function notFoundError(): Error {
  const err = new Error("Requested entity was not found.") as Error & { status: number };
  err.status = 404;
  return err;
}

/** Build a stub client; each method defaults to a benign value and can be
 *  overridden per test. */
function stubClient(overrides: Partial<DeepStub> = {}): { client: GmailApiClient; calls: Calls } {
  const calls: Calls = {};
  const client = {
    users: {
      getProfile: vi.fn(async (p: { userId: string }) => {
        calls.getProfile = p;
        return { data: (overrides.profile ?? { historyId: "1000", messagesTotal: 7 }) as gmail_v1.Schema$Profile };
      }),
      messages: {
        list: vi.fn(async (p: { userId: string; q?: string; maxResults?: number }) => {
          calls.list = p;
          return { data: (overrides.list ?? {}) as gmail_v1.Schema$ListMessagesResponse };
        }),
        get: vi.fn(async (p: { userId: string; id: string; format?: string }) => {
          calls.get = p;
          return { data: (overrides.message ?? { id: p.id }) as gmail_v1.Schema$Message };
        }),
        send: vi.fn(async (p: { userId: string; requestBody: { raw: string } }) => {
          calls.send = p;
          return { data: (overrides.sent ?? { id: "sent-1" }) as gmail_v1.Schema$Message };
        }),
        attachments: {
          get: vi.fn(async (p: { userId: string; messageId: string; id: string }) => {
            calls.attachment = p;
            return { data: (overrides.attachment ?? { data: b64url("bytes") }) as gmail_v1.Schema$MessagePartBody };
          }),
        },
      },
      threads: {
        get: vi.fn(async (p: { userId: string; id: string; format?: string }) => {
          calls.thread = p;
          return { data: (overrides.thread ?? { messages: [] }) as gmail_v1.Schema$Thread };
        }),
      },
      history: {
        list: vi.fn(async (p: { userId: string; startHistoryId: string }) => {
          calls.history = p;
          if (overrides.historyThrows) throw notFoundError();
          return { data: (overrides.history ?? { historyId: "2000", history: [] }) as gmail_v1.Schema$ListHistoryResponse };
        }),
      },
    },
  } as unknown as GmailApiClient;
  return { client, calls };
}

interface Calls {
  getProfile?: unknown;
  list?: unknown;
  get?: unknown;
  send?: unknown;
  attachment?: unknown;
  thread?: unknown;
  history?: unknown;
}

interface DeepStub {
  profile: gmail_v1.Schema$Profile;
  list: gmail_v1.Schema$ListMessagesResponse;
  message: gmail_v1.Schema$Message;
  sent: gmail_v1.Schema$Message;
  attachment: gmail_v1.Schema$MessagePartBody;
  thread: gmail_v1.Schema$Thread;
  history: gmail_v1.Schema$ListHistoryResponse;
  historyThrows: boolean;
}

/** A full-format message payload fixture: headers + a plain/html alternative +
 *  one pdf attachment. */
function messageFixture(opts: { id: string; threadId: string; sent?: boolean }): gmail_v1.Schema$Message {
  return {
    id: opts.id,
    threadId: opts.threadId,
    internalDate: "1700000000000",
    labelIds: opts.sent === true ? ["SENT"] : ["INBOX"],
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "dealer@example.com" },
        { name: "To", value: "buyer@example.com" },
        { name: "Subject", value: "Your quote" },
        { name: "Message-ID", value: `<${opts.id}@mail.dealer.example>` },
      ],
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64url("plain text") } },
            { mimeType: "text/html", body: { data: b64url("<p>html</p>") } },
          ],
        },
        { mimeType: "application/pdf", filename: "q.pdf", body: { attachmentId: "a1", size: 99 } },
      ],
    },
  };
}

describe("RealGmailAdapter — read mapping", () => {
  it("getMessage maps headers, body, attachments, direction, internalDate", async () => {
    const { client, calls } = stubClient({ message: messageFixture({ id: "m1", threadId: "t1" }) });
    const adapter = new RealGmailAdapter({ client });

    const msg = await adapter.getMessage("m1");

    expect(msg).toEqual({
      messageId: "m1",
      threadId: "t1",
      direction: "inbound",
      from: "dealer@example.com",
      to: "buyer@example.com",
      subject: "Your quote",
      rfcMessageId: "<m1@mail.dealer.example>",
      bodyText: "plain text",
      bodyHtml: "<p>html</p>",
      internalDateMs: 1_700_000_000_000,
      attachments: [{ attachmentId: "a1", filename: "q.pdf", mimeType: "application/pdf", sizeBytes: 99 }],
    });
    expect(calls.get).toEqual({ userId: "me", id: "m1", format: "full" });
  });

  it("labels a SENT message outbound", async () => {
    const { client } = stubClient({ message: messageFixture({ id: "m2", threadId: "t2", sent: true }) });
    const adapter = new RealGmailAdapter({ client });
    const msg = await adapter.getMessage("m2");
    expect(msg.direction).toBe("outbound");
  });

  it("search groups messages into ThreadRefs in result order", async () => {
    const { client, calls } = stubClient({
      list: {
        messages: [
          { id: "m1", threadId: "tA" },
          { id: "m2", threadId: "tB" },
          { id: "m3", threadId: "tA" },
        ],
      },
    });
    const adapter = new RealGmailAdapter({ client });

    const refs = await adapter.search("newer_than:2d from:dealer", 50);

    expect(refs).toEqual([
      { threadId: "tA", messageIds: ["m1", "m3"] },
      { threadId: "tB", messageIds: ["m2"] },
    ]);
    expect(calls.list).toEqual({ userId: "me", q: "newer_than:2d from:dealer", maxResults: 50 });
  });

  it("search returns [] when the API lists no messages", async () => {
    const { client } = stubClient({ list: {} });
    const adapter = new RealGmailAdapter({ client });
    expect(await adapter.search("nothing")).toEqual([]);
  });

  it("getThread hydrates every message in the thread", async () => {
    const { client, calls } = stubClient({
      thread: {
        messages: [
          messageFixture({ id: "m1", threadId: "t1" }),
          messageFixture({ id: "m2", threadId: "t1", sent: true }),
        ],
      },
    });
    const adapter = new RealGmailAdapter({ client });

    const thread = await adapter.getThread("t1");

    expect(thread.threadId).toBe("t1");
    expect(thread.messages.map((m) => m.messageId)).toEqual(["m1", "m2"]);
    expect(thread.messages.map((m) => m.direction)).toEqual(["inbound", "outbound"]);
    expect(calls.thread).toEqual({ userId: "me", id: "t1", format: "full" });
  });

  it("downloadAttachment base64url-decodes the bytes with the ref metadata", async () => {
    const { client, calls } = stubClient({ attachment: { data: b64url("PDF-CONTENT") } });
    const adapter = new RealGmailAdapter({ client });

    const data = await adapter.downloadAttachment("m1", {
      attachmentId: "a1",
      filename: "q.pdf",
      mimeType: "application/pdf",
      sizeBytes: 11,
    });

    expect(data.filename).toBe("q.pdf");
    expect(data.mimeType).toBe("application/pdf");
    expect(Buffer.from(data.bytes).toString("utf8")).toBe("PDF-CONTENT");
    expect(calls.attachment).toEqual({ userId: "me", messageId: "m1", id: "a1" });
  });
});

describe("RealGmailAdapter — history + watermark", () => {
  it("historyList flattens changed ids and reports the new historyId", async () => {
    const { client, calls } = stubClient({
      history: {
        historyId: "2500",
        history: [
          { id: "h1", messagesAdded: [{ message: { id: "m10" } }] },
          { id: "h2", messagesAdded: [{ message: { id: "m11" } }, { message: { id: "m12" } }] },
        ],
      },
    });
    const adapter = new RealGmailAdapter({ client });

    const page = await adapter.historyList("2000");

    expect(page.expired).toBe(false);
    expect(page.newHistoryId).toBe("2500");
    expect(page.records.flatMap((r) => r.messageIds)).toEqual(["m10", "m11", "m12"]);
    expect(calls.history).toEqual({ userId: "me", startHistoryId: "2000" });
  });

  it("historyList returns { expired: true } on a 404 — never throws", async () => {
    const { client } = stubClient({ historyThrows: true });
    const adapter = new RealGmailAdapter({ client });

    const page = await adapter.historyList("stale-id");

    expect(page).toEqual({ expired: true, records: [], newHistoryId: null });
  });

  it("historyList rethrows a non-404 error", async () => {
    const { client } = stubClient();
    // Override history.list to throw a 500-shaped error.
    (client.users.history.list as unknown) = vi.fn(async () => {
      const err = new Error("backend boom") as Error & { status: number };
      err.status = 500;
      throw err;
    });
    const adapter = new RealGmailAdapter({ client });
    await expect(adapter.historyList("x")).rejects.toThrow("backend boom");
  });

  it("getCurrentHistoryId reads users.getProfile().historyId (not a clock)", async () => {
    const { client, calls } = stubClient({ profile: { historyId: "99999" } });
    const adapter = new RealGmailAdapter({ client });

    expect(await adapter.getCurrentHistoryId()).toBe("99999");
    expect(calls.getProfile).toEqual({ userId: "me" });
  });
});

describe("RealGmailAdapter — send + health", () => {
  it("send forwards the raw to users.messages.send and returns the backend id", async () => {
    const { client, calls } = stubClient({ sent: { id: "real-id-7" } });
    const adapter = new RealGmailAdapter({ client });

    const res = await adapter.send("BASE64URL-RAW");

    expect(res).toEqual({ messageId: "real-id-7" });
    expect(calls.send).toEqual({ userId: "me", requestBody: { raw: "BASE64URL-RAW" } });
  });

  it("health reports ok with a message count on success", async () => {
    const { client } = stubClient({ profile: { messagesTotal: 42, historyId: "1" } });
    const adapter = new RealGmailAdapter({ client });
    expect(await adapter.health()).toEqual({ ok: true, detail: "gmail: 42 messages" });
  });

  it("health never throws — returns { ok:false, detail } on error", async () => {
    const { client } = stubClient();
    (client.users.getProfile as unknown) = vi.fn(async () => {
      throw new Error("token expired");
    });
    const adapter = new RealGmailAdapter({ client });
    expect(await adapter.health()).toEqual({ ok: false, detail: "token expired" });
  });
});

describe("RealGmailAdapter — service factory", () => {
  it("builds the client lazily from the factory exactly once", async () => {
    const { client } = stubClient({ profile: { historyId: "5" } });
    const factory = vi.fn(() => client);
    const adapter = new RealGmailAdapter({ serviceFactory: factory });

    await adapter.getCurrentHistoryId();
    await adapter.getCurrentHistoryId();

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("throws when neither a client nor a factory is provided", async () => {
    const adapter = new RealGmailAdapter();
    await expect(adapter.getCurrentHistoryId()).rejects.toThrow(/no gmail client/);
  });
});
