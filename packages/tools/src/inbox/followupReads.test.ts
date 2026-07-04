/**
 * L1 unit tests — the negotiation-follow-up DB reads. Freezes:
 *   - the follow-up TONE derivation (readDealerGiveUpInputs → classifyQuoteSituation,
 *     the SAME mapping the Negotiations board + the negotiation_followup workflow
 *     use): current = latest OPEN quote for THIS dealer; the tone baseline =
 *     bestCompetingRealOtd (lowest REAL same-mode competitor); itemization needs a
 *     selling_price AND ≥1 itemized fee; open-ness is parsed in JS so a FUTURE ISO
 *     quote_expires_at reads OPEN (the CAST-predicate bug fix), a PAST one expired;
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
  readDealerGiveUpInputs,
  readReplyTargetInputs,
  readThreadSnapshotForDraft,
} from "./followupReads.js";
import { classifyQuoteSituation, type QuoteTone } from "../dealerComm/quoteSituation.js";
import { resolveReplyTarget } from "../dealerComm/replyTargets.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = [
  "0000_military_red_skull.sql",
  "0001_redundant_ozymandias.sql",
  "0002_pale_thunderball.sql",
  "0008_graceful_magdalene.sql",
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

// The follow-up TONE derivation the negotiation_followup workflow AND the
// Negotiations board both use: readDealerGiveUpInputs mapped to the pure
// classifyQuoteSituation with the lowest REAL same-mode competitor
// (bestCompetingRealOtd) as the tone baseline. Returns the mapped inputs + the
// resolved tone, so the open/expired/itemization branches stay frozen at the tone
// level (where the workflow actually consumes them).
function situationFor(
  dealerId: string,
  nowMs: number,
): { currentOtd: number | null; isItemized: boolean; bestCompetingOtd: number | null; tone: QuoteTone } {
  const inputs = readDealerGiveUpInputs(db, { profileId: PROFILE, dealerId, nowMs });
  const bestCompetingOtd = inputs.bestCompetingRealOtd;
  const tone = classifyQuoteSituation({
    isItemized: inputs.isItemized,
    bestCompetingOtd,
    currentOtd: inputs.currentOtd,
  });
  return { currentOtd: inputs.currentOtd, isItemized: inputs.isItemized, bestCompetingOtd, tone };
}

describe("readDealerGiveUpInputs → classifyQuoteSituation (the follow-up tone derivation)", () => {
  it("picks the latest open quote + a lower competitor → assertive tone", () => {
    const c = db.$client;
    // This dealer: an older quote and a newer (itemized) quote, both open.
    insertQuote(c, { quoteId: "q-old", dealerId: DEALER, profileId: PROFILE, otd: 33000, selling: 31000, docFee: 500, receivedAt: NOW - 100000 });
    insertQuote(c, { quoteId: "q-new", dealerId: DEALER, profileId: PROFILE, otd: 33900, selling: 31400, docFee: 499, receivedAt: NOW - 1000 });
    // Competing dealer: a lower open quote (>$500 below the current → assertive).
    insertQuote(c, { quoteId: "q-comp", dealerId: COMP, profileId: PROFILE, otd: 31200, selling: 29000, docFee: 400, receivedAt: NOW - 5000 });

    const s = situationFor(DEALER, NOW);
    expect(s.currentOtd).toBe(33900); // the newest open quote
    expect(s.isItemized).toBe(true); // selling_price + doc_fee present
    expect(s.bestCompetingOtd).toBe(31200); // the only real same-mode competitor
    expect(s.tone).toBe("assertive"); // 33900 − 31200 = 2700 > the $500 threshold
  });

  it("excludes an expired quote from current → no current OTD → conservative tone", () => {
    const c = db.$client;
    // Current dealer's only quote is expired → currentOtd null, not itemized.
    insertQuote(c, { quoteId: "q-exp", dealerId: DEALER, profileId: PROFILE, otd: 32000, selling: 30000, docFee: 499, receivedAt: NOW - 1000, expiresAt: NOW - 1 });
    // A competing OPEN quote exists — but with no current quote it is never reached.
    insertQuote(c, { quoteId: "q-comp-open", dealerId: COMP, profileId: PROFILE, otd: 31500, selling: 29500, docFee: 410, receivedAt: NOW - 4000 });

    const s = situationFor(DEALER, NOW);
    expect(s.currentOtd).toBeNull(); // the expired quote is excluded from current
    expect(s.isItemized).toBe(false);
    expect(s.tone).toBe("conservative"); // no itemized current → nothing to push on
  });

  it("reads NOT itemized when the current quote is estimate-only → conservative tone", () => {
    const c = db.$client;
    insertQuote(c, { quoteId: "q-est", dealerId: DEALER, profileId: PROFILE, otd: 32000, selling: null, docFee: null, receivedAt: NOW - 1000 });
    // Even a cheaper competitor cannot make an estimate-only quote assertive.
    insertQuote(c, { quoteId: "q-comp", dealerId: COMP, profileId: PROFILE, otd: 30000, selling: 28000, docFee: 400, receivedAt: NOW - 2000 });

    const s = situationFor(DEALER, NOW);
    expect(s.currentOtd).toBe(32000);
    expect(s.isItemized).toBe(false);
    expect(s.tone).toBe("conservative"); // !isItemized short-circuits the ladder
  });

  it("no competitor for this profile (only another profile has one) → appreciative tone", () => {
    const c = db.$client;
    insertQuote(c, { quoteId: "q-cur", dealerId: DEALER, profileId: PROFILE, otd: 32000, selling: 30000, docFee: 499, receivedAt: NOW - 1000 });
    // A competing quote, but for a DIFFERENT profile — must not leak in.
    insertQuote(c, { quoteId: "q-other", dealerId: COMP, profileId: OTHER_PROFILE, otd: 28000, selling: 26000, docFee: 300, receivedAt: NOW - 1000 });

    const s = situationFor(DEALER, NOW);
    expect(s.bestCompetingOtd).toBeNull();
    expect(s.tone).toBe("appreciative"); // itemized current, no competitor → nothing to push for
  });

  it("a FUTURE ISO quote_expires_at reads OPEN → assertive (the CAST-predicate bug fix)", () => {
    const c = db.$client;
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    // CAST('2027-01-01…' AS INTEGER) collapses to 2027, and 2027 > now(epoch-ms
    // ~1.7e12) is FALSE, so the OLD SQL-CAST predicate wrongly read this OPEN quote
    // as already-expired → currentOtd null → the WRONG (non-assertive) tone. The JS
    // open-ness check keeps it OPEN, so the tone is the correct assertive.
    insertQuote(c, {
      quoteId: "q-fut",
      dealerId: DEALER,
      profileId: PROFILE,
      otd: 33900,
      selling: 31400,
      docFee: 499,
      receivedAt: Date.parse("2026-05-01T00:00:00.000Z"),
      expiresAt: "2027-01-01T00:00:00.000Z" as unknown as number,
    });
    // A cheaper competitor, also with a future ISO expiry (the tone baseline).
    insertQuote(c, {
      quoteId: "q-comp-fut",
      dealerId: COMP,
      profileId: PROFILE,
      otd: 31200,
      selling: 29000,
      docFee: 400,
      receivedAt: Date.parse("2026-05-02T00:00:00.000Z"),
      expiresAt: "2027-01-01T00:00:00.000Z" as unknown as number,
    });

    const s = situationFor(DEALER, now);
    expect(s.currentOtd).toBe(33900); // still OPEN, NOT dropped as expired
    expect(s.bestCompetingOtd).toBe(31200);
    expect(s.tone).toBe("assertive"); // the CAST bug would have yielded conservative
  });

  it("a PAST ISO quote_expires_at reads EXPIRED → no current OTD → conservative tone", () => {
    const c = db.$client;
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    insertQuote(c, {
      quoteId: "q-past",
      dealerId: DEALER,
      profileId: PROFILE,
      otd: 33900,
      selling: 31400,
      docFee: 499,
      receivedAt: Date.parse("2026-05-01T00:00:00.000Z"),
      expiresAt: "2026-05-15T00:00:00.000Z" as unknown as number,
    });

    const s = situationFor(DEALER, now);
    expect(s.currentOtd).toBeNull(); // a past ISO expiry → expired, excluded from current
    expect(s.tone).toBe("conservative");
  });

  it("orders by the parsed ISO quote_received_at (newest wins as current), not quote_id", () => {
    const c = db.$client;
    const now = Date.parse("2026-07-01T00:00:00.000Z");
    // quote_ids deliberately REVERSED vs chronology: a SQL CAST(received_at AS
    // INTEGER) would collapse all to 2026 and fall back to quote_id order (picking
    // the WRONG current). Only a real time sort makes the 12:00 quote current.
    insertQuote(c, { quoteId: "iso-z", dealerId: DEALER, profileId: PROFILE, otd: 34000, selling: 31500, docFee: 499, receivedAt: "2026-06-25T10:00:00.000Z" as unknown as number });
    insertQuote(c, { quoteId: "iso-a", dealerId: DEALER, profileId: PROFILE, otd: 33900, selling: 31400, docFee: 499, receivedAt: "2026-06-25T12:00:00.000Z" as unknown as number });
    insertQuote(c, { quoteId: "q-comp", dealerId: COMP, profileId: PROFILE, otd: 31200, selling: 29000, docFee: 400, receivedAt: "2026-06-25T09:00:00.000Z" as unknown as number });

    const s = situationFor(DEALER, now);
    expect(s.currentOtd).toBe(33900); // the chronologically-newest ISO quote (12:00), not iso-z's 34000
    expect(s.tone).toBe("assertive"); // 33900 − 31200 = 2700 > the $500 threshold
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
    // The lone outbound was inserted (rowid) BEFORE both inbound replies, so the
    // dealer has answered it: zero unanswered follow-ups outstanding.
    expect(r.unansweredFollowups).toBe(0);
    expect(r.state).toBe("replied");
  });

  it("returns null timestamps when a thread has no messages yet", () => {
    db.$client.prepare("INSERT INTO threads (thread_id, dealer_id, state, search_profile_id) VALUES ('t-empty', ?, 'replied', ?)").run(DEALER, PROFILE);
    const rows = listFollowupCandidateThreads(db, PROFILE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lastInboundAtMs).toBeNull();
    expect(rows[0]!.lastOutboundAtMs).toBeNull();
    expect(rows[0]!.roundsSent).toBe(0);
    expect(rows[0]!.unansweredFollowups).toBe(0);
  });

  it("counts unanswered follow-ups by insertion order (rowid) and resets on a dealer reply", () => {
    const c = db.$client;
    c.prepare("INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id) VALUES ('t-cap', ?, 'Re: Tucson', 'replied', ?)").run(DEALER, PROFILE);
    // Insertion order IS the conversational order: outbound rows carry no
    // received_at in production, so the count keys off rowid, not timestamps.
    const ins = (id: string, dir: string) =>
      c.prepare(
        "INSERT INTO messages (message_id, thread_id, direction, search_profile_id, quote_extraction_status) VALUES (?, 't-cap', ?, ?, 'pending')",
      ).run(id, dir, PROFILE);
    ins("m-in0", "inbound"); // dealer's initial quote
    ins("m-out1", "outbound"); // buyer follow-up #1 (unanswered)
    ins("m-out2", "outbound"); // buyer follow-up #2 (still unanswered)
    let r = listFollowupCandidateThreads(db, PROFILE).find((x) => x.threadId === "t-cap")!;
    expect(r.roundsSent).toBe(2);
    expect(r.unansweredFollowups).toBe(2); // both outbounds are past the latest inbound rowid

    ins("m-in1", "inbound"); // dealer finally counters → resets the unanswered count
    r = listFollowupCandidateThreads(db, PROFILE).find((x) => x.threadId === "t-cap")!;
    expect(r.roundsSent).toBe(2); // total is unchanged
    expect(r.unansweredFollowups).toBe(0); // no outbound is past the new latest inbound
  });

  it("counts every outbound as unanswered when the dealer has never replied", () => {
    const c = db.$client;
    c.prepare("INSERT INTO threads (thread_id, dealer_id, state, search_profile_id) VALUES ('t-noreply', ?, 'replied', ?)").run(DEALER, PROFILE);
    c.prepare("INSERT INTO messages (message_id, thread_id, direction, search_profile_id, quote_extraction_status) VALUES ('m-o1', 't-noreply', 'outbound', ?, 'pending')").run(PROFILE);
    const r = listFollowupCandidateThreads(db, PROFILE).find((x) => x.threadId === "t-noreply")!;
    expect(r.unansweredFollowups).toBe(1); // COALESCE(...,0) → all outbound count
  });
});

describe("readThreadSnapshotForDraft", () => {
  it("returns subject, ordered messages, and the latest inbound gmail + rfc ids", () => {
    const c = db.$client;
    c.prepare("INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id) VALUES ('t-1', ?, 'Re: Tucson', 'replied', ?)").run(DEALER, PROFILE);
    const ins = (id: string, dir: string, at: number, gmail: string | null, rfc: string | null, body: string) =>
      c.prepare(
        "INSERT INTO messages (message_id, thread_id, direction, received_at, gmail_message_id, rfc_message_id, body_text, sender_name, search_profile_id, quote_extraction_status) " +
          "VALUES (?, 't-1', ?, ?, ?, ?, ?, 'Dealer Rep', ?, 'pending')",
      ).run(id, dir, at, gmail, rfc, body, PROFILE);
    ins("m-in1", "inbound", NOW - 80000, "gm-1", "<r1@dealer.test>", "first reply");
    ins("m-out1", "outbound", NOW - 70000, null, null, "our follow-up");
    ins("m-in2", "inbound", NOW - 1000, "gm-2", "<r2@dealer.test>", "latest reply");

    const snap = readThreadSnapshotForDraft(db, "t-1");
    expect(snap.subject).toBe("Re: Tucson");
    expect(snap.messages.map((m) => m.direction)).toEqual(["inbound", "outbound", "inbound"]); // ascending
    expect(snap.latestInboundGmailMessageId).toBe("gm-2"); // the newest inbound gmail id
    expect(snap.latestInboundRfcMessageId).toBe("<r2@dealer.test>"); // the newest inbound rfc id
  });

  it("returns a null gmail + rfc anchor when no inbound message carries one", () => {
    const c = db.$client;
    c.prepare("INSERT INTO threads (thread_id, dealer_id, state, search_profile_id) VALUES ('t-1', ?, 'replied', ?)").run(DEALER, PROFILE);
    c.prepare(
      "INSERT INTO messages (message_id, thread_id, direction, received_at, gmail_message_id, rfc_message_id, search_profile_id, quote_extraction_status) VALUES ('m', 't-1', 'inbound', ?, NULL, NULL, ?, 'pending')",
    ).run(NOW, PROFILE);
    const snap = readThreadSnapshotForDraft(db, "t-1");
    expect(snap.latestInboundGmailMessageId).toBeNull();
    expect(snap.latestInboundRfcMessageId).toBeNull(); // legacy row → no threading header
  });

  it("surfaces the backend gmail_thread_id (requestBody.threadId), null when absent", () => {
    const c = db.$client;
    c.prepare(
      "INSERT INTO threads (thread_id, dealer_id, subject, gmail_thread_id, state, search_profile_id) VALUES ('t-tid', ?, 'Re: Tucson', 'backend-thread-42', 'replied', ?)",
    ).run(DEALER, PROFILE);
    c.prepare(
      "INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id) VALUES ('t-notid', ?, 'Re: Tucson', 'replied', ?)",
    ).run(DEALER, PROFILE);

    expect(readThreadSnapshotForDraft(db, "t-tid").gmailThreadId).toBe("backend-thread-42");
    expect(readThreadSnapshotForDraft(db, "t-notid").gmailThreadId).toBeNull(); // no backend id → top-level send
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

describe("readReplyTargetInputs → resolveReplyTarget chain (T3-U1 inject_contact effect)", () => {
  it("a seeded primary contact + linked inbound message resolves to rung-1 primary_reply_target (beats rung-4 contact_email)", () => {
    const c = db.$client;
    c.prepare("INSERT INTO threads (thread_id, dealer_id, state, search_profile_id) VALUES ('t-1', ?, 'replied', ?)").run(DEALER, PROFILE);
    // Mirror what serve-live's injectContact writes: a primary dealer_contacts row
    // + the inbound message's contact_id. DEALER already carries contact_email
    // (rung 4) from beforeEach, so a primary_reply_target result proves rung 1 beat
    // the rung-4 fallback — i.e. inject_contact lifts the live lane off rung 4.
    c.prepare(
      "INSERT INTO dealer_contacts (contact_id, dealer_id, email, display_name, normalized_email, role, is_primary_reply_target, search_profile_id) " +
        "VALUES ('live-contact-1', ?, 'Alex.Tan@jimclick.example.com', 'Alex Tan', 'alex.tan@jimclick.example.com', 'sales_manager', 1, ?)",
    ).run(DEALER, PROFILE);
    c.prepare(
      "INSERT INTO messages (message_id, thread_id, direction, contact_id, sender_email, received_at, search_profile_id, quote_extraction_status) " +
        "VALUES ('m-in', 't-1', 'inbound', 'live-contact-1', 'Alex.Tan@jimclick.example.com', ?, ?, 'pending')",
    ).run(NOW, PROFILE);

    const resolved = resolveReplyTarget(readReplyTargetInputs(db, { profileId: PROFILE, dealerId: DEALER, threadId: "t-1" }));
    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe("primary_reply_target"); // rung 1, NOT rung-4 dealer_contact_email
    expect(resolved!.email).toBe("Alex.Tan@jimclick.example.com");
    expect(resolved!.contactId).toBe("live-contact-1");
  });
});
