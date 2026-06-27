/**
 * L1 unit tests — listProfileDealerNegotiations: the derived-on-read per-DEALER
 * negotiation summary the cards grid renders. Proves the aggregates (email count
 * both directions, quote roll-up MIN otd / MAX discount, quote_sent), the
 * zero-thread dealer still appears, the per-dealer status rollup (most-actionable
 * + newest-activity tie-break), and the actionability sort. Read-only.
 *
 * ISOLATION: fresh os.tmpdir() AUTOBROKER_DATA_DIR; committed migrations; NEVER
 * touches ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "../db.js";
import {
  listProfileDealerNegotiations,
  readDealerNegotiationDetail,
  readDealerSubstantiveReplyBodies,
} from "./negotiationProjection.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = ["0000_military_red_skull.sql", "0001_redundant_ozymandias.sql", "0002_pale_thunderball.sql"].map(
  (f) => join(here, "..", "..", "..", "db", "drizzle", f),
);

const PROFILE = "prof-1";
const NOW = 2_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;

function dealer(c: Db["$client"], id: string, name: string): void {
  c.prepare("INSERT INTO dealers (dealer_id, name, city, state, country) VALUES (?, ?, 'Springfield', 'CA', 'US')").run(
    id,
    name,
  );
}
function bind(c: Db["$client"], dealerId: string): void {
  c.prepare("INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')").run(
    PROFILE,
    dealerId,
  );
}
function thread(c: Db["$client"], threadId: string, dealerId: string, state = "replied"): void {
  c.prepare("INSERT INTO threads (thread_id, dealer_id, state, search_profile_id) VALUES (?, ?, ?, ?)").run(
    threadId,
    dealerId,
    state,
    PROFILE,
  );
}
function inbound(c: Db["$client"], id: string, threadId: string, receivedAt: number): void {
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, direction, received_at, search_profile_id, quote_extraction_status) " +
      "VALUES (?, ?, 'inbound', ?, ?, 'pending')",
  ).run(id, threadId, receivedAt, PROFILE);
}
function outbound(c: Db["$client"], id: string, threadId: string, processedAt: number): void {
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, direction, processed_at, search_profile_id, quote_extraction_status) " +
      "VALUES (?, ?, 'outbound', ?, ?, 'pending')",
  ).run(id, threadId, processedAt, PROFILE);
}
/** An inbound message whose extraction FAILED (the CHECK requires intent NULL for
 *  status 'failed'). Counts toward extract_failed_count. */
function inboundFailed(c: Db["$client"], id: string, threadId: string, receivedAt: number): void {
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, direction, received_at, search_profile_id, " +
      "quote_extraction_status, quote_extraction_intent) " +
      "VALUES (?, ?, 'inbound', ?, ?, 'failed', NULL)",
  ).run(id, threadId, receivedAt, PROFILE);
}
function quote(
  c: Db["$client"],
  q: { quoteId: string; dealerId: string; otd: number; discount: number; vin: string; receivedAt: number },
): void {
  c.prepare(
    "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, " +
      "selling_price, doc_fee, otd_total, dealer_discount, quote_received_at, vin, confidence, financing_mode) " +
      "VALUES (?, ?, ?, ?, ?, ?, 500, ?, ?, ?, ?, 0.9, 'cash')",
  ).run(
    q.quoteId,
    q.dealerId,
    `m-${q.quoteId}`,
    `g-${q.quoteId}`,
    PROFILE,
    q.otd - 2000,
    q.otd,
    q.discount,
    q.receivedAt,
    q.vin,
  );
}

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-neg-proj-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env["AUTOBROKER_DB"];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
});

afterEach(() => {
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
});

