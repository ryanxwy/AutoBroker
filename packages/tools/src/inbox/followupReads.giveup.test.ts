/**
 * L1 unit tests — readDealerGiveUpInputs: the give-up verdict's DB inputs.
 * Freezes the two adversarial-review must-fixes that live in the read:
 *   - the concession trajectory is scoped to the SAME vehicle (vin, else
 *     source_listing_id) so a cross-trim/cross-VIN quote pair is never read as a
 *     concession/stall, and is confidence-floored so a garbled re-quote can't
 *     fake a drop/jump;
 *   - the competing OTD is the SYMMETRIC guard: only ITEMIZED, confidence-floored
 *     other-dealer quotes can set the BATNA, so a lone non-itemized lowball
 *     phantom never recommends abandoning a solid dealer.
 * Plus an end-to-end of the commit-1 pieces (read → dealerGiveUpDecision).
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
import { readDealerGiveUpInputs } from "./followupReads.js";
import { dealerGiveUpDecision } from "../dealerComm/giveUp.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = ["0000_military_red_skull.sql", "0001_redundant_ozymandias.sql", "0002_pale_thunderball.sql"].map(
  (f) => join(here, "..", "..", "..", "db", "drizzle", f),
);

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;

const PROFILE = "prof-1";
const DEALER = "dealer-1";
const COMP = "dealer-2";
const NOW = 2_000_000_000_000;

/** Insert a dealer_quotes row (financing_mode NOT NULL). Supports the vehicle key
 *  (vin / source_listing_id), confidence, and the itemization columns. */
function insertQuote(
  c: Db["$client"],
  q: {
    quoteId: string;
    dealerId: string;
    profileId?: string;
    otd: number | null;
    selling?: number | null;
    docFee?: number | null;
    receivedAt: number;
    expiresAt?: number | null;
    vin?: string | null;
    sli?: string | null;
    confidence?: number | null;
    mode?: string;
  },
): void {
  c.prepare(
    "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, " +
      "selling_price, doc_fee, otd_total, quote_received_at, quote_expires_at, vin, source_listing_id, confidence, financing_mode) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    q.quoteId,
    q.dealerId,
    `msg-${q.quoteId}`,
    `gm-${q.quoteId}`,
    q.profileId ?? PROFILE,
    q.selling ?? null,
    q.docFee ?? null,
    q.otd,
    q.receivedAt,
    q.expiresAt ?? null,
    q.vin ?? null,
    q.sli ?? null,
    q.confidence ?? null,
    q.mode ?? "cash",
  );
}

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-giveup-read-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env["AUTOBROKER_DB"];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
  db.$client.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, 'Jim Click', 'US')").run(DEALER);
  db.$client.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, 'Larry Miller', 'US')").run(COMP);
});

afterEach(() => {
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
});

