/**
 * L1 unit tests — the FakeGmailAdapter, the deterministic local Gmail backend.
 * Pure/deterministic, no network. Freezes:
 *   - send() writes one OUTBOUND sandbox row, parses To/From/Subject off the
 *     raw, and returns a synthetic id;
 *   - successive sends carry STRICTLY INCREASING internalDateMs (the watermark
 *     ordering proof) — even within the same millisecond;
 *   - getMessage / getThread map the stored rows to the canonical shape and
 *     decode the body off the raw;
 *   - search supports the substring term + the `newer_than:` window subset;
 *   - downloadAttachment returns the decoded bytes from the side table;
 *   - historyList reports only rows strictly newer than the start cursor and
 *     advances the watermark; getCurrentHistoryId is the max internalDateMs;
 *   - health() never throws and reports a message count;
 *   - the fake never writes a PRODUCT email row (sandbox isolation);
 *   - the fake_mailbox_messages table EXISTS (the preflight's table-exists probe).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; the committed
 * migration SQL runs against the throwaway DB. NEVER touches ~/.autobroker-ts.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/db";

import { FakeGmailAdapter } from "./fakeAdapter.js";
import type { AttachmentRef } from "./types.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-gmail-fake-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0002_pale_thunderball.sql"), "utf8"));
});

afterAll(() => {
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

beforeEach(() => {
  db.$client.prepare("DELETE FROM fake_mailbox_attachments").run();
  db.$client.prepare("DELETE FROM fake_mailbox_messages").run();
  db.$client.prepare("DELETE FROM fake_mailbox_threads").run();
  db.$client.prepare("DELETE FROM sandbox_state").run();
});

/** Assemble the same base64url RFC-2822 raw the send seam produces, so the
 *  fake parses headers off the exact byte shape it will see in production. */
function buildRaw(to: string, from: string, subject: string, body: string): string {
  const rfc2822 =
    `To: ${to}\r\n` + `From: ${from}\r\n` + `Subject: ${subject}\r\n` + `\r\n` + body;
  return Buffer.from(rfc2822, "utf8").toString("base64url");
}

/** Seed one inbound sandbox row directly (the harness seam does this at scale);
 *  used to exercise the read paths without going through send. */
function seedInbound(opts: {
  messageId: string;
  threadId: string;
  to: string;
  from: string;
  subject: string;
  body: string;
  internalDateMs: number;
  profileId?: string | null;
}): void {
  const raw = buildRaw(opts.to, opts.from, opts.subject, opts.body);
  db.$client
    .prepare(
      "INSERT INTO fake_mailbox_threads (thread_id, subject, search_profile_id) VALUES (?, ?, ?) ON CONFLICT(thread_id) DO NOTHING",
    )
    .run(opts.threadId, opts.subject, opts.profileId ?? null);
  db.$client
    .prepare(
      "INSERT INTO fake_mailbox_messages (message_id, thread_id, raw, `to`, `from`, subject, internal_date_ms, direction, is_delivered, search_profile_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'inbound', 1, ?)",
    )
    .run(
      opts.messageId,
      opts.threadId,
      raw,
      opts.to,
      opts.from,
      opts.subject,
      opts.internalDateMs,
      opts.profileId ?? null,
    );
}

describe("FakeGmailAdapter.send", () => {
  it("writes one outbound row, parses headers off the raw, returns a synthetic id", async () => {
    const adapter = new FakeGmailAdapter(db);
    const raw = buildRaw("dealer@x.test", "buyer@x.test", "Re: quote", "thanks, looks good");
    const { messageId } = await adapter.send(raw);

    expect(messageId).toMatch(/^fake-msg-/);
    const row = db.$client
      .prepare("SELECT * FROM fake_mailbox_messages WHERE message_id = ?")
      .get(messageId) as Record<string, unknown>;
    expect(row.direction).toBe("outbound");
    expect(row.to).toBe("dealer@x.test");
    expect(row.from).toBe("buyer@x.test");
    expect(row.subject).toBe("Re: quote");
    expect(row.is_delivered).toBe(1);
    // No real send happened — the row is purely local.
    const msg = await adapter.getMessage(messageId);
    expect(msg.bodyText).toContain("thanks, looks good");
  });

  it("successive sends carry strictly-increasing internalDateMs (monotonic watermark)", async () => {
    const adapter = new FakeGmailAdapter(db);
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const { messageId } = await adapter.send(
        buildRaw("d@x.test", "b@x.test", `s${i}`, `body ${i}`),
      );
      const row = db.$client
        .prepare("SELECT internal_date_ms AS d FROM fake_mailbox_messages WHERE message_id = ?")
        .get(messageId) as { d: number };
      ids.push(row.d);
    }
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1] as number);
    }
    // getCurrentHistoryId reflects the ceiling.
    expect(await adapter.getCurrentHistoryId()).toBe(String(ids[ids.length - 1]));
  });
});

