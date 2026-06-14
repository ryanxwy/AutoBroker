/**
 * L1 unit tests — the hygiene staged writers + their throwing typed guards.
 * Freezes: deleteOrphanThread re-confirms a TRUE orphan (non-orphan → false
 * no-write) and NEVER suppresses (orphan red-line); suppressThread rejects an
 * offer/value-intent thread, else writes one cleanup row + flips state, and is
 * idempotent; demoteCrmContact rejects a quote-owning/primary contact, else
 * SOFT-sets the flag (never deletes) + records the idempotent contact-cleanup row.
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
import {
  HygieneRejectedError,
  deleteOrphanThread,
  demoteCrmContact,
  suppressContact,
  suppressThread,
} from "./writes.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = [
  "0000_military_red_skull.sql",
  "0001_redundant_ozymandias.sql",
  "0002_pale_thunderball.sql",
].map((f) => join(here, "..", "..", "..", "db", "drizzle", f));

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

const DEALER_A = "dealer-a";
const RUN = "run-1";

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-hyg-writes-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
  db.$client.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')").run(DEALER_A, "Dealer A");
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
  return (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
function insThread(over: { threadId: string; gmailThreadId?: string | null; state?: string }): void {
  db.$client
    .prepare("INSERT INTO threads (thread_id, dealer_id, gmail_thread_id, state) VALUES (?, ?, ?, ?)")
    .run(over.threadId, DEALER_A, over.gmailThreadId ?? null, over.state ?? "replied");
}
function insMessage(over: {
  messageId: string;
  threadId: string | null;
  gmailMessageId?: string | null;
  direction?: string;
  contactId?: string | null;
}): void {
  db.$client
    .prepare(
      "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, contact_id) VALUES (?, ?, ?, ?, ?)",
    )
    .run(over.messageId, over.threadId, over.gmailMessageId ?? null, over.direction ?? "inbound", over.contactId ?? null);
}
function insAnalysis(over: { messageId: string; intent: string | null }): void {
  db.$client
    .prepare(
      "INSERT INTO message_analysis (analysis_id, message_id, analysis_version, is_current, intent) VALUES (?, ?, 1, 1, ?)",
    )
    .run(`a-${over.messageId}`, over.messageId, over.intent);
}
function insContact(over: { contactId: string; crm?: number; primary?: number }): void {
  db.$client
    .prepare(
      "INSERT INTO dealer_contacts (contact_id, dealer_id, normalized_email, is_crm_platform_sender, is_primary_reply_target) VALUES (?, ?, ?, ?, ?)",
    )
    .run(over.contactId, DEALER_A, `${over.contactId}@podium.email`, over.crm ?? 1, over.primary ?? 0);
}
function insQuote(over: { quoteId: string; messageId: string }): void {
  db.$client
    .prepare(
      "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, financing_mode) VALUES (?, ?, ?, ?, 'p', 'finance')",
    )
    .run(over.quoteId, DEALER_A, over.messageId, `g-${over.messageId}`);
}

// ---------------------------------------------------------------------------
// deleteOrphanThread — the ONE hard delete; non-orphan → false; never suppresses
// ---------------------------------------------------------------------------

describe("deleteOrphanThread", () => {
  it("deletes a TRUE orphan and writes NOTHING into thread_suppression (red-line)", () => {
    insThread({ threadId: "t-real" });
    insMessage({ messageId: "m-real", threadId: "t-real", gmailMessageId: "gm-1" });
    insThread({ threadId: "t-orphan", gmailThreadId: "gm-1" });

    expect(deleteOrphanThread(db, "t-orphan")).toBe(true);
    expect(count("threads")).toBe(1); // only t-real remains
    expect(count("thread_suppression")).toBe(0); // NEVER suppressed
  });

  it("a non-orphan (has messages) is a no-op returning false", () => {
    insThread({ threadId: "t-has", gmailThreadId: "gm-x" });
    insMessage({ messageId: "m-x", threadId: "t-has", gmailMessageId: "gm-x" });
    expect(deleteOrphanThread(db, "t-has")).toBe(false);
    expect(count("threads")).toBe(1);
  });

  it("an empty thread whose gmail_thread_id is NOT a real message-id is a no-op", () => {
    insThread({ threadId: "t-real-id", gmailThreadId: "a-real-thread-id" });
    expect(deleteOrphanThread(db, "t-real-id")).toBe(false);
    expect(count("threads")).toBe(1);
  });

  it("a re-delete of an already-gone orphan is a no-op (idempotent)", () => {
    insThread({ threadId: "t-real" });
    insMessage({ messageId: "m-real", threadId: "t-real", gmailMessageId: "gm-1" });
    insThread({ threadId: "t-orphan", gmailThreadId: "gm-1" });
    expect(deleteOrphanThread(db, "t-orphan")).toBe(true);
    expect(deleteOrphanThread(db, "t-orphan")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// suppressThread — guard + one cleanup row + state flip + idempotent
// ---------------------------------------------------------------------------

describe("suppressThread", () => {
  it("throws HygieneRejectedError for a thread with an offers row", () => {
    insThread({ threadId: "t-offer" });
    db.$client.prepare("INSERT INTO offers (offer_id, thread_id, dealer_id) VALUES ('o1', 't-offer', ?)").run(DEALER_A);
    expect(() => suppressThread(db, "t-offer", RUN)).toThrow(HygieneRejectedError);
    expect(count("thread_suppression")).toBe(0);
  });

  it("throws HygieneRejectedError for a thread with a value-class intent", () => {
    insThread({ threadId: "t-quote" });
    insMessage({ messageId: "m-q", threadId: "t-quote" });
    insAnalysis({ messageId: "m-q", intent: "pricing" });
    expect(() => suppressThread(db, "t-quote", RUN)).toThrow(HygieneRejectedError);
    expect(count("thread_suppression")).toBe(0);
  });

  it("writes ONE cleanup suppression row + flips the state for a clean thread", () => {
    insThread({ threadId: "t-crm", gmailThreadId: "real-thread" });
    insMessage({ messageId: "m-c", threadId: "t-crm" });
    insAnalysis({ messageId: "m-c", intent: "nurture" });

    expect(suppressThread(db, "t-crm", RUN)).toBe(true);
    const row = db.$client
      .prepare("SELECT scope, action, approved_by, gmail_thread_id FROM thread_suppression WHERE thread_id = 't-crm'")
      .get() as { scope: string; action: string; approved_by: string; gmail_thread_id: string };
    expect(row).toMatchObject({ scope: "thread", action: "cleanup", approved_by: "user", gmail_thread_id: "real-thread" });
    const state = db.$client.prepare("SELECT state FROM threads WHERE thread_id = 't-crm'").get() as { state: string };
    expect(state.state).toBe("suppressed");
    expect(count("threads")).toBe(1); // never deleted
  });

  it("is idempotent — a second suppress writes no new row", () => {
    insThread({ threadId: "t-crm" });
    insMessage({ messageId: "m-c", threadId: "t-crm" });
    insAnalysis({ messageId: "m-c", intent: "marketing" });
    expect(suppressThread(db, "t-crm", RUN)).toBe(true);
    expect(suppressThread(db, "t-crm", RUN)).toBe(false);
    expect(count("thread_suppression")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// demoteCrmContact — guard + SOFT flag + idempotent (never deletes)
// ---------------------------------------------------------------------------

describe("demoteCrmContact / suppressContact", () => {
  it("throws for a contact owning a quote", () => {
    insContact({ contactId: "c-own", crm: 1 });
    insThread({ threadId: "t-own" });
    insMessage({ messageId: "m-own", threadId: "t-own", contactId: "c-own" });
    insQuote({ quoteId: "q1", messageId: "m-own" });
    expect(() => demoteCrmContact(db, "c-own", RUN)).toThrow(HygieneRejectedError);
    expect(count("thread_suppression")).toBe(0);
  });

  it("throws for the primary reply target", () => {
    insContact({ contactId: "c-prim", crm: 1, primary: 1 });
    expect(() => demoteCrmContact(db, "c-prim", RUN)).toThrow(HygieneRejectedError);
  });

  it("SOFT-sets is_crm_platform_sender + records a contact-cleanup row; never deletes", () => {
    insContact({ contactId: "c-crm", crm: 1 });
    expect(demoteCrmContact(db, "c-crm", RUN)).toBe(true);
    const c = db.$client
      .prepare("SELECT is_crm_platform_sender FROM dealer_contacts WHERE contact_id = 'c-crm'")
      .get() as { is_crm_platform_sender: number };
    expect(c.is_crm_platform_sender).toBe(1);
    expect(count("dealer_contacts")).toBe(1); // never deleted
    const sup = db.$client
      .prepare("SELECT scope, action FROM thread_suppression WHERE contact_id = 'c-crm'")
      .get() as { scope: string; action: string };
    expect(sup).toMatchObject({ scope: "contact", action: "cleanup" });
  });

  it("is idempotent — a second demote writes no new row (suppressContact alias)", () => {
    insContact({ contactId: "c-crm", crm: 1 });
    expect(suppressContact(db, "c-crm", RUN)).toBe(true);
    expect(suppressContact(db, "c-crm", RUN)).toBe(false);
    expect(count("thread_suppression")).toBe(1);
  });
});