describe("readDealerGiveUpInputs", () => {
  it("scopes the trajectory to the SAME vin, newest-first, ignoring other vehicles", () => {
    const c = db.$client;
    // This dealer, VIN V1 — three quotes, flat OTD across rounds.
    insertQuote(c, { quoteId: "v1-a", dealerId: DEALER, otd: 46000, selling: 44000, docFee: 500, vin: "V1", receivedAt: NOW - 30000, confidence: 0.9 });
    insertQuote(c, { quoteId: "v1-b", dealerId: DEALER, otd: 46000, selling: 44000, docFee: 500, vin: "V1", receivedAt: NOW - 20000, confidence: 0.9 });
    insertQuote(c, { quoteId: "v1-c", dealerId: DEALER, otd: 46000, selling: 44000, docFee: 500, vin: "V1", receivedAt: NOW - 10000, confidence: 0.9 });
    // A DIFFERENT vehicle (loaded trim, VIN V2) at a higher OTD — must NOT pollute.
    insertQuote(c, { quoteId: "v2", dealerId: DEALER, otd: 49000, selling: 47000, docFee: 500, vin: "V2", receivedAt: NOW - 5000, confidence: 0.9 });

    const r = readDealerGiveUpInputs(db, { profileId: PROFILE, dealerId: DEALER, nowMs: NOW });
    // The latest open quote is V2 (newest), so the trajectory is V2's lineage —
    // a single quote (no movement), NOT a false stall from mixing V1 with V2.
    expect(r.currentOtd).toBe(49000);
    expect(r.otdTrajectory).toEqual([49000]);
  });

  it("builds a multi-round same-vin trajectory newest-first when the latest quote shares the vin", () => {
    const c = db.$client;
    insertQuote(c, { quoteId: "a", dealerId: DEALER, otd: 47000, selling: 45000, docFee: 500, vin: "VX", receivedAt: NOW - 30000, confidence: 0.9 });
    insertQuote(c, { quoteId: "b", dealerId: DEALER, otd: 46000, selling: 44000, docFee: 500, vin: "VX", receivedAt: NOW - 20000, confidence: 0.9 });
    insertQuote(c, { quoteId: "d", dealerId: DEALER, otd: 45000, selling: 43000, docFee: 500, vin: "VX", receivedAt: NOW - 10000, confidence: 0.9 });
    const r = readDealerGiveUpInputs(db, { profileId: PROFILE, dealerId: DEALER, nowMs: NOW });
    expect(r.otdTrajectory).toEqual([45000, 46000, 47000]); // newest first, conceding
  });

  it("excludes a garbled low-confidence newest quote from BOTH current and trajectory", () => {
    const c = db.$client;
    insertQuote(c, { quoteId: "good1", dealerId: DEALER, otd: 46000, selling: 44000, docFee: 500, vin: "VC", receivedAt: NOW - 30000, confidence: 0.9 });
    insertQuote(c, { quoteId: "good2", dealerId: DEALER, otd: 46000, selling: 44000, docFee: 500, vin: "VC", receivedAt: NOW - 20000, confidence: 0.9 });
    // A garbled re-extract with a wild OTD but low confidence — must be filtered
    // out of the current pick (else it would skew BATNA) AND the trajectory.
    insertQuote(c, { quoteId: "garbled", dealerId: DEALER, otd: 12000, selling: 11000, docFee: 500, vin: "VC", receivedAt: NOW - 10000, confidence: 0.2 });
    const r = readDealerGiveUpInputs(db, { profileId: PROFILE, dealerId: DEALER, nowMs: NOW });
    expect(r.currentOtd).toBe(46000); // the latest CONFIDENT quote, NOT the garbled 12000
    expect(r.otdTrajectory).not.toContain(12000);
    expect(r.otdTrajectory).toEqual([46000, 46000]);
  });

  it("the competing OTD is the symmetric guard: only ITEMIZED + confidence-floored other dealers count", () => {
    const c = db.$client;
    // This dealer: an itemized quote at 46000.
    insertQuote(c, { quoteId: "cur", dealerId: DEALER, otd: 46000, selling: 44000, docFee: 500, vin: "V1", receivedAt: NOW - 1000, confidence: 0.9 });
    // Competitor A: a NON-itemized lowball at 40000 (selling null) — must NOT count.
    insertQuote(c, { quoteId: "lowball", dealerId: COMP, otd: 40000, selling: null, docFee: null, receivedAt: NOW - 2000, confidence: 0.9 });
    // Competitor A: a LOW-confidence itemized quote at 39000 — must NOT count.
    insertQuote(c, { quoteId: "lowconf", dealerId: COMP, otd: 39000, selling: 37000, docFee: 400, receivedAt: NOW - 2000, confidence: 0.2 });
    // Competitor A: a real ITEMIZED, confident quote at 45000 — the only one that counts.
    insertQuote(c, { quoteId: "real", dealerId: COMP, otd: 45000, selling: 43000, docFee: 400, receivedAt: NOW - 2000, confidence: 0.9 });

    const r = readDealerGiveUpInputs(db, { profileId: PROFILE, dealerId: DEALER, nowMs: NOW });
    expect(r.bestCompetingOtd).toBe(45000); // NOT 40000 (non-itemized) or 39000 (low-conf)
    expect(r.isItemized).toBe(true);
  });

  it("no vehicle key on the current quote → trajectory is just the current OTD (no movement)", () => {
    const c = db.$client;
    insertQuote(c, { quoteId: "nokey", dealerId: DEALER, otd: 46000, selling: 44000, docFee: 500, vin: null, sli: null, receivedAt: NOW - 1000, confidence: 0.9 });
    const r = readDealerGiveUpInputs(db, { profileId: PROFILE, dealerId: DEALER, nowMs: NOW });
    expect(r.otdTrajectory).toEqual([46000]);
  });

  it("scopes the trajectory to the current quote's financing_mode (cash/finance siblings don't mix)", () => {
    const c = db.$client;
    // Three CASH rounds for VIN VM, flat at 46000.
    insertQuote(c, { quoteId: "cash-r1", dealerId: DEALER, otd: 46000, selling: 44000, docFee: 500, vin: "VM", mode: "cash", receivedAt: NOW - 30000, confidence: 0.9 });
    insertQuote(c, { quoteId: "cash-r2", dealerId: DEALER, otd: 46000, selling: 44000, docFee: 500, vin: "VM", mode: "cash", receivedAt: NOW - 20000, confidence: 0.9 });
    insertQuote(c, { quoteId: "cash-r3", dealerId: DEALER, otd: 46000, selling: 44000, docFee: 500, vin: "VM", mode: "cash", receivedAt: NOW - 10000, confidence: 0.9 });
    // A FINANCE sibling for the SAME vin at a very different OTD — must NOT enter
    // the cash trajectory (or it would fake a re-trade / non-monotonic series).
    insertQuote(c, { quoteId: "fin", dealerId: DEALER, otd: 30000, selling: 44000, docFee: 500, vin: "VM", mode: "finance", receivedAt: NOW - 15000, confidence: 0.9 });

    const r = readDealerGiveUpInputs(db, { profileId: PROFILE, dealerId: DEALER, nowMs: NOW });
    expect(r.currentOtd).toBe(46000); // the newest CASH quote is current
    expect(r.otdTrajectory).toEqual([46000, 46000, 46000]); // only the three cash rounds
    expect(r.otdTrajectory).not.toContain(30000); // the finance sibling is excluded
  });

  it("orders newest-first by parsed receive-time even when quote_received_at is an ISO string", () => {
    const c = db.$client;
    // ISO-8601 timestamps (the schema's other storage format). A SQL CAST AS
    // INTEGER would collapse all of these to 2026 and fall back to quote_id order —
    // so the quote_ids are deliberately REVERSED vs chronology: the old CAST code
    // would yield [47000,46000,45000] (wrong), only a real time sort gives the
    // conceding [45000,46000,47000].
    insertQuote(c, { quoteId: "iso-z", dealerId: DEALER, otd: 47000, selling: 45000, docFee: 500, vin: "VI", receivedAt: "2026-06-25T10:00:00.000Z" as unknown as number, confidence: 0.9 });
    insertQuote(c, { quoteId: "iso-m", dealerId: DEALER, otd: 46000, selling: 44000, docFee: 500, vin: "VI", receivedAt: "2026-06-25T11:00:00.000Z" as unknown as number, confidence: 0.9 });
    insertQuote(c, { quoteId: "iso-a", dealerId: DEALER, otd: 45000, selling: 43000, docFee: 500, vin: "VI", receivedAt: "2026-06-25T12:00:00.000Z" as unknown as number, confidence: 0.9 });

    const r = readDealerGiveUpInputs(db, { profileId: PROFILE, dealerId: DEALER, nowMs: Date.parse("2026-07-01T00:00:00Z") });
    expect(r.currentOtd).toBe(45000); // the chronologically newest ISO quote
    expect(r.otdTrajectory).toEqual([45000, 46000, 47000]); // newest-first, conceding
  });

  it("excludes a competing quote from a DIFFERENT profile (no cross-profile BATNA leak)", () => {
    const c = db.$client;
    insertQuote(c, { quoteId: "cur", dealerId: DEALER, otd: 46000, selling: 44000, docFee: 500, vin: "V1", receivedAt: NOW - 1000, confidence: 0.9 });
    // A cheaper itemized competitor — but for ANOTHER buyer's profile. Must NOT leak.
    insertQuote(c, { quoteId: "other-prof", dealerId: COMP, profileId: "prof-OTHER", otd: 40000, selling: 38000, docFee: 400, receivedAt: NOW - 2000, confidence: 0.9 });
    const r = readDealerGiveUpInputs(db, { profileId: PROFILE, dealerId: DEALER, nowMs: NOW });
    expect(r.bestCompetingOtd).toBeNull();
  });

  it("a cheaper FINANCE competitor does NOT set the BATNA for a CASH current (mode-comparable only)", () => {
    const c = db.$client;
    insertQuote(c, { quoteId: "cur", dealerId: DEALER, otd: 46000, selling: 44000, docFee: 500, vin: "V1", mode: "cash", receivedAt: NOW - 1000, confidence: 0.9 });
    // A competitor's itemized, confident FINANCE quote at 30000 — a different payment
    // structure, NOT comparable to the cash OTD, so it must never trigger a switch.
    insertQuote(c, { quoteId: "fin-comp", dealerId: COMP, otd: 30000, selling: 44000, docFee: 500, mode: "finance", receivedAt: NOW - 2000, confidence: 0.9 });

    const r = readDealerGiveUpInputs(db, { profileId: PROFILE, dealerId: DEALER, nowMs: NOW });
    expect(r.bestCompetingOtd).toBeNull(); // no SAME-mode (cash) competitor
    const d = dealerGiveUpDecision({
      gate: "skip", // even cold,
      cap: "ok",
      otdTrajectory: r.otdTrajectory,
      isItemized: r.isItemized,
      currentOtd: r.currentOtd,
      bestCompetingOtd: r.bestCompetingOtd,
    });
    expect(d.verdict).toBe("hold"); // …no comparable alternative → hold, never switch off a phantom finance gap
  });

  it("keeps a quote with a FUTURE ISO-string expiry (open-ness parsed in JS, not CAST)", () => {
    const c = db.$client;
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    // A future ISO expiry — a SQL CAST(... AS INTEGER) would read it as the year
    // 2027 and wrongly treat the quote as already expired.
    insertQuote(c, {
      quoteId: "fut",
      dealerId: DEALER,
      otd: 46000,
      selling: 44000,
      docFee: 500,
      vin: "VF",
      receivedAt: Date.parse("2026-05-01T00:00:00.000Z"),
      expiresAt: "2027-01-01T00:00:00.000Z" as unknown as number,
      confidence: 0.9,
    });
    const r = readDealerGiveUpInputs(db, { profileId: PROFILE, dealerId: DEALER, nowMs: now });
    expect(r.currentOtd).toBe(46000); // still open, NOT dropped as expired
  });

  it("orders deterministically by quote_id when two same-vehicle quotes share a received_at", () => {
    const c = db.$client;
    // Two cash quotes for VIN VT at the SAME received_at (a re-extract) — the
    // quote_id DESC tiebreak must give a stable, deterministic newest pick.
    insertQuote(c, { quoteId: "vt-aaa", dealerId: DEALER, otd: 46000, selling: 44000, docFee: 500, vin: "VT", receivedAt: NOW - 1000, confidence: 0.9 });
    insertQuote(c, { quoteId: "vt-zzz", dealerId: DEALER, otd: 47000, selling: 45000, docFee: 500, vin: "VT", receivedAt: NOW - 1000, confidence: 0.9 });
    const r = readDealerGiveUpInputs(db, { profileId: PROFILE, dealerId: DEALER, nowMs: NOW });
    expect(r.currentOtd).toBe(47000); // vt-zzz wins the quote_id DESC tiebreak
    expect(r.otdTrajectory).toEqual([47000, 46000]);
  });

  it("end-to-end: a cold dealer with a flat same-vin trajectory + a cheaper itemized competitor → give_up_switch", () => {
    const c = db.$client;
    insertQuote(c, { quoteId: "f1", dealerId: DEALER, otd: 46000, selling: 44000, docFee: 500, vin: "VV", receivedAt: NOW - 30000, confidence: 0.9 });
    insertQuote(c, { quoteId: "f2", dealerId: DEALER, otd: 46000, selling: 44000, docFee: 500, vin: "VV", receivedAt: NOW - 20000, confidence: 0.9 });
    insertQuote(c, { quoteId: "f3", dealerId: DEALER, otd: 46000, selling: 44000, docFee: 500, vin: "VV", receivedAt: NOW - 10000, confidence: 0.9 });
    insertQuote(c, { quoteId: "comp", dealerId: COMP, otd: 45000, selling: 43000, docFee: 400, receivedAt: NOW - 5000, confidence: 0.9 });

    const r = readDealerGiveUpInputs(db, { profileId: PROFILE, dealerId: DEALER, nowMs: NOW });
    // gate=ready/cap=ok, but the flat trajectory + cheaper itemized competitor is enough.
    const d = dealerGiveUpDecision({
      gate: "ready",
      cap: "ok",
      otdTrajectory: r.otdTrajectory,
      isItemized: r.isItemized,
      currentOtd: r.currentOtd,
      bestCompetingOtd: r.bestCompetingOtd,
    });
    expect(d.verdict).toBe("give_up_switch");
    expect(d.reason).toBe("non_improving");
    expect(d.batnaGapUsd).toBe(1000);
  });
});
