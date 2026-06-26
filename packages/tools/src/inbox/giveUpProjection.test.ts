/**
 * L1 unit tests — listProfileDealerVerdicts: the derived-on-read per-dealer
 * give-up advisory the Dealers canvas renders. Composes the candidate-thread
 * read + the pure timing-gate / follow-up-cap deciders + readDealerGiveUpInputs +
 * dealerGiveUpDecision, using the BATCH 7-day silence window (so the verdict
 * reflects when negotiation_followup actually drops a dealer). Read-only.
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
import { listProfileDealerRowsWithVerdicts, listProfileDealerVerdicts } from "./giveUpProjection.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = ["0000_military_red_skull.sql", "0001_redundant_ozymandias.sql", "0002_pale_thunderball.sql"].map(
  (f) => join(here, "..", "..", "..", "db", "drizzle", f),
);

const PROFILE = "prof-1";
const COLD = "dealer-cold";
const FRESH = "dealer-fresh";
const NOW = 2_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;

function thread(c: Db["$client"], threadId: string, dealerId: string): void {
  c.prepare("INSERT INTO threads (thread_id, dealer_id, state, search_profile_id) VALUES (?, ?, 'replied', ?)").run(
    threadId,
    dealerId,
    PROFILE,
  );
}
function inbound(c: Db["$client"], id: string, threadId: string, receivedAt: number): void {
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, direction, received_at, search_profile_id, quote_extraction_status) " +
      "VALUES (?, ?, 'inbound', ?, ?, 'pending')",
  ).run(id, threadId, receivedAt, PROFILE);
}
function profileDealer(c: Db["$client"], dealerId: string): void {
  c.prepare("INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')").run(
    PROFILE,
    dealerId,
  );
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
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-giveup-proj-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env["AUTOBROKER_DB"];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
  db.$client.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, 'Cold Hyundai', 'US')").run(COLD);
  db.$client.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, 'Fresh Hyundai', 'US')").run(FRESH);
});

afterEach(() => {
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
});

describe("listProfileDealerVerdicts", () => {
  it("flags a cold dealer with a cheaper itemized competitor as give_up_switch, and the competitor as continue", () => {
    const c = db.$client;
    // COLD dealer: last inbound 9 days ago (> the 7-day batch silence window) and
    // an itemized open quote at 46000.
    thread(c, "t-cold", COLD);
    inbound(c, "in-cold", "t-cold", NOW - 9 * DAY);
    quote(c, { quoteId: "q-cold", dealerId: COLD, otd: 46000, vin: "VC", receivedAt: NOW - 9 * DAY });
    // FRESH competitor: a recent inbound and a CHEAPER itemized open quote at 45000.
    thread(c, "t-fresh", FRESH);
    inbound(c, "in-fresh", "t-fresh", NOW - 1 * DAY);
    quote(c, { quoteId: "q-fresh", dealerId: FRESH, otd: 45000, vin: "VF", receivedAt: NOW - 1 * DAY });

    const rows = listProfileDealerVerdicts(db, PROFILE, { nowMs: NOW });
    const byDealer = new Map(rows.map((r) => [r.dealerId, r]));

    const cold = byDealer.get(COLD)!;
    expect(cold.verdict).toBe("give_up_switch"); // cold (gate=skip) + Fresh is $1000 cheaper
    expect(cold.reason).toBe("silent");
    expect(cold.batnaGapUsd).toBe(1000);

    const fresh = byDealer.get(FRESH)!;
    expect(fresh.verdict).toBe("continue"); // recent, and it is the cheaper one (no better alt)
    expect(fresh.reason).toBe("active");
  });

  it("holds a cold dealer when it is the only quote (no competitor to switch to)", () => {
    const c = db.$client;
    thread(c, "t-only", COLD);
    inbound(c, "in-only", "t-only", NOW - 9 * DAY);
    quote(c, { quoteId: "q-only", dealerId: COLD, otd: 46000, vin: "VO", receivedAt: NOW - 9 * DAY });

    const rows = listProfileDealerVerdicts(db, PROFILE, { nowMs: NOW });
    const cold = rows.find((r) => r.dealerId === COLD)!;
    expect(cold.verdict).toBe("hold"); // cold but no alternative → never abandon the only quote
    expect(cold.reason).toBe("silent");
  });

  it("reduces a dealer's multiple threads to ONE verdict — an engaged (continue) thread wins over a cold one", () => {
    const c = db.$client;
    // One dealer, TWO threads: a cold one (give_up_switch-worthy) AND a recently
    // active one (continue). The dealer is engaged → must not read as a give-up.
    thread(c, "t-cold", COLD);
    inbound(c, "in-cold", "t-cold", NOW - 9 * DAY);
    thread(c, "t-active", COLD);
    inbound(c, "in-active", "t-active", NOW - 1 * DAY);
    quote(c, { quoteId: "q-multi", dealerId: COLD, otd: 46000, vin: "VM", receivedAt: NOW - 9 * DAY });
    // a cheaper competitor that would make the COLD thread give_up_switch in isolation.
    thread(c, "t-fresh", FRESH);
    inbound(c, "in-fresh", "t-fresh", NOW - 1 * DAY);
    quote(c, { quoteId: "q-fresh", dealerId: FRESH, otd: 45000, vin: "VF", receivedAt: NOW - 1 * DAY });

    const rows = listProfileDealerVerdicts(db, PROFILE, { nowMs: NOW });
    const cold = rows.filter((r) => r.dealerId === COLD);
    expect(cold).toHaveLength(1); // reduced to ONE row per dealer (no coin-flip dup)
    expect(cold[0]!.verdict).toBe("continue"); // engaged thread wins — never abandon an active dealer
  });

  it("excludes a terminal (closed) thread from the advisory (agreed/suppressed share the path)", () => {
    const c = db.$client;
    c.prepare("INSERT INTO threads (thread_id, dealer_id, state, search_profile_id) VALUES ('t-closed', ?, 'closed', ?)").run(COLD, PROFILE);
    inbound(c, "in-closed", "t-closed", NOW - 9 * DAY);
    quote(c, { quoteId: "q-closed", dealerId: COLD, otd: 46000, vin: "VX", receivedAt: NOW - 9 * DAY });

    const rows = listProfileDealerVerdicts(db, PROFILE, { nowMs: NOW });
    expect(rows.find((r) => r.dealerId === COLD)).toBeUndefined(); // a closed deal gets no give-up verdict
  });

  it("listProfileDealerRowsWithVerdicts merges the verdict by dealer_id; a dealer with no active thread gets none", () => {
    const c = db.$client;
    profileDealer(c, COLD);
    profileDealer(c, FRESH);
    // COLD: cold thread + the only quote vs FRESH's cheaper itemized quote.
    thread(c, "t-cold", COLD);
    inbound(c, "in-cold", "t-cold", NOW - 9 * DAY);
    quote(c, { quoteId: "q-cold", dealerId: COLD, otd: 46000, vin: "VC", receivedAt: NOW - 9 * DAY });
    thread(c, "t-fresh", FRESH);
    inbound(c, "in-fresh", "t-fresh", NOW - 1 * DAY);
    quote(c, { quoteId: "q-fresh", dealerId: FRESH, otd: 45000, vin: "VF", receivedAt: NOW - 1 * DAY });

    const rows = listProfileDealerRowsWithVerdicts(db, PROFILE, { nowMs: NOW });
    const byId = new Map(rows.map((r) => [r.dealer_id as string, r]));
    expect(byId.get(COLD)!.verdict).toBe("give_up_switch");
    expect(byId.get(COLD)!.batna_gap_usd).toBe(1000);
    expect(byId.get(FRESH)!.verdict).toBe("continue");
    // No buyer-budget field leaks onto the row, and the competing dealer is not named.
    expect(JSON.stringify(byId.get(COLD))).not.toContain(FRESH); // no competitor name/id on the row
  });
});