describe("listProfileDealerNegotiations", () => {
  it("aggregates email count (both directions), quote roll-up (MIN otd / MAX discount), and includes a zero-thread dealer", () => {
    const c = db.$client;
    dealer(c, "d-active", "Active Hyundai");
    dealer(c, "d-bare", "Bare Hyundai");
    bind(c, "d-active");
    bind(c, "d-bare");

    // d-active: a thread with 2 inbound + 1 outbound message and two quotes on the
    // same vin — the newer one cheaper (countered). best_otd = MIN, best_discount = MAX.
    thread(c, "t-a", "d-active");
    inbound(c, "in-a1", "t-a", NOW - 3 * DAY);
    inbound(c, "in-a2", "t-a", NOW - 1 * DAY);
    outbound(c, "out-a1", "t-a", NOW - 2 * DAY);
    quote(c, { quoteId: "q-a1", dealerId: "d-active", otd: 47000, discount: 1500, vin: "VA", receivedAt: NOW - 3 * DAY });
    quote(c, { quoteId: "q-a2", dealerId: "d-active", otd: 45000, discount: 2500, vin: "VA", receivedAt: NOW - 1 * DAY });

    const rows = listProfileDealerNegotiations(db, PROFILE, { nowMs: NOW });
    const byId = new Map(rows.map((r) => [r.dealer_id, r]));

    const active = byId.get("d-active")!;
    expect(active.email_count).toBe(3); // 2 inbound + 1 outbound
    expect(active.quote_sent).toBe(true);
    expect(active.best_otd).toBe(45000); // MIN(otd_total)
    expect(active.best_discount).toBe(2500); // MAX(dealer_discount)
    expect(active.negotiation_status).toBe("countered"); // OTD dropped on the same vin
    expect(active.city).toBe("Springfield");
    expect(active.state).toBe("CA");

    const bare = byId.get("d-bare")!;
    expect(bare.email_count).toBe(0); // zero-thread dealer still appears
    expect(bare.quote_sent).toBe(false);
    expect(bare.best_otd).toBeNull();
    expect(bare.best_discount).toBeNull();
    expect(bare.negotiation_status).toBeUndefined(); // no thread → no status chip
  });

  it("counts each dealer's inbound failed-extraction messages (extract_failed_count); a clean dealer is 0", () => {
    const c = db.$client;
    dealer(c, "d-fail", "Fail Hyundai");
    dealer(c, "d-clean", "Clean Hyundai");
    bind(c, "d-fail");
    bind(c, "d-clean");

    // d-fail: one pending inbound + one FAILED inbound → extract_failed_count 1.
    thread(c, "t-f", "d-fail");
    inbound(c, "in-f-ok", "t-f", NOW - 2 * DAY);
    inboundFailed(c, "in-f-bad", "t-f", NOW - 1 * DAY);

    // d-clean: a bare reply, no failure → extract_failed_count 0.
    thread(c, "t-cl", "d-clean");
    inbound(c, "in-cl", "t-cl", NOW - 1 * DAY);

    const rows = listProfileDealerNegotiations(db, PROFILE, { nowMs: NOW });
    const byId = new Map(rows.map((r) => [r.dealer_id, r]));
    expect(byId.get("d-fail")!.extract_failed_count).toBe(1);
    expect(byId.get("d-clean")!.extract_failed_count).toBe(0);
  });

  it("reduces a multi-thread dealer to its MOST-ACTIONABLE status (rank-min wins over recency)", () => {
    const c = db.$client;
    dealer(c, "d-multi", "Multi Hyundai");
    bind(c, "d-multi");

    // Two threads with DISTINCT ranks, driven by persisted state (so the per-dealer
    // quote coupling can't collapse them to one status — this dealer has no quote):
    //   - t-agreed: state='agreed' → "agreed" (rank 6), the LESS actionable terminal
    //     state, and it carries the NEWER activity (NOW-1*DAY).
    //   - t-replied: a bare reply → "replied" (rank 3), MORE actionable, OLDER
    //     activity (NOW-2*DAY).
    // Thread-id sort ("t-agreed" < "t-replied") visits the rank-6 thread FIRST, so
    // the rank-min reduction must REPLACE it with the rank-3 thread — proving the
    // rollup keeps the lower rank even though the higher-rank thread is newer.
    thread(c, "t-agreed", "d-multi", "agreed");
    inbound(c, "in-a", "t-agreed", NOW - 1 * DAY);
    thread(c, "t-replied", "d-multi", "replied");
    inbound(c, "in-r", "t-replied", NOW - 2 * DAY);

    const rows = listProfileDealerNegotiations(db, PROFILE, { nowMs: NOW });
    const multi = rows.filter((r) => r.dealer_id === "d-multi");
    expect(multi).toHaveLength(1); // ONE record per dealer
    expect(multi[0]!.negotiation_status).toBe("replied"); // rank 3 < rank 6, kept
  });

  it("sorts by actionability: status rank asc, then batna_gap_usd desc, then name asc, zero-thread last", () => {
    const c = db.$client;
    // countered (rank 0) — cheapest itemized, will read countered vs a prior round.
    dealer(c, "d-countered", "Zeta Hyundai"); // name late alphabetically to prove rank wins over name
    bind(c, "d-countered");
    thread(c, "t-c", "d-countered");
    inbound(c, "in-c1", "t-c", NOW - 2 * DAY);
    inbound(c, "in-c2", "t-c", NOW - 1 * DAY);
    quote(c, { quoteId: "q-c1", dealerId: "d-countered", otd: 47000, discount: 1000, vin: "VC", receivedAt: NOW - 2 * DAY });
    quote(c, { quoteId: "q-c2", dealerId: "d-countered", otd: 44000, discount: 3000, vin: "VC", receivedAt: NOW - 1 * DAY });

    // replied (rank 3) — bare reply, no quote.
    dealer(c, "d-replied", "Alpha Hyundai");
    bind(c, "d-replied");
    thread(c, "t-r", "d-replied");
    inbound(c, "in-r", "t-r", NOW - 1 * DAY);

    // zero-thread — must sort LAST regardless of name.
    dealer(c, "d-bare", "Aaa Hyundai");
    bind(c, "d-bare");

    const rows = listProfileDealerNegotiations(db, PROFILE, { nowMs: NOW });
    expect(rows.map((r) => r.dealer_id)).toEqual(["d-countered", "d-replied", "d-bare"]);
    expect(rows[0]!.negotiation_status).toBe("countered");
    expect(rows[2]!.negotiation_status).toBeUndefined(); // zero-thread last
  });
});

