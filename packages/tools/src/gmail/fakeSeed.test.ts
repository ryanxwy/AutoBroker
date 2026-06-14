/**
 * L1 unit tests — seedFakeMailbox, the deterministic inbound-corpus row builder.
 * Pure/deterministic, no network. Freezes:
 *   - inserts the exact fake_mailbox_* columns (threads / messages / attachments);
 *   - the `to`/`from` reserved-word columns are written correctly (backtick-quoted);
 *   - re-running the same batch is idempotent (ON CONFLICT DO NOTHING);
 *   - internalDateMs must be strictly increasing across the batch — a tie throws,
 *     and nothing is written when it does (the assert runs before any insert);
 *   - attachment `size` equals the decoded byte length, not the base64 length;
 *   - a FakeGmailAdapter over the same DB reads the seeded rows back via
 *     search / getThread (the seeded raw decodes to the right headers + body).
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
import { seedFakeMailbox, type FakeMailboxSeedThread } from "./fakeSeed.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-gmail-seed-"));
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
});

// A tiny valid 1x1 PNG; decoded length is 67 bytes (≠ its base64 length).
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const SAMPLE: readonly FakeMailboxSeedThread[] = [
  {
    threadId: "t1",
    subject: "Re: quote A",
    searchProfileId: "p1",
    messages: [
      {
        messageId: "m1",
        direction: "inbound",
        from: "sales@example-dealer.com",
        to: "buyer@example.com",
        subject: "Re: quote A",
        bodyText: "We have it in stock at 33,995.",
        internalDateMs: 1_000,
      },
    ],
  },
  {
    threadId: "t2",
    subject: "Re: quote B",
    searchProfileId: "p1",
    messages: [
      {
        messageId: "m2",
        direction: "inbound",
        from: "sales@example-dealer-two.com",
        to: "buyer@example.com",
        subject: "Re: quote B",
        bodyText: "Attached is the OTD quote.",
        internalDateMs: 2_000,
        attachments: [
          {
            attachmentId: "a1",
            filename: "quote.png",
            mimeType: "image/png",
            dataBase64: TINY_PNG_BASE64,
          },
        ],
      },
    ],
  },
];

describe("seedFakeMailbox", () => {
  it("inserts the exact columns into the three fake_mailbox tables", () => {
    const result = seedFakeMailbox({ db, threads: SAMPLE });
    expect(result).toEqual({ threads: 2, messages: 2, attachments: 1 });

    const thread = db.$client
      .prepare("SELECT * FROM fake_mailbox_threads WHERE thread_id = ?")
      .get("t1") as Record<string, unknown>;
    expect(thread.subject).toBe("Re: quote A");
    expect(thread.search_profile_id).toBe("p1");

    const msg = db.$client
      .prepare("SELECT * FROM fake_mailbox_messages WHERE message_id = ?")
      .get("m1") as Record<string, unknown>;
    // The reserved-word columns are written correctly.
    expect(msg.to).toBe("buyer@example.com");
    expect(msg.from).toBe("sales@example-dealer.com");
    expect(msg.subject).toBe("Re: quote A");
    expect(msg.thread_id).toBe("t1");
    expect(msg.internal_date_ms).toBe(1_000);
    expect(msg.direction).toBe("inbound");
    expect(msg.is_delivered).toBe(1);
    expect(msg.search_profile_id).toBe("p1");
  });

  it("derives attachment size from the decoded byte length, not the base64 length", () => {
    seedFakeMailbox({ db, threads: SAMPLE });
    const att = db.$client
      .prepare("SELECT * FROM fake_mailbox_attachments WHERE attachment_id = ?")
      .get("a1") as Record<string, unknown>;
    expect(att.size).toBe(Buffer.from(TINY_PNG_BASE64, "base64").length);
    expect(att.size).not.toBe(TINY_PNG_BASE64.length);
    expect(att.message_id).toBe("m2");
    expect(att.mime_type).toBe("image/png");
  });

  it("is idempotent — a re-run with the same ids writes no duplicate rows", () => {
    seedFakeMailbox({ db, threads: SAMPLE });
    seedFakeMailbox({ db, threads: SAMPLE });
    const threads = db.$client
      .prepare("SELECT COUNT(*) AS n FROM fake_mailbox_threads")
      .get() as { n: number };
    const messages = db.$client
      .prepare("SELECT COUNT(*) AS n FROM fake_mailbox_messages")
      .get() as { n: number };
    const attachments = db.$client
      .prepare("SELECT COUNT(*) AS n FROM fake_mailbox_attachments")
      .get() as { n: number };
    expect(threads.n).toBe(2);
    expect(messages.n).toBe(2);
    expect(attachments.n).toBe(1);
  });

  it("throws on a non-increasing internalDateMs (a tie) and writes nothing", () => {
    const tied: readonly FakeMailboxSeedThread[] = [
      {
        threadId: "tt",
        subject: "s",
        searchProfileId: null,
        messages: [
          { messageId: "x1", direction: "inbound", from: "a@example.com", to: "b@example.com", subject: "s", bodyText: "one", internalDateMs: 5_000 },
          { messageId: "x2", direction: "inbound", from: "a@example.com", to: "b@example.com", subject: "s", bodyText: "two", internalDateMs: 5_000 },
        ],
      },
    ];
    expect(() => seedFakeMailbox({ db, threads: tied })).toThrow(/strictly increasing/);
    const messages = db.$client
      .prepare("SELECT COUNT(*) AS n FROM fake_mailbox_messages")
      .get() as { n: number };
    expect(messages.n).toBe(0);
  });

  it("a FakeGmailAdapter over the same DB reads the seeded threads + messages back", async () => {
    seedFakeMailbox({ db, threads: SAMPLE });
    const adapter = new FakeGmailAdapter(db);

    const refs = await adapter.search("");
    expect(refs.map((r) => r.threadId).sort()).toEqual(["t1", "t2"]);

    const thread = await adapter.getThread("t1");
    expect(thread.messages).toHaveLength(1);
    const m = thread.messages[0]!;
    expect(m.from).toBe("sales@example-dealer.com");
    expect(m.to).toBe("buyer@example.com");
    expect(m.subject).toBe("Re: quote A");
    expect(m.bodyText).toContain("33,995");
    expect(m.direction).toBe("inbound");

    // The attachment on m2 is listed via the read path.
    const thread2 = await adapter.getThread("t2");
    expect(thread2.messages[0]!.attachments).toHaveLength(1);
    expect(thread2.messages[0]!.attachments[0]!.filename).toBe("quote.png");
  });
});
