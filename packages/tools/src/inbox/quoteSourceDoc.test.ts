/**
 * L1 unit tests — readQuoteSourceDoc, the on-demand source-document reader.
 *
 * For a (profileId, quoteId) it re-fetches the quote's source attachment THROUGH
 * the gmail adapter (re-read every call — nothing is persisted) and returns the
 * decoded bytes + the resolved mime/filename, or null. Freezes:
 *   - happy path: a seeded dealer_quotes row whose source_gmail_message_id points
 *     at a fake message carrying a decodable PNG attachment → the PNG bytes +
 *     image/png + filename;
 *   - ownership: a quote on ANOTHER profile is invisible → null;
 *   - a missing quote → null;
 *   - a message with no allowlisted attachment (text/plain only) → null;
 *   - an oversized attachment (> 25 MiB) → null;
 *   - any adapter throw is swallowed → null (transient fallback, never a throw).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; the three
 * committed migrations run against the throwaway DB. NEVER touches ~/.autobroker-ts.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/db";

import { FakeGmailAdapter } from "../gmail/fakeAdapter.js";
import { seedFakeMailbox } from "../gmail/fakeSeed.js";
import { readQuoteSourceDoc } from "./quoteSourceDoc.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

/** A tiny valid 1x1 PNG (base64) so the attachment row has real decodable bytes. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const PROFILE_ID = "prof-1";

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-quote-source-"));
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
  db.$client.prepare("DELETE FROM dealer_quotes").run();
});

/** Insert a minimal dealer_quotes row pointing at a fake source message. */
function seedQuote(opts: {
  quoteId: string;
  profileId: string;
  sourceGmailMessageId: string;
  quoteFormat?: string | null;
}): void {
  db.$client
    .prepare(
      "INSERT INTO dealer_quotes " +
        "(quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, quote_format, financing_mode) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      opts.quoteId,
      "dealer-1",
      `msg-${opts.quoteId}`,
      opts.sourceGmailMessageId,
      opts.profileId,
      opts.quoteFormat ?? null,
      "finance",
    );
}

describe("readQuoteSourceDoc", () => {
  it("returns the source PNG bytes + mime + filename for a seeded quote", async () => {
    seedFakeMailbox({
      db,
      threads: [
        {
          threadId: "t1",
          subject: "Re: quote",
          searchProfileId: PROFILE_ID,
          messages: [
            {
              messageId: "gmsg-1",
              direction: "inbound",
              from: "sales@dealer.test",
              to: "buyer@x.test",
              subject: "Re: quote",
              bodyText: "Attached is our OTD quote.",
              internalDateMs: 1000,
              attachments: [
                {
                  attachmentId: "att-1",
                  filename: "quote.png",
                  mimeType: "image/png",
                  dataBase64: TINY_PNG_BASE64,
                },
              ],
            },
          ],
        },
      ],
    });
    seedQuote({
      quoteId: "q1",
      profileId: PROFILE_ID,
      sourceGmailMessageId: "gmsg-1",
      quoteFormat: "image",
    });

    const doc = await readQuoteSourceDoc(
      db,
      { profileId: PROFILE_ID, quoteId: "q1" },
      { adapter: new FakeGmailAdapter(db) },
    );
    expect(doc).not.toBeNull();
    expect(doc?.mimeType).toBe("image/png");
    expect(doc?.filename).toBe("quote.png");
    expect(Buffer.from(doc!.bytes).toString("base64")).toBe(TINY_PNG_BASE64);
  });

  it("returns null for a quote on another profile (ownership SELECT)", async () => {
    seedFakeMailbox({
      db,
      threads: [
        {
          threadId: "t1",
          subject: "Re: quote",
          searchProfileId: PROFILE_ID,
          messages: [
            {
              messageId: "gmsg-1",
              direction: "inbound",
              from: "sales@dealer.test",
              to: "buyer@x.test",
              subject: "Re: quote",
              bodyText: "attached",
              internalDateMs: 1000,
              attachments: [
                {
                  attachmentId: "att-1",
                  filename: "quote.png",
                  mimeType: "image/png",
                  dataBase64: TINY_PNG_BASE64,
                },
              ],
            },
          ],
        },
      ],
    });
    seedQuote({ quoteId: "q1", profileId: PROFILE_ID, sourceGmailMessageId: "gmsg-1" });

    const doc = await readQuoteSourceDoc(
      db,
      { profileId: "other-profile", quoteId: "q1" },
      { adapter: new FakeGmailAdapter(db) },
    );
    expect(doc).toBeNull();
  });

  it("returns null for an unknown quote id", async () => {
    const doc = await readQuoteSourceDoc(
      db,
      { profileId: PROFILE_ID, quoteId: "ghost" },
      { adapter: new FakeGmailAdapter(db) },
    );
    expect(doc).toBeNull();
  });

  it("returns null when the message carries no allowlisted attachment", async () => {
    seedFakeMailbox({
      db,
      threads: [
        {
          threadId: "t1",
          subject: "Re: quote",
          searchProfileId: PROFILE_ID,
          messages: [
            {
              messageId: "gmsg-1",
              direction: "inbound",
              from: "sales@dealer.test",
              to: "buyer@x.test",
              subject: "Re: quote",
              bodyText: "the quote is in the body",
              internalDateMs: 1000,
              attachments: [
                {
                  attachmentId: "att-1",
                  filename: "notes.txt",
                  mimeType: "text/plain",
                  dataBase64: Buffer.from("just text").toString("base64"),
                },
              ],
            },
          ],
        },
      ],
    });
    seedQuote({ quoteId: "q1", profileId: PROFILE_ID, sourceGmailMessageId: "gmsg-1" });

    const doc = await readQuoteSourceDoc(
      db,
      { profileId: PROFILE_ID, quoteId: "q1" },
      { adapter: new FakeGmailAdapter(db) },
    );
    expect(doc).toBeNull();
  });

  it("returns null for an oversized attachment (> 25 MiB)", async () => {
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1, 0);
    seedFakeMailbox({
      db,
      threads: [
        {
          threadId: "t1",
          subject: "Re: quote",
          searchProfileId: PROFILE_ID,
          messages: [
            {
              messageId: "gmsg-1",
              direction: "inbound",
              from: "sales@dealer.test",
              to: "buyer@x.test",
              subject: "Re: quote",
              bodyText: "attached",
              internalDateMs: 1000,
              attachments: [
                {
                  attachmentId: "att-1",
                  filename: "huge.png",
                  mimeType: "image/png",
                  dataBase64: oversized.toString("base64"),
                },
              ],
            },
          ],
        },
      ],
    });
    seedQuote({ quoteId: "q1", profileId: PROFILE_ID, sourceGmailMessageId: "gmsg-1" });

    const doc = await readQuoteSourceDoc(
      db,
      { profileId: PROFILE_ID, quoteId: "q1" },
      { adapter: new FakeGmailAdapter(db) },
    );
    expect(doc).toBeNull();
  });

  it("swallows an adapter throw and returns null (transient fallback)", async () => {
    // A quote pointing at a message that does NOT exist in the fake mailbox →
    // adapter.getMessage rejects → caught → null.
    seedQuote({ quoteId: "q1", profileId: PROFILE_ID, sourceGmailMessageId: "missing-msg" });

    const doc = await readQuoteSourceDoc(
      db,
      { profileId: PROFILE_ID, quoteId: "q1" },
      { adapter: new FakeGmailAdapter(db) },
    );
    expect(doc).toBeNull();
  });
});
