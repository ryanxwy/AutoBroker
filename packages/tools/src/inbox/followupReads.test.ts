/**
 * L1 unit tests — the negotiation-follow-up DB reads. Freezes:
 *   - readQuoteSituationForThread: current = latest open quote for THIS dealer;
 *     best_competing = MIN over OTHER dealers' open quotes for the SAME profile;
 *     itemization needs a selling_price AND ≥1 itemized fee; an expired quote is
 *     excluded; an estimate-only quote reads NOT itemized;
 *   - listFollowupCandidateThreads: per-thread latest inbound / outbound epoch-ms
 *     + outbound round count, dealer name joined, profile-scoped;
 *   - readThreadSnapshotForDraft: subject + ordered messages + the latest inbound
 *     gmail_message_id (the reply double-flag anchor);
 *   - readReplyTargetInputs: the four ladder rungs, dealer + thread + profile
 *     scoped, in resolveReplyTarget's exact shape.
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
  listFollowupCandidateThreads,
  readQuoteSituationForThread,
  readReplyTargetInputs,
  readThreadSnapshotForDraft,
} from "./followupReads.js";

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

const PROFILE = "prof-1";
const OTHER_PROFILE = "prof-2";
const DEALER = "dealer-1"; // Jim Click — the thread under follow-up
const COMP = "dealer-2"; // a competing dealer (lower OTD)
const NOW = 2_000_000_000_000; // a fixed "now" in epoch ms

/** Insert a dealer_quotes row. financing_mode is NOT NULL. */
function insertQuote(
  c: Db["$client"],
  q: {
    quoteId: string;
    dealerId: string;
    profileId: string;
    otd: number | null;
    selling?: number | null;
    docFee?: number | null;
    receivedAt: number;
    expiresAt?: number | null;
  },
): void {
  c.prepare(
    "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, " +
      "selling_price, doc_fee, otd_total, quote_received_at, quote_expires_at, financing_mode) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cash')",
  ).run(
    q.quoteId,
    q.dealerId,
    `msg-${q.quoteId}`,
    `gm-${q.quoteId}`,
    q.profileId,
    q.selling ?? null,
    q.docFee ?? null,
    q.otd,
    q.receivedAt,
    q.expiresAt ?? null,
  );
}

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-followup-reads-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
  const c = db.$client;
  c.prepare("INSERT INTO dealers (dealer_id, name, country, contact_email) VALUES (?, ?, 'US', ?)").run(
    DEALER,
    "Jim Click Hyundai",
    "leads@jimclick.example.com",
  );
  c.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')").run(
    COMP,
    "Larry Miller Hyundai",
  );
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