describe("FakeGmailAdapter read paths", () => {
  it("getMessage maps a row to the canonical shape and rejects an unknown id", async () => {
    const adapter = new FakeGmailAdapter(db);
    seedInbound({
      messageId: "m1",
      threadId: "t1",
      to: "buyer@x.test",
      from: "dealer@x.test",
      subject: "Your OTD quote",
      body: "OTD is attached.",
      internalDateMs: 1000,
    });
    const msg = await adapter.getMessage("m1");
    expect(msg.messageId).toBe("m1");
    expect(msg.threadId).toBe("t1");
    expect(msg.direction).toBe("inbound");
    expect(msg.from).toBe("dealer@x.test");
    expect(msg.subject).toBe("Your OTD quote");
    expect(msg.bodyText).toContain("OTD is attached.");
    expect(msg.internalDateMs).toBe(1000);

    await expect(adapter.getMessage("nope")).rejects.toThrow(/no message/);
  });

  it("getThread returns messages in receive order", async () => {
    const adapter = new FakeGmailAdapter(db);
    seedInbound({
      messageId: "m2",
      threadId: "t2",
      to: "buyer@x.test",
      from: "dealer@x.test",
      subject: "second",
      body: "b2",
      internalDateMs: 2000,
    });
    seedInbound({
      messageId: "m1",
      threadId: "t2",
      to: "buyer@x.test",
      from: "dealer@x.test",
      subject: "first",
      body: "b1",
      internalDateMs: 1000,
    });
    const thread = await adapter.getThread("t2");
    expect(thread.messages.map((m) => m.messageId)).toEqual(["m1", "m2"]);
  });

  it("search matches a substring term and honors the newer_than window", async () => {
    const adapter = new FakeGmailAdapter(db);
    seedInbound({
      messageId: "old",
      threadId: "tOld",
      to: "buyer@x.test",
      from: "honda-dealer@x.test",
      subject: "old quote",
      body: "x",
      internalDateMs: Date.now() - 10 * 86_400_000,
    });
    seedInbound({
      messageId: "fresh",
      threadId: "tFresh",
      to: "buyer@x.test",
      from: "honda-dealer@x.test",
      subject: "fresh quote",
      body: "x",
      internalDateMs: Date.now() - 60_000,
    });
    seedInbound({
      messageId: "other",
      threadId: "tOther",
      to: "buyer@x.test",
      from: "toyota-dealer@x.test",
      subject: "unrelated",
      body: "x",
      internalDateMs: Date.now() - 60_000,
    });

    // Substring term over from/subject/to.
    const honda = await adapter.search("honda");
    expect(honda.map((t) => t.threadId).sort()).toEqual(["tFresh", "tOld"]);

    // newer_than:2d drops the 10-day-old row.
    const recentHonda = await adapter.search("honda newer_than:2d");
    expect(recentHonda.map((t) => t.threadId)).toEqual(["tFresh"]);

    // Empty query returns every thread.
    const all = await adapter.search("");
    expect(all.length).toBe(3);
  });

  it("parses field operators and ` OR ` clauses (the discovery query grammar)", async () => {
    const adapter = new FakeGmailAdapter(db);
    // A row whose FROM contains "elantra" but whose subject does not, and a row
    // whose SUBJECT contains "elantra" but whose from does not — to prove the
    // field operators are scoped to the right field.
    seedInbound({
      messageId: "mFrom",
      threadId: "tFrom",
      to: "buyer@x.test",
      from: "elantra-sales@dealer-one.test",
      subject: "your inquiry",
      body: "x",
      internalDateMs: 1000,
    });
    seedInbound({
      messageId: "mSubj",
      threadId: "tSubj",
      to: "buyer@x.test",
      from: "sales@dealer-two.test",
      subject: "Re: 2026 Elantra quote",
      body: "x",
      internalDateMs: 2000,
    });

    // from:<term> matches ONLY the from field — tFrom, not tSubj.
    const fromOnly = await adapter.search("from:elantra");
    expect(fromOnly.map((t) => t.threadId)).toEqual(["tFrom"]);

    // subject:<term> matches ONLY the subject field — tSubj, not tFrom.
    const subjOnly = await adapter.search("subject:elantra");
    expect(subjOnly.map((t) => t.threadId)).toEqual(["tSubj"]);

    // ` OR ` is a union over clauses — both threads.
    const union = await adapter.search("from:dealer-one OR from:dealer-two");
    expect(union.map((t) => t.threadId).sort()).toEqual(["tFrom", "tSubj"]);

    // A bare clause still substring-matches across subject+from+to.
    const bare = await adapter.search("elantra");
    expect(bare.map((t) => t.threadId).sort()).toEqual(["tFrom", "tSubj"]);

    // newer_than:<window> is still honored alongside an operator clause: the
    // 10-day-old row below is dropped while the fresh from-match survives.
    seedInbound({
      messageId: "mOldFrom",
      threadId: "tOldFrom",
      to: "buyer@x.test",
      from: "elantra-old@dealer-one.test",
      subject: "stale",
      body: "x",
      internalDateMs: Date.now() - 10 * 86_400_000,
    });
    seedInbound({
      messageId: "mFreshFrom",
      threadId: "tFreshFrom",
      to: "buyer@x.test",
      from: "elantra-new@dealer-one.test",
      subject: "fresh",
      body: "x",
      internalDateMs: Date.now() - 60_000,
    });
    const recent = await adapter.search("from:dealer-one newer_than:2d");
    expect(recent.map((t) => t.threadId)).toEqual(["tFreshFrom"]);
  });

  it("downloadAttachment returns the decoded bytes", async () => {
    const adapter = new FakeGmailAdapter(db);
    seedInbound({
      messageId: "mA",
      threadId: "tA",
      to: "buyer@x.test",
      from: "dealer@x.test",
      subject: "quote pdf",
      body: "see attached",
      internalDateMs: 1000,
    });
    const bytes = Buffer.from("hello-pdf-bytes");
    db.$client
      .prepare(
        "INSERT INTO fake_mailbox_attachments (attachment_id, message_id, filename, mime_type, size, data_base64) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("att1", "mA", "quote.pdf", "application/pdf", bytes.length, bytes.toString("base64"));

    const msg = await adapter.getMessage("mA");
    expect(msg.attachments).toHaveLength(1);
    const ref = msg.attachments[0] as AttachmentRef;
    expect(ref.filename).toBe("quote.pdf");
    expect(ref.mimeType).toBe("application/pdf");

    const data = await adapter.downloadAttachment("mA", ref);
    expect(Buffer.from(data.bytes).toString("utf8")).toBe("hello-pdf-bytes");
    expect(data.mimeType).toBe("application/pdf");

    await expect(
      adapter.downloadAttachment("mA", { ...ref, attachmentId: "nope" }),
    ).rejects.toThrow(/no attachment/);
  });
});

describe("FakeGmailAdapter history / watermark", () => {
  it("getCurrentHistoryId is the max internalDateMs (0 when empty)", async () => {
    const adapter = new FakeGmailAdapter(db);
    expect(await adapter.getCurrentHistoryId()).toBe("0");
    seedInbound({
      messageId: "m1",
      threadId: "t1",
      to: "b@x.test",
      from: "d@x.test",
      subject: "s",
      body: "x",
      internalDateMs: 4242,
    });
    expect(await adapter.getCurrentHistoryId()).toBe("4242");
  });

  it("historyList reports only rows strictly newer than the start, never expires", async () => {
    const adapter = new FakeGmailAdapter(db);
    seedInbound({
      messageId: "m1",
      threadId: "t1",
      to: "b@x.test",
      from: "d@x.test",
      subject: "s1",
      body: "x",
      internalDateMs: 100,
    });
    seedInbound({
      messageId: "m2",
      threadId: "t2",
      to: "b@x.test",
      from: "d@x.test",
      subject: "s2",
      body: "x",
      internalDateMs: 200,
    });
    seedInbound({
      messageId: "m3",
      threadId: "t3",
      to: "b@x.test",
      from: "d@x.test",
      subject: "s3",
      body: "x",
      internalDateMs: 300,
    });

    const page = await adapter.historyList("100");
    expect(page.expired).toBe(false);
    expect(page.records.flatMap((r) => r.messageIds)).toEqual(["m2", "m3"]);
    expect(page.newHistoryId).toBe("300");

    // A start at/after the ceiling yields no deltas.
    const none = await adapter.historyList("300");
    expect(none.records).toEqual([]);
    expect(none.expired).toBe(false);
  });
});

describe("FakeGmailAdapter health + isolation", () => {
  it("health never throws and reports a message count", async () => {
    const adapter = new FakeGmailAdapter(db);
    const empty = await adapter.health();
    expect(empty.ok).toBe(true);
    expect(empty.detail).toContain("0");

    await adapter.send(buildRaw("d@x.test", "b@x.test", "s", "body"));
    const one = await adapter.health();
    expect(one.ok).toBe(true);
    expect(one.detail).toContain("1");
  });

  it("send never writes a PRODUCT email row (sandbox isolation)", async () => {
    const adapter = new FakeGmailAdapter(db);
    await adapter.send(buildRaw("d@x.test", "b@x.test", "s", "body"));
    const productMessages = db.$client
      .prepare("SELECT COUNT(*) AS n FROM messages")
      .get() as { n: number };
    const productAttachments = db.$client
      .prepare("SELECT COUNT(*) AS n FROM message_attachments")
      .get() as { n: number };
    expect(productMessages.n).toBe(0);
    expect(productAttachments.n).toBe(0);
  });

  it("the fake_mailbox_messages table exists (the preflight table-exists probe)", () => {
    const row = db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("fake_mailbox_messages") as { name: string } | undefined;
    expect(row?.name).toBe("fake_mailbox_messages");
  });
});