/** Insert an inbound message with sender/subject/body + extraction intent. The
 *  check constraint requires intent NULL ⇔ status 'pending'. */
function richInbound(
  c: Db["$client"],
  a: {
    id: string;
    threadId: string;
    receivedAt: number;
    senderEmail: string;
    subject: string;
    body: string;
    intent?: string | null;
  },
): void {
  const intent = a.intent ?? null;
  const status = intent === null ? "pending" : "succeeded";
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, direction, sender_email, subject, body_text, received_at, " +
      "search_profile_id, quote_extraction_status, quote_extraction_intent) " +
      "VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?)",
  ).run(a.id, a.threadId, a.senderEmail, a.subject, a.body, a.receivedAt, PROFILE, status, intent);
}

describe("readDealerNegotiationDetail", () => {
  it("returns redacted newest-first substantive replies, competing scalars without a name, and the computed BATNA gap", () => {
    const c = db.$client;
    dealer(c, "d-x", "Detail Hyundai");
    dealer(c, "d-rival", "Rival Hyundai");
    bind(c, "d-x");
    bind(c, "d-rival");

    thread(c, "t-x", "d-x");
    // Two SUBSTANTIVE replies (carry a quote signal) — shown, newest first.
    richInbound(c, {
      id: "in-old",
      threadId: "t-x",
      receivedAt: NOW - 3 * DAY,
      senderEmail: "sales@detailhyundai.com",
      subject: "Quote",
      body: "Thanks for the OTD request — here is $41,000 out-the-door.",
    });
    richInbound(c, {
      id: "in-good",
      threadId: "t-x",
      receivedAt: NOW - 1 * DAY,
      senderEmail: "sales@detailhyundai.com",
      subject: "Re: Your quote",
      body: "Out-the-door is $40,000 and your budget of $35,000 is noted on file.",
    });
    // Auto-reply (subject) and a marketing blast — both HIDDEN.
    richInbound(c, {
      id: "in-auto",
      threadId: "t-x",
      receivedAt: NOW - 2 * DAY,
      senderEmail: "sales@detailhyundai.com",
      subject: "Automatic reply: out of office",
      body: "I am away until Monday.",
    });
    richInbound(c, {
      id: "in-mktg",
      threadId: "t-x",
      receivedAt: NOW - 2 * DAY,
      senderEmail: "promos@detailhyundai.com",
      subject: "Year-end event — manager's special!",
      body: "Visit us this weekend only. unsubscribe here.",
    });

    // d-x: an itemized open quote at 40000. d-rival: a cheaper itemized open quote
    // at 37000 (the competing BATNA). batna_gap = 40000 - 37000 = 3000.
    quote(c, { quoteId: "q-x", dealerId: "d-x", otd: 40000, discount: 2000, vin: "VX", receivedAt: NOW - 1 * DAY });
    quote(c, { quoteId: "q-rival", dealerId: "d-rival", otd: 37000, discount: 3000, vin: "VR", receivedAt: NOW - 1 * DAY });

    const detail = readDealerNegotiationDetail(db, { profileId: PROFILE, dealerId: "d-x", nowMs: NOW })!;
    expect(detail).not.toBeNull();
    expect(detail.name).toBe("Detail Hyundai");

    // newest-first, auto-reply + marketing hidden.
    expect(detail.replies.map((r) => r.message_id)).toEqual(["in-good", "in-old"]);

    // budget redacted in the body excerpt (the $35,000 budget phrase is gone).
    const goodExcerpt = detail.replies[0]!.body_excerpt!;
    expect(goodExcerpt).toContain("[redacted]");
    expect(goodExcerpt).not.toContain("35,000");
    expect(goodExcerpt).toContain("40,000"); // the dealer's own OTD stays

    // competing figure present, computed gap, NO competitor name anywhere.
    expect(detail.best_competing_otd).toBe(37000);
    expect(detail.batna_gap_usd).toBe(3000);
    expect(JSON.stringify(detail)).not.toContain("Rival");
  });

  it("returns null for a dealer not bound to the profile", () => {
    const c = db.$client;
    dealer(c, "d-unbound", "Unbound Hyundai"); // exists but never bound to PROFILE
    expect(readDealerNegotiationDetail(db, { profileId: PROFILE, dealerId: "d-unbound", nowMs: NOW })).toBeNull();
    expect(readDealerNegotiationDetail(db, { profileId: PROFILE, dealerId: "d-missing", nowMs: NOW })).toBeNull();
  });

  it("readDealerSubstantiveReplyBodies returns the SAME T2-filtered set, redacted (for T8)", () => {
    const c = db.$client;
    dealer(c, "d-x", "Detail Hyundai");
    bind(c, "d-x");
    thread(c, "t-x", "d-x");
    richInbound(c, {
      id: "in-good",
      threadId: "t-x",
      receivedAt: NOW - 1 * DAY,
      senderEmail: "sales@detailhyundai.com",
      subject: "Re: Your quote",
      body: "Out-the-door is $40,000 and your budget of $35,000 is noted.",
    });
    richInbound(c, {
      id: "in-auto",
      threadId: "t-x",
      receivedAt: NOW - 2 * DAY,
      senderEmail: "sales@detailhyundai.com",
      subject: "Automatic reply: out of office",
      body: "Away until Monday.",
    });

    const bodies = readDealerSubstantiveReplyBodies(db, { profileId: PROFILE, dealerId: "d-x" });
    expect(bodies).toHaveLength(1); // only the substantive reply
    expect(bodies[0]).toContain("[redacted]");
    expect(bodies[0]).not.toContain("35,000");
  });
});