describe("readQuoteSituationForThread", () => {
  it("picks the latest open quote and computes the competing MIN", () => {
    const c = db.$client;
    // This dealer: an older quote and a newer (itemized) quote.
    insertQuote(c, { quoteId: "q-old", dealerId: DEALER, profileId: PROFILE, otd: 33000, selling: 31000, docFee: 500, receivedAt: NOW - 100000 });
    insertQuote(c, { quoteId: "q-new", dealerId: DEALER, profileId: PROFILE, otd: 32000, selling: 30000, docFee: 499, receivedAt: NOW - 1000 });
    // Competing dealer: a lower open quote.
    insertQuote(c, { quoteId: "q-comp", dealerId: COMP, profileId: PROFILE, otd: 31200, selling: 29000, docFee: 400, receivedAt: NOW - 5000 });

    const s = readQuoteSituationForThread(db, { profileId: PROFILE, dealerId: DEALER, nowMs: NOW });
    expect(s.currentOtd).toBe(32000); // the newest open quote
    expect(s.isItemized).toBe(true); // selling_price + doc_fee present
    expect(s.bestCompetingOtd).toBe(31200); // the only competing open quote
  });

  it("excludes an expired quote from current and competing", () => {
    const c = db.$client;
    // Current dealer's only quote is expired → currentOtd null, not itemized.
    insertQuote(c, { quoteId: "q-exp", dealerId: DEALER, profileId: PROFILE, otd: 32000, selling: 30000, docFee: 499, receivedAt: NOW - 1000, expiresAt: NOW - 1 });
    // Competing dealer: one expired, one open — only the open one counts.
    insertQuote(c, { quoteId: "q-comp-exp", dealerId: COMP, profileId: PROFILE, otd: 30000, selling: 29000, docFee: 400, receivedAt: NOW - 5000, expiresAt: NOW - 1 });
    insertQuote(c, { quoteId: "q-comp-open", dealerId: COMP, profileId: PROFILE, otd: 31500, selling: 29500, docFee: 410, receivedAt: NOW - 4000 });

    const s = readQuoteSituationForThread(db, { profileId: PROFILE, dealerId: DEALER, nowMs: NOW });
    expect(s.currentOtd).toBeNull();
    expect(s.isItemized).toBe(false);
    expect(s.bestCompetingOtd).toBe(31500); // the expired 30000 is excluded
  });

  it("reads NOT itemized when the current quote is estimate-only (no fees / no selling price)", () => {
    const c = db.$client;
    insertQuote(c, { quoteId: "q-est", dealerId: DEALER, profileId: PROFILE, otd: 32000, selling: null, docFee: null, receivedAt: NOW - 1000 });
    const s = readQuoteSituationForThread(db, { profileId: PROFILE, dealerId: DEALER, nowMs: NOW });
    expect(s.currentOtd).toBe(32000);
    expect(s.isItemized).toBe(false);
  });

  it("returns null competing when only another PROFILE has competing quotes", () => {
    const c = db.$client;
    insertQuote(c, { quoteId: "q-cur", dealerId: DEALER, profileId: PROFILE, otd: 32000, selling: 30000, docFee: 499, receivedAt: NOW - 1000 });
    // A competing quote, but for a DIFFERENT profile — must not leak in.
    insertQuote(c, { quoteId: "q-other", dealerId: COMP, profileId: OTHER_PROFILE, otd: 28000, selling: 26000, docFee: 300, receivedAt: NOW - 1000 });
    const s = readQuoteSituationForThread(db, { profileId: PROFILE, dealerId: DEALER, nowMs: NOW });
    expect(s.bestCompetingOtd).toBeNull();
  });
});

describe("listFollowupCandidateThreads", () => {
  it("assembles latest inbound/outbound + round count, profile-scoped, dealer name joined", () => {
    const c = db.$client;
    c.prepare("INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id) VALUES (?, ?, ?, 'replied', ?)").run("t-1", DEALER, "Re: Tucson", PROFILE);
    // Another profile's thread — must not surface.
    c.prepare("INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id) VALUES (?, ?, ?, 'replied', ?)").run("t-other", DEALER, "Other", OTHER_PROFILE);

    // t-1: one outbound (older), two inbound, latest inbound newest.
    const ins = (id: string, dir: string, at: number) =>
      c.prepare(
        "INSERT INTO messages (message_id, thread_id, direction, received_at, search_profile_id, quote_extraction_status) VALUES (?, 't-1', ?, ?, ?, 'pending')",
      ).run(id, dir, at, PROFILE);
    ins("m-out1", "outbound", NOW - 90000);
    ins("m-in1", "inbound", NOW - 80000);
    ins("m-in2", "inbound", NOW - 1000);

    const rows = listFollowupCandidateThreads(db, PROFILE);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.threadId).toBe("t-1");
    expect(r.dealerName).toBe("Jim Click Hyundai");
    expect(r.lastInboundAtMs).toBe(NOW - 1000);
    expect(r.lastOutboundAtMs).toBe(NOW - 90000);
    expect(r.roundsSent).toBe(1);
    expect(r.state).toBe("replied");
  });

  it("returns null timestamps when a thread has no messages yet", () => {
    db.$client.prepare("INSERT INTO threads (thread_id, dealer_id, state, search_profile_id) VALUES ('t-empty', ?, 'replied', ?)").run(DEALER, PROFILE);
    const rows = listFollowupCandidateThreads(db, PROFILE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastInboundAtMs).toBeNull();
    expect(rows[0]!.lastOutboundAtMs).toBeNull();
    expect(rows[0]!.roundsSent).toBe(0);
  });
});

