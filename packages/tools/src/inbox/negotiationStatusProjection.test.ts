/**
 * L1 unit tests — the per-thread negotiation-status projection. Proves the derived
 * status (countered / stalled / dormant / quoted) over seeded threads, and that
 * listProfileThreadRowsWithStatus re-orders by the HONEST last_activity_at (newest
 * message first, normalized to ISO), not the clobbered threads.updated_at.
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
import { listProfileThreadRowsWithStatus, listProfileThreadStatuses } from "./negotiationStatusProjection.js";

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

function dealer(c: Db["$client"], id: string): void {
  c.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')").run(id, `${id} Hyundai`);
}
function thread(c: Db["$client"], threadId: string, dealerId: string, state = "replied"): void {
  // updated_at is deliberately set to a FIXED early time to prove the projection
  // does NOT order by it (it is the clobbered, dishonest column).
  c.prepare(
    "INSERT INTO threads (thread_id, dealer_id, state, search_profile_id, updated_at) VALUES (?, ?, ?, ?, '2000-01-01T00:00:00.000Z')",
  ).run(threadId, dealerId, state, PROFILE);
}
function inbound(c: Db["$client"], id: string, threadId: string, receivedAt: number): void {
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, direction, received_at, search_profile_id, quote_extraction_status) " +
      "VALUES (?, ?, 'inbound', ?, ?, 'pending')",
  ).run(id, threadId, receivedAt, PROFILE);
}
function outbound(c: Db["$client"], id: string, threadId: string, processedAt: number): void {
  // An OUTBOUND follow-up carries processed_at, NOT received_at (received_at is NULL
  // on a send) — the case that proves last_activity_at COALESCEs both directions.
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, direction, processed_at, search_profile_id, quote_extraction_status) " +
      "VALUES (?, ?, 'outbound', ?, ?, 'pending')",
  ).run(id, threadId, processedAt, PROFILE);
}
function quote(
  c: Db["$client"],
  q: { quoteId: string; dealerId: string; otd: number; vin: string; receivedAt: number },
): void {
  c.prepare(
    "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, " +
      "selling_price, doc_fee, otd_total, quote_received_at, vin, confidence, financing_mode) " +
      "VALUES (?, ?, ?, ?, ?, ?, 500, ?, ?, ?, 0.9, 'cash')",
  ).run(q.quoteId, q.dealerId, `m-${q.quoteId}`, `g-${q.quoteId}`, PROFILE, q.otd - 2000, q.otd, q.receivedAt, q.vin);
}

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-negstatus-"));
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

describe("listProfileThreadStatuses", () => {
  it("derives countered / stalled / quoted / dormant from the quotes + gate", () => {
    const c = db.$client;
    // COUNTERED: OTD dropped 47000 -> 45000 on the same vin, recent reply.
    dealer(c, "d-counter");
    thread(c, "t-counter", "d-counter");
    inbound(c, "in-counter", "t-counter", NOW - 1 * DAY);
    quote(c, { quoteId: "qc1", dealerId: "d-counter", otd: 47000, vin: "VC", receivedAt: NOW - 3 * DAY });
    quote(c, { quoteId: "qc2", dealerId: "d-counter", otd: 45000, vin: "VC", receivedAt: NOW - 1 * DAY });
    // STALLED: OTD flat 46000 across two rounds, recent reply.
    dealer(c, "d-stall");
    thread(c, "t-stall", "d-stall");
    inbound(c, "in-stall", "t-stall", NOW - 2 * DAY);
    quote(c, { quoteId: "qs1", dealerId: "d-stall", otd: 46000, vin: "VS", receivedAt: NOW - 4 * DAY });
    quote(c, { quoteId: "qs2", dealerId: "d-stall", otd: 46000, vin: "VS", receivedAt: NOW - 2 * DAY });
    // QUOTED: a single open quote, recent reply.
    dealer(c, "d-quote");
    thread(c, "t-quote", "d-quote");
    inbound(c, "in-quote", "t-quote", NOW - 1 * DAY);
    quote(c, { quoteId: "qq1", dealerId: "d-quote", otd: 45000, vin: "VQ", receivedAt: NOW - 1 * DAY });
    // DORMANT: a cold thread (last reply 9d ago > the 7-day batch silence window).
    dealer(c, "d-dorm");
    thread(c, "t-dorm", "d-dorm");
    inbound(c, "in-dorm", "t-dorm", NOW - 9 * DAY);
    quote(c, { quoteId: "qd1", dealerId: "d-dorm", otd: 46000, vin: "VD", receivedAt: NOW - 9 * DAY });

    const byThread = new Map(listProfileThreadStatuses(db, PROFILE, { nowMs: NOW }).map((s) => [s.threadId, s.status]));
    expect(byThread.get("t-counter")).toBe("countered");
    expect(byThread.get("t-stall")).toBe("stalled");
    expect(byThread.get("t-quote")).toBe("quoted");
    expect(byThread.get("t-dorm")).toBe("dormant");
  });

  it("surfaces terminal threads as dead (closed) and agreed", () => {
    const c = db.$client;
    dealer(c, "d-closed");
    thread(c, "t-closed", "d-closed", "closed");
    inbound(c, "in-cl", "t-closed", NOW - 1 * DAY);
    dealer(c, "d-agreed");
    thread(c, "t-agreed", "d-agreed", "agreed");
    inbound(c, "in-ag", "t-agreed", NOW - 1 * DAY);

    const byThread = new Map(listProfileThreadStatuses(db, PROFILE, { nowMs: NOW }).map((s) => [s.threadId, s.status]));
    expect(byThread.get("t-closed")).toBe("dead");
    expect(byThread.get("t-agreed")).toBe("agreed");
  });
});

describe("listProfileThreadRowsWithStatus", () => {
  it("orders by the honest last_activity_at (newest message first), NOT the clobbered updated_at", () => {
    const c = db.$client;
    dealer(c, "d-old");
    thread(c, "t-old", "d-old");
    inbound(c, "in-old", "t-old", NOW - 10 * DAY);
    dealer(c, "d-new");
    thread(c, "t-new", "d-new");
    inbound(c, "in-new", "t-new", NOW - 1 * DAY);

    const rows = listProfileThreadRowsWithStatus(db, PROFILE, { nowMs: NOW });
    // Newest activity first — even though both threads share the SAME updated_at.
    expect(rows.map((r) => r.thread_id)).toEqual(["t-new", "t-old"]);
    // last_activity_at is normalized to an ISO string the UI can render.
    expect(typeof rows[0]!.last_activity_at).toBe("string");
    expect(rows[0]!.last_activity_at).toBe(new Date(NOW - 1 * DAY).toISOString());
    expect(rows[0]!.negotiation_status).toBe("replied"); // inbound, no quote
  });

  it("last_activity_at reflects an OUTBOUND follow-up (processed_at), not just the older inbound", () => {
    const c = db.$client;
    dealer(c, "d-fu");
    thread(c, "t-fu", "d-fu");
    inbound(c, "in-fu", "t-fu", NOW - 5 * DAY); // the dealer last replied 5 days ago
    outbound(c, "out-fu", "t-fu", NOW - 1 * DAY); // …but WE followed up 1 day ago

    const row = listProfileThreadRowsWithStatus(db, PROFILE, { nowMs: NOW }).find((r) => r.thread_id === "t-fu")!;
    // The honest last-touch is OUR send (1d), not the dealer's older reply (5d).
    expect(row.last_activity_at).toBe(new Date(NOW - 1 * DAY).toISOString());
  });
});
