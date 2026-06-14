/**
 * L1 unit tests — the hygiene detection queries + the KEEP-biased classifier.
 * Freezes: each query's positive/negative rows; the orphan shape (zero messages
 * + stray message-id); the CRM-thread inbound-only + sibling-outbound + state +
 * suppressible-intent gate (a thread with an offer or a value-class intent never
 * surfaces); the CRM-contact flag + not-primary + zero-quote gate; the soft
 * scope (profileId logged, NEVER a WHERE filter); the suppression pre-filter.
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
  findCrmOnlyThreads,
  findCrmPlatformContacts,
  findOrphanThreads,
  listSuppressions,
  type HygieneScopeTrace,
} from "./detect.js";
import { isSuppressibleIntent } from "./classify.js";

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
const DEALER_B = "dealer-b";

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-hyg-detect-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
  const c = db.$client;
  c.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')").run(DEALER_A, "Dealer A");
  c.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')").run(DEALER_B, "Dealer B");
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

// ---------------------------------------------------------------------------
// seed helpers
// ---------------------------------------------------------------------------

function insThread(over: {
  threadId: string;
  dealerId?: string;
  gmailThreadId?: string | null;
  state?: string | null;
  subject?: string | null;
}): void {
  db.$client
    .prepare(
      "INSERT INTO threads (thread_id, dealer_id, gmail_thread_id, state, subject) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      over.threadId,
      over.dealerId ?? DEALER_A,
      over.gmailThreadId ?? null,
      over.state ?? "replied",
      over.subject ?? null,
    );
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
    .run(
      over.messageId,
      over.threadId,
      over.gmailMessageId ?? null,
      over.direction ?? "inbound",
      over.contactId ?? null,
    );
}

function insAnalysis(over: { analysisId: string; messageId: string; intent: string | null }): void {
  db.$client
    .prepare(
      "INSERT INTO message_analysis (analysis_id, message_id, analysis_version, is_current, intent) VALUES (?, ?, 1, 1, ?)",
    )
    .run(over.analysisId, over.messageId, over.intent);
}

function insContact(over: {
  contactId: string;
  dealerId?: string;
  email: string;
  crm?: number;
  primary?: number;
}): void {
  db.$client
    .prepare(
      "INSERT INTO dealer_contacts (contact_id, dealer_id, normalized_email, is_crm_platform_sender, is_primary_reply_target) VALUES (?, ?, ?, ?, ?)",
    )
    .run(over.contactId, over.dealerId ?? DEALER_A, over.email, over.crm ?? 0, over.primary ?? 0);
}

function insOffer(over: { offerId: string; threadId: string; dealerId?: string }): void {
  db.$client
    .prepare("INSERT INTO offers (offer_id, thread_id, dealer_id) VALUES (?, ?, ?)")
    .run(over.offerId, over.threadId, over.dealerId ?? DEALER_A);
}

function insQuote(over: { quoteId: string; messageId: string; dealerId?: string }): void {
  db.$client
    .prepare(
      "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, financing_mode) VALUES (?, ?, ?, ?, 'p', 'finance')",
    )
    .run(over.quoteId, over.dealerId ?? DEALER_A, over.messageId, `g-${over.messageId}`);
}

// ---------------------------------------------------------------------------
// classifier — pure KEEP bias
// ---------------------------------------------------------------------------

describe("isSuppressibleIntent — KEEP-biased membership", () => {
  it("the four CRM-noise intents are suppressible", () => {
    for (const i of ["nurture", "crm_followup", "appointment_request", "marketing"]) {
      expect(isSuppressibleIntent(i)).toBe(true);
    }
  });
  it("value-class + null + unknown intents are KEPT", () => {
    for (const i of ["quote", "pricing", "qualification", "other", "", null]) {
      expect(isSuppressibleIntent(i)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// findOrphanThreads
// ---------------------------------------------------------------------------

describe("findOrphanThreads", () => {
  it("surfaces a thread with zero messages whose gmail_thread_id is a real message-id", () => {
    // A real message on another thread provides the stray message-id.
    insThread({ threadId: "t-real" });
    insMessage({ messageId: "m-real", threadId: "t-real", gmailMessageId: "gm-1" });
    // The orphan: zero messages, gmail_thread_id = gm-1 (the stray message-id).
    insThread({ threadId: "t-orphan", gmailThreadId: "gm-1" });

    const rows = findOrphanThreads(db, null);
    expect(rows.map((r) => r.thread_id)).toEqual(["t-orphan"]);
    expect(rows[0]!.gmail_thread_id).toBe("gm-1");
    expect(rows[0]!.dealer_name).toBe("Dealer A");
  });

  it("does NOT surface a thread that has messages", () => {
    insThread({ threadId: "t-has", gmailThreadId: "gm-x" });
    insMessage({ messageId: "m-x", threadId: "t-has", gmailMessageId: "gm-y" });
    insMessage({ messageId: "m-has", threadId: "t-has", gmailMessageId: "gm-x" });
    expect(findOrphanThreads(db, null)).toEqual([]);
  });

  it("does NOT surface an empty thread whose gmail_thread_id is NOT a real message-id", () => {
    insThread({ threadId: "t-empty", gmailThreadId: "real-thread-id" });
    expect(findOrphanThreads(db, null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findCrmOnlyThreads
// ---------------------------------------------------------------------------

describe("findCrmOnlyThreads", () => {
  function seedSiblingOutbound(dealerId = DEALER_A): void {
    insThread({ threadId: "t-out", dealerId, subject: "real convo" });
    insMessage({ messageId: "m-out", threadId: "t-out", direction: "outbound" });
  }

  it("surfaces an inbound-only thread (suppressible intent, sibling outbound, state<>agreed)", () => {
    seedSiblingOutbound();
    insThread({ threadId: "t-crm", subject: "Still thinking it over?" });
    insMessage({ messageId: "m-crm", threadId: "t-crm", direction: "inbound" });
    insAnalysis({ analysisId: "a-crm", messageId: "m-crm", intent: "nurture" });

    const rows = findCrmOnlyThreads(db, null);
    expect(rows.map((r) => r.thread_id)).toEqual(["t-crm"]);
    expect(rows[0]!.intent).toBe("nurture");
    expect(rows[0]!.subject).toBe("Still thinking it over?");
  });

  it("does NOT surface a thread carrying a value-class intent (quote)", () => {
    seedSiblingOutbound();
    insThread({ threadId: "t-quote" });
    insMessage({ messageId: "m-q", threadId: "t-quote", direction: "inbound" });
    insAnalysis({ analysisId: "a-q", messageId: "m-q", intent: "quote" });
    expect(findCrmOnlyThreads(db, null)).toEqual([]);
  });

  it("does NOT surface a thread with an offers row even if the intent is suppressible", () => {
    seedSiblingOutbound();
    insThread({ threadId: "t-offer" });
    insMessage({ messageId: "m-of", threadId: "t-offer", direction: "inbound" });
    insAnalysis({ analysisId: "a-of", messageId: "m-of", intent: "marketing" });
    insOffer({ offerId: "o-1", threadId: "t-offer" });
    expect(findCrmOnlyThreads(db, null)).toEqual([]);
  });

  it("does NOT surface when the dealer has NO sibling outbound thread", () => {
    insThread({ threadId: "t-lonely" });
    insMessage({ messageId: "m-l", threadId: "t-lonely", direction: "inbound" });
    insAnalysis({ analysisId: "a-l", messageId: "m-l", intent: "nurture" });
    expect(findCrmOnlyThreads(db, null)).toEqual([]);
  });

  it("does NOT surface a thread in state 'agreed'", () => {
    seedSiblingOutbound();
    insThread({ threadId: "t-agreed", state: "agreed" });
    insMessage({ messageId: "m-ag", threadId: "t-agreed", direction: "inbound" });
    insAnalysis({ analysisId: "a-ag", messageId: "m-ag", intent: "nurture" });
    expect(findCrmOnlyThreads(db, null)).toEqual([]);
  });

  it("does NOT surface a MIXED-INTENT thread (one current nurture + one current quote)", () => {
    // A thread with BOTH a suppressible and a value-class CURRENT intent must be
    // KEPT: under GROUP BY the bare ma.intent is arbitrary, so without the
    // whole-set gate the suppressible row could surface a thread the write guard
    // would then reject (rolling back the all-or-nothing run).
    seedSiblingOutbound();
    insThread({ threadId: "t-mixed", subject: "Still thinking it over?" });
    insMessage({ messageId: "m-mix-n", threadId: "t-mixed", direction: "inbound" });
    insMessage({ messageId: "m-mix-q", threadId: "t-mixed", direction: "inbound" });
    insAnalysis({ analysisId: "a-mix-n", messageId: "m-mix-n", intent: "nurture" });
    insAnalysis({ analysisId: "a-mix-q", messageId: "m-mix-q", intent: "quote" });
    expect(findCrmOnlyThreads(db, null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findCrmPlatformContacts
// ---------------------------------------------------------------------------

describe("findCrmPlatformContacts", () => {
  it("surfaces a crm-platform, non-primary, zero-quote contact", () => {
    insContact({ contactId: "c-crm", email: "noreply@podium.email", crm: 1, primary: 0 });
    const rows = findCrmPlatformContacts(db, null);
    expect(rows.map((r) => r.contact_id)).toEqual(["c-crm"]);
    expect(rows[0]!.normalized_email).toBe("noreply@podium.email");
  });

  it("does NOT surface a contact owning a quote", () => {
    insContact({ contactId: "c-own", email: "sales@podium.email", crm: 1, primary: 0 });
    insThread({ threadId: "t-own" });
    insMessage({ messageId: "m-own", threadId: "t-own", contactId: "c-own" });
    insQuote({ quoteId: "q-1", messageId: "m-own" });
    expect(findCrmPlatformContacts(db, null)).toEqual([]);
  });

  it("does NOT surface the primary reply target", () => {
    insContact({ contactId: "c-prim", email: "rep@podium.email", crm: 1, primary: 1 });
    expect(findCrmPlatformContacts(db, null)).toEqual([]);
  });

  it("does NOT surface a non-crm-platform contact", () => {
    insContact({ contactId: "c-plain", email: "sam@dealer-a.com", crm: 0, primary: 0 });
    expect(findCrmPlatformContacts(db, null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// soft scope — profileId is LOGGED, never a WHERE filter
// ---------------------------------------------------------------------------

describe("soft scope (global detection; pin logged not filtered)", () => {
  it("returns the same rows for any profileId and records the pin on the trace", () => {
    insThread({ threadId: "t-real" });
    insMessage({ messageId: "m-real", threadId: "t-real", gmailMessageId: "gm-1" });
    insThread({ threadId: "t-orphan", gmailThreadId: "gm-1" });

    const seen: Array<{ query: string; profileId: string | null }> = [];
    const trace: HygieneScopeTrace = (r) => seen.push({ query: r.query, profileId: r.profileId });

    const withNull = findOrphanThreads(db, null, trace);
    const withPin = findOrphanThreads(db, "prof-xyz", trace);
    expect(withNull.map((r) => r.thread_id)).toEqual(withPin.map((r) => r.thread_id)); // pin not a filter
    expect(seen).toEqual([
      { query: "findOrphanThreads", profileId: null },
      { query: "findOrphanThreads", profileId: "prof-xyz" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// listSuppressions — the idempotent pre-filter
// ---------------------------------------------------------------------------

describe("listSuppressions", () => {
  it("returns thread_ids with a cleanup suppression row", () => {
    insThread({ threadId: "t-s" });
    db.$client
      .prepare(
        "INSERT INTO thread_suppression (suppression_id, thread_id, dealer_id, scope, action, approved_by) VALUES ('s1', 't-s', ?, 'thread', 'cleanup', 'user')",
      )
      .run(DEALER_A);
    expect([...listSuppressions(db)]).toEqual(["t-s"]);
  });
});