describe("readThreadSnapshotForDraft", () => {
  it("returns subject, ordered messages, and the latest inbound gmail id", () => {
    const c = db.$client;
    c.prepare("INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id) VALUES ('t-1', ?, 'Re: Tucson', 'replied', ?)").run(DEALER, PROFILE);
    const ins = (id: string, dir: string, at: number, gmail: string | null, body: string) =>
      c.prepare(
        "INSERT INTO messages (message_id, thread_id, direction, received_at, gmail_message_id, body_text, sender_name, search_profile_id, quote_extraction_status) " +
          "VALUES (?, 't-1', ?, ?, ?, ?, 'Dealer Rep', ?, 'pending')",
      ).run(id, dir, at, gmail, body, PROFILE);
    ins("m-in1", "inbound", NOW - 80000, "gm-1", "first reply");
    ins("m-out1", "outbound", NOW - 70000, null, "our follow-up");
    ins("m-in2", "inbound", NOW - 1000, "gm-2", "latest reply");

    const snap = readThreadSnapshotForDraft(db, "t-1");
    expect(snap.subject).toBe("Re: Tucson");
    expect(snap.messages.map((m) => m.direction)).toEqual(["inbound", "outbound", "inbound"]); // ascending
    expect(snap.latestInboundGmailMessageId).toBe("gm-2"); // the newest inbound gmail id
  });

  it("returns a null gmail anchor when no inbound message carries one", () => {
    const c = db.$client;
    c.prepare("INSERT INTO threads (thread_id, dealer_id, state, search_profile_id) VALUES ('t-1', ?, 'replied', ?)").run(DEALER, PROFILE);
    c.prepare(
      "INSERT INTO messages (message_id, thread_id, direction, received_at, gmail_message_id, search_profile_id, quote_extraction_status) VALUES ('m', 't-1', 'inbound', ?, NULL, ?, 'pending')",
    ).run(NOW, PROFILE);
    expect(readThreadSnapshotForDraft(db, "t-1").latestInboundGmailMessageId).toBeNull();
  });
});

describe("readReplyTargetInputs", () => {
  it("assembles the four ladder rungs, dealer + thread + profile scoped", () => {
    const c = db.$client;
    c.prepare("INSERT INTO threads (thread_id, dealer_id, state, search_profile_id) VALUES ('t-1', ?, 'replied', ?)").run(DEALER, PROFILE);
    c.prepare(
      "INSERT INTO dealer_contacts (contact_id, dealer_id, normalized_email, email, display_name, role, is_primary_reply_target) " +
        "VALUES ('c-1', ?, 'rep@jimclick.example.com', 'rep@jimclick.example.com', 'Rep One', 'sales', 1)",
    ).run(DEALER);
    c.prepare(
      "INSERT INTO messages (message_id, thread_id, direction, contact_id, sender_email, received_at, search_profile_id, quote_extraction_status) " +
        "VALUES ('m-in', 't-1', 'inbound', 'c-1', 'rep@jimclick.example.com', ?, ?, 'pending')",
    ).run(NOW, PROFILE);
    c.prepare(
      "INSERT INTO lead_submissions (submission_id, dealer_id, submitted_email, search_profile_id, outcome, submission_channel) " +
        "VALUES ('sub-1', ?, 'form@jimclick.example.com', ?, 'submitted', 'web_form')",
    ).run(DEALER, PROFILE);

    const inputs = readReplyTargetInputs(db, { profileId: PROFILE, dealerId: DEALER, threadId: "t-1" });
    expect(inputs.contacts).toHaveLength(1);
    expect(inputs.contacts[0]!.isPrimaryReplyTarget).toBe(1);
    expect(inputs.inboundMessages).toHaveLength(1);
    expect(inputs.inboundMessages[0]!.receivedAtMs).toBe(NOW);
    expect(inputs.leadSubmissions).toHaveLength(1);
    expect(inputs.leadSubmissions[0]!.submittedEmail).toBe("form@jimclick.example.com");
    expect(inputs.dealer.contactEmail).toBe("leads@jimclick.example.com");
  });

  it("does not include another profile's lead submissions", () => {
    const c = db.$client;
    c.prepare("INSERT INTO threads (thread_id, dealer_id, state, search_profile_id) VALUES ('t-1', ?, 'replied', ?)").run(DEALER, PROFILE);
    c.prepare(
      "INSERT INTO lead_submissions (submission_id, dealer_id, submitted_email, search_profile_id, outcome, submission_channel) " +
        "VALUES ('sub-other', ?, 'other@x.example.com', ?, 'submitted', 'web_form')",
    ).run(DEALER, OTHER_PROFILE);
    const inputs = readReplyTargetInputs(db, { profileId: PROFILE, dealerId: DEALER, threadId: "t-1" });
    expect(inputs.leadSubmissions).toHaveLength(0);
  });
});
