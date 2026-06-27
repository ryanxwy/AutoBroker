/**
 * L1 unit tests — applyInboxBatch, the ONE atomic inbox write. Freezes:
 *   - APPROVE ingests threads + dealer_contacts + inbound messages (pending,
 *     search_profile_id stamped NON-NULL) + thread_routing binding;
 *   - the searchProfileId NON-NULL type contract (the orphan-row fix — the
 *     compiler rejects a null/omitted profile id);
 *   - dedup on gmail_message_id: a re-sweep that re-sees a message writes
 *     nothing (the whole apply is a no-op on re-run);
 *   - REJECT writes EXACTLY ONE thread_suppression row, no message row;
 *   - a mid-write failure rolls the whole batch back (all-or-nothing).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; the committed
 * migrations run against the throwaway DB. NEVER touches ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "../db.js";
import { applyInboxBatch, type ThreadDecision } from "./applyBatch.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = [
  "0000_military_red_skull.sql",
  "0001_redundant_ozymandias.sql",
  "0002_pale_thunderball.sql",
].map((f) => join(here, "..", "..", "..", "db", "drizzle", f));

const PROFILE_ID = "prof-inbox-1";
const DEALER_A = "dealer-aaaa";

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-inbox-apply-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
  // The dealer the threads route to (threads.dealer_id / contacts.dealer_id /
  // suppression.dealer_id are all NOT NULL FK → dealers).
  db.$client
    .prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')")
    .run(DEALER_A, "Example Hyundai");
});

afterEach(() => {
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

function count(table: string): number {
  const r = db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return r.n;
}

function decision(over: Partial<ThreadDecision> = {}): ThreadDecision {
  return {
    threadId: "t-1",
    gmailThreadId: "g-t-1",
    dealerId: DEALER_A,
    contactDisplayName: "Sam Sales",
    contactRole: "Sales Manager",
    contactId: "contact-1",
    normalizedSenderEmail: "sam@example-dealer.com",
    isCrmPlatformSender: false,
    subject: "Re: Tucson availability",
    classification: "quoted",
    messages: [
      {
        messageId: "m-1",
        gmailMessageId: "g-m-1",
        sender: "Sam Sales <sam@example-dealer.com>",
        senderEmail: "sam@example-dealer.com",
        senderName: "Sam Sales",
        recipient: "buyer@example.com",
        subject: "Re: Tucson availability",
        bodyText: "We have one in stock; sale price 33,995.",
        receivedAt: "2026-06-13T10:00:00.000Z",
      },
    ],
    ...over,
  };
}

describe("applyInboxBatch — APPROVE", () => {
  it("ingests thread + contact + inbound message (pending, profile-scoped) + routing", () => {
    const res = applyInboxBatch({
      searchProfileId: PROFILE_ID,
      runId: "run-1",
      approve: [decision()],
      reject: [],
      db,
    });
    expect(res).toEqual({ newThreads: 1, newMessages: 1, newContacts: 1, rejected: 0 });

    const msg = db.$client
      .prepare("SELECT * FROM messages WHERE message_id = 'm-1'")
      .get() as Record<string, unknown>;
    expect(msg["direction"]).toBe("inbound");
    expect(msg["quote_extraction_status"]).toBe("pending");
    expect(msg["search_profile_id"]).toBe(PROFILE_ID); // NON-NULL — the orphan fix
    expect(msg["gmail_message_id"]).toBe("g-m-1");

    const thread = db.$client
      .prepare("SELECT * FROM threads WHERE thread_id = 't-1'")
      .get() as Record<string, unknown>;
    expect(thread["search_profile_id"]).toBe(PROFILE_ID);
    expect(thread["dealer_id"]).toBe(DEALER_A);

    const routing = db.$client
      .prepare("SELECT * FROM thread_routing WHERE thread_id = 't-1'")
      .get() as Record<string, unknown>;
    expect(routing["search_profile_id"]).toBe(PROFILE_ID);
    expect(routing["bound_by"]).toBe("user");

    expect(count("dealer_contacts")).toBe(1);
    expect(count("thread_suppression")).toBe(0);
  });

  it("dedups on gmail_message_id — a re-sweep of the same message is a no-op", () => {
    applyInboxBatch({ searchProfileId: PROFILE_ID, runId: "run-1", approve: [decision()], reject: [], db });
    // Re-run with a DIFFERENT product message id but the SAME backend id.
    const res2 = applyInboxBatch({
      searchProfileId: PROFILE_ID,
      runId: "run-2",
      approve: [
        decision({
          messages: [
            {
              messageId: "m-1-redux", // different product id
              gmailMessageId: "g-m-1", // SAME backend id
              sender: "Sam Sales <sam@example-dealer.com>",
              senderEmail: "sam@example-dealer.com",
              senderName: "Sam Sales",
              recipient: "buyer@example.com",
              subject: "Re: Tucson availability",
              bodyText: "dup",
              receivedAt: "2026-06-13T11:00:00.000Z",
            },
          ],
        }),
      ],
      reject: [],
      db,
    });
    expect(res2.newMessages).toBe(0); // dedup → no new message
    expect(count("messages")).toBe(1);
  });

  it("writes the contact role, and a later null KEEPS the prior role (COALESCE)", () => {
    applyInboxBatch({
      searchProfileId: PROFILE_ID,
      runId: "run-1",
      approve: [decision({ contactRole: "Internet Sales Manager" })],
      reject: [],
      db,
    });
    const first = db.$client
      .prepare("SELECT role FROM dealer_contacts WHERE contact_id = 'contact-1'")
      .get() as { role: string | null };
    expect(first.role).toBe("Internet Sales Manager");

    // A later sweep of the SAME contact with a null role must not erase it.
    applyInboxBatch({
      searchProfileId: PROFILE_ID,
      runId: "run-2",
      approve: [
        decision({
          contactRole: null,
          messages: [
            {
              messageId: "m-2",
              gmailMessageId: "g-m-2",
              sender: "Sam Sales <sam@example-dealer.com>",
              senderEmail: "sam@example-dealer.com",
              senderName: "Sam Sales",
              recipient: "buyer@example.com",
              subject: "Re: Tucson availability",
              bodyText: "follow-up",
              receivedAt: "2026-06-13T12:00:00.000Z",
            },
          ],
        }),
      ],
      reject: [],
      db,
    });
    const after = db.$client
      .prepare("SELECT role FROM dealer_contacts WHERE contact_id = 'contact-1'")
      .get() as { role: string | null };
    expect(after.role).toBe("Internet Sales Manager"); // null did NOT overwrite
  });
});

describe("applyInboxBatch — REJECT", () => {
  it("writes EXACTLY ONE thread_suppression row and NO message row", () => {
    const res = applyInboxBatch({
      searchProfileId: PROFILE_ID,
      runId: "run-rej",
      approve: [],
      reject: [decision({ threadId: "t-rej", gmailThreadId: "g-t-rej", classification: "replied" })],
      db,
    });
    expect(res.rejected).toBe(1);
    expect(count("thread_suppression")).toBe(1);
    expect(count("messages")).toBe(0);
    expect(count("threads")).toBe(0);

    const sup = db.$client
      .prepare("SELECT * FROM thread_suppression WHERE gmail_thread_id = 'g-t-rej'")
      .get() as Record<string, unknown>;
    expect(sup["scope"]).toBe("thread");
    expect(sup["action"]).toBe("suppress");
    expect(sup["approved_by"]).toBe("user");
    expect(sup["thread_id"]).toBeNull(); // a rejected thread is never ingested
    expect(sup["search_profile_id"]).toBe(PROFILE_ID);
    expect(String(sup["reason"])).toContain("run-rej");
  });

  it("is idempotent — re-rejecting the same thread adds no new suppression row", () => {
    const args = {
      searchProfileId: PROFILE_ID,
      runId: "run-rej",
      approve: [],
      reject: [decision({ threadId: "t-rej" })],
      db,
    };
    applyInboxBatch(args);
    const res2 = applyInboxBatch(args);
    expect(res2.rejected).toBe(0);
    expect(count("thread_suppression")).toBe(1);
  });
});

describe("applyInboxBatch — atomic (all-or-nothing)", () => {
  it("rolls the WHOLE batch back when a write fails mid-transaction", () => {
    // The second decision routes to a non-existent dealer → its threads insert
    // violates the dealer_id FK → the transaction throws and rolls back the
    // first (valid) decision too.
    expect(() =>
      applyInboxBatch({
        searchProfileId: PROFILE_ID,
        runId: "run-bad",
        approve: [
          decision({ threadId: "t-ok", contactId: "c-ok" }),
          decision({ threadId: "t-bad", contactId: "c-bad", dealerId: "dealer-missing" }),
        ],
        reject: [],
        db,
      }),
    ).toThrow();
    // Nothing from EITHER decision survives.
    expect(count("threads")).toBe(0);
    expect(count("messages")).toBe(0);
    expect(count("dealer_contacts")).toBe(0);
    expect(count("thread_routing")).toBe(0);
  });
});
