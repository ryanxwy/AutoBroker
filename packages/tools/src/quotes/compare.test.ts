/**
 * L1 DB tests — the quote-compare ranker. Freezes:
 *   - undecided populates BOTH buckets, ranked OTD ASC, finance vs lease tagged;
 *   - finance / lease preference populates one bucket (stray off-mode hidden);
 *   - cash preference ranks the cash bucket (finance/lease empty); profile-missing/NULL → all empty;
 *   - the audit-flag join decodes the latest audit's codes;
 *   - latest-audit-per-quote = (audited_at DESC, audit_id DESC) LIMIT 1 — the
 *     same-timestamp AND different-date cases both pick v2, no duplicate row;
 *   - NULL otd_total sorts LAST.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; the committed
 * migration SQL runs against the throwaway DB. Never touches a real data dir.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/db";

import { rankQuotesForProfile } from "./compare.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

const PROFILE = "p-cmp-1";

/** Seed the profile with a given financing_preference (null leaves the column
 *  NULL). */
function insertProfile(id: string, preference: string | null): void {
  if (preference === null) {
    db.$client
      .prepare(
        "INSERT INTO search_profiles (search_profile_id, year, make, model, brand, status) " +
          "VALUES (?, 2026, 'Hyundai', 'Tucson', 'Hyundai', 'active')",
      )
      .run(id);
  } else {
    db.$client
      .prepare(
        "INSERT INTO search_profiles (search_profile_id, year, make, model, brand, financing_preference, status) " +
          "VALUES (?, 2026, 'Hyundai', 'Tucson', 'Hyundai', ?, 'active')",
      )
      .run(id, preference);
  }
}

function insertDealer(id: string, name: string): void {
  db.$client
    .prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')")
    .run(id, name);
}

function insertMessage(messageId: string): void {
  db.$client
    .prepare(
      "INSERT INTO messages (message_id, direction, quote_extraction_status, quote_extraction_intent) " +
        "VALUES (?, 'inbound', 'succeeded', 'quote')",
    )
    .run(messageId);
}

interface QuoteSeed {
  quoteId: string;
  dealerId: string;
  mode: "finance" | "lease" | "cash" | "unspecified";
  otdTotal: number | null;
  /** finance-only: apr / down / monthly. */
  apr?: number | null;
  downOrDas?: number | null;
  monthly?: number | null;
  /** lease-only money factor. */
  mf?: number | null;
}

/** Mode-conditional column writes: apr/down/monthly land in finance_* only for
 *  finance, mf/das/monthly in lease_* only for lease. finance_term=60,
 *  lease_term=36. */
function insertQuote(s: QuoteSeed): void {
  const messageId = `msg-${s.quoteId}`;
  insertMessage(messageId);
  const isFinance = s.mode === "finance";
  const isLease = s.mode === "lease";
  db.$client
    .prepare(
      "INSERT INTO dealer_quotes " +
        "(quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, financing_mode, " +
        " otd_total, finance_apr, finance_down_payment, finance_monthly_payment, finance_term_months, " +
        " lease_money_factor, lease_due_at_signing, lease_monthly_payment, lease_term_months) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      s.quoteId,
      s.dealerId,
      messageId,
      messageId,
      PROFILE,
      s.mode,
      s.otdTotal,
      isFinance ? (s.apr ?? null) : null,
      isFinance ? (s.downOrDas ?? null) : null,
      isFinance ? (s.monthly ?? null) : null,
      isFinance ? 60 : null,
      isLease ? (s.mf ?? null) : null,
      isLease ? (s.downOrDas ?? null) : null,
      isLease ? (s.monthly ?? null) : null,
      isLease ? 36 : null,
    );
}

/** Write one audit row with the given codes, pass version, and audited_at. */
function insertAudit(
  quoteId: string,
  codes: string[],
  passVersion = "v1",
  auditedAt = "2026-05-05 12:00:00",
): void {
  const flagsJson = JSON.stringify(
    codes.map((c) => ({ code: c, severity: "warn", evidence: "test" })),
  );
  db.$client
    .prepare(
      "INSERT INTO quote_audits (dealer_quote_id, search_profile_id, flags_json, audited_at, audit_pass_version) " +
        "VALUES (?, ?, ?, ?, ?)",
    )
    .run(quoteId, PROFILE, flagsJson, auditedAt, passVersion);
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-compare-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
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
  db.$client.prepare("DELETE FROM quote_audits").run();
  db.$client.prepare("DELETE FROM dealer_quotes").run();
  db.$client.prepare("DELETE FROM messages").run();
  db.$client.prepare("DELETE FROM dealers").run();
  db.$client.prepare("DELETE FROM search_profiles").run();
});

describe("rankQuotesForProfile", () => {
  it("undecided → both lists, each ranked OTD ASC, mode-tagged", () => {
    insertProfile(PROFILE, "undecided");
    insertDealer("d-A", "Alpha Hyundai");
    insertDealer("d-B", "Bravo Hyundai");
    insertDealer("d-C", "Charlie Hyundai");
    // 3 finance (otd 44540 / 42987 / 46200) → order [d-B, d-A, d-C].
    insertQuote({ quoteId: "f-A", dealerId: "d-A", mode: "finance", otdTotal: 44540, apr: 6.5 });
    insertQuote({ quoteId: "f-B", dealerId: "d-B", mode: "finance", otdTotal: 42987, apr: 7.9 });
    insertQuote({ quoteId: "f-C", dealerId: "d-C", mode: "finance", otdTotal: 46200, apr: 5.0 });
    // 2 lease (das 4500 / 3800) → order [d-B, d-A] by otd.
    insertQuote({ quoteId: "l-A", dealerId: "d-A", mode: "lease", otdTotal: 38000, mf: 0.0012 });
    insertQuote({ quoteId: "l-B", dealerId: "d-B", mode: "lease", otdTotal: 36000, mf: 0.00115 });

    const result = rankQuotesForProfile(db, PROFILE);

    expect(result.finance).toHaveLength(3);
    expect(result.lease).toHaveLength(2);
    expect(result.finance.map((q) => q.dealer_id)).toEqual(["d-B", "d-A", "d-C"]);
    expect(result.finance.map((q) => q.rank)).toEqual([1, 2, 3]);
    expect(result.finance[0]!.apr_or_mf).toBe("7.9%");
    expect(result.finance[0]!.dealer_name).toBe("Bravo Hyundai");
    expect(result.lease.map((q) => q.dealer_id)).toEqual(["d-B", "d-A"]);
    expect(result.lease[0]!.apr_or_mf).toBe("MF 0.00115");
    expect(result.finance.every((q) => q.financing_mode === "finance")).toBe(true);
    expect(result.lease.every((q) => q.financing_mode === "lease")).toBe(true);
  });

  it("finance pref → 5 finance ranked, lease empty", () => {
    insertProfile(PROFILE, "finance");
    for (let i = 0; i < 5; i++) {
      insertDealer(`d-${i}`, `Dealer ${i}`);
      insertQuote({
        quoteId: `f-${i}`,
        dealerId: `d-${i}`,
        mode: "finance",
        otdTotal: 40000 + i * 1000,
      });
    }
    const result = rankQuotesForProfile(db, PROFILE);
    expect(result.finance).toHaveLength(5);
    expect(result.lease).toEqual([]);
    expect(result.finance.map((q) => q.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("undecided, no quotes → both empty", () => {
    insertProfile(PROFILE, "undecided");
    const result = rankQuotesForProfile(db, PROFILE);
    expect(result.finance).toEqual([]);
    expect(result.lease).toEqual([]);
  });

  it("finance pref → off-mode OTD quotes (unspecified / cash) still compare", () => {
    // The live 巡检 saw 3 of 4 real dealer quotes vanish from the compare because
    // the extractor classified OTD-bearing quotes as 'cash'/'unspecified'. An OTD
    // total is the mode-agnostic drive-off price, so these belong in the finance
    // view; only an explicit 'lease' (a payment, not an OTD) is excluded.
    insertProfile(PROFILE, "finance");
    insertDealer("d-A", "Alpha");
    insertDealer("d-B", "Bravo");
    insertDealer("d-C", "Charlie");
    insertDealer("d-D", "Delta");
    insertQuote({ quoteId: "f-A", dealerId: "d-A", mode: "finance", otdTotal: 37500 });
    insertQuote({ quoteId: "u-B", dealerId: "d-B", mode: "unspecified", otdTotal: 36900 });
    insertQuote({ quoteId: "c-C", dealerId: "d-C", mode: "cash", otdTotal: 38200 });
    insertQuote({ quoteId: "l-D", dealerId: "d-D", mode: "lease", otdTotal: 35000, mf: 0.0012 });

    const result = rankQuotesForProfile(db, PROFILE);
    // All three OTD quotes appear in the finance view, ranked by OTD; the explicit
    // lease quote is excluded (a lease payment is not an OTD total), and the
    // finance-preference path returns no lease bucket.
    expect(result.finance.map((q) => q.dealer_id)).toEqual(["d-B", "d-A", "d-C"]);
    expect(result.finance.map((q) => q.financing_mode)).toEqual(["unspecified", "finance", "cash"]);
    expect(result.lease).toEqual([]);
  });

  it("audit flag join → latest audit's two codes decoded in order", () => {
    insertProfile(PROFILE, "finance");
    insertDealer("d-A", "Alpha Hyundai");
    insertQuote({ quoteId: "f-A", dealerId: "d-A", mode: "finance", otdTotal: 44000, apr: 8.0 });
    insertAudit("f-A", ["APR_MARKUP", "DEALER_FEE_OUTLIER"]);
    const result = rankQuotesForProfile(db, PROFILE);
    expect(result.finance).toHaveLength(1);
    expect(result.finance[0]!.audit_flag_summary).toEqual(["APR_MARKUP", "DEALER_FEE_OUTLIER"]);
  });

  it("latest-audit-per-quote: same audited_at → v2 wins via audit_id DESC, no dup row", () => {
    insertProfile(PROFILE, "finance");
    insertDealer("d-A", "Alpha Hyundai");
    insertQuote({ quoteId: "f-A", dealerId: "d-A", mode: "finance", otdTotal: 44000 });
    // Two audit rows, SAME audited_at; v2 is inserted later (higher audit_id).
    insertAudit("f-A", ["MISSING_BREAKDOWN"], "v1", "2026-05-05 12:00:00");
    insertAudit("f-A", ["APR_MARKUP"], "v2", "2026-05-05 12:00:00");
    const result = rankQuotesForProfile(db, PROFILE);
    expect(result.finance).toHaveLength(1); // no duplicate row from the double-join
    expect(result.finance[0]!.audit_flag_summary).toEqual(["APR_MARKUP"]); // v2 wins
  });

  it("latest-audit-per-quote: different audited_at → newest date wins, no dup row", () => {
    insertProfile(PROFILE, "finance");
    insertDealer("d-A", "Alpha Hyundai");
    insertQuote({ quoteId: "f-A", dealerId: "d-A", mode: "finance", otdTotal: 44000 });
    // v2 has a LATER audited_at — it wins regardless of insertion order.
    insertAudit("f-A", ["APR_MARKUP"], "v2", "2026-05-05 00:00:00");
    insertAudit("f-A", ["MISSING_BREAKDOWN"], "v1", "2026-05-01 00:00:00");
    const result = rankQuotesForProfile(db, PROFILE);
    expect(result.finance).toHaveLength(1);
    expect(result.finance[0]!.audit_flag_summary).toEqual(["APR_MARKUP"]);
  });

  it("NULL otd_total sorts LAST", () => {
    insertProfile(PROFILE, "finance");
    insertDealer("d-A", "Alpha Hyundai");
    insertDealer("d-B", "Bravo Hyundai");
    insertDealer("d-C", "Charlie Hyundai");
    insertQuote({ quoteId: "f-A", dealerId: "d-A", mode: "finance", otdTotal: null });
    insertQuote({ quoteId: "f-B", dealerId: "d-B", mode: "finance", otdTotal: 42000 });
    insertQuote({ quoteId: "f-C", dealerId: "d-C", mode: "finance", otdTotal: 45000 });
    const result = rankQuotesForProfile(db, PROFILE);
    expect(result.finance.map((q) => q.dealer_id)).toEqual(["d-B", "d-C", "d-A"]);
    expect(result.finance[2]!.otd_total).toBeNull();
  });

  it("lease pref → stray finance hidden, lease ranked", () => {
    insertProfile(PROFILE, "lease");
    insertDealer("d-A", "Alpha Hyundai");
    insertDealer("d-B", "Bravo Hyundai");
    insertQuote({ quoteId: "l-A", dealerId: "d-A", mode: "lease", otdTotal: 38000, mf: 0.0012 });
    insertQuote({ quoteId: "l-B", dealerId: "d-B", mode: "lease", otdTotal: 36000, mf: 0.00115 });
    // A stray finance quote — must NOT appear (finance bucket stays empty).
    insertQuote({ quoteId: "f-X", dealerId: "d-A", mode: "finance", otdTotal: 30000 });
    const result = rankQuotesForProfile(db, PROFILE);
    expect(result.finance).toEqual([]);
    expect(result.lease).toHaveLength(2);
    expect(result.lease.map((q) => q.dealer_id)).toEqual(["d-B", "d-A"]);
  });

  it("cash pref → cash bucket ranked by OTD (finance/lease empty)", () => {
    insertProfile(PROFILE, "cash");
    insertDealer("d-A", "Alpha Hyundai");
    insertDealer("d-B", "Beta Hyundai");
    insertQuote({ quoteId: "c-A", dealerId: "d-A", mode: "cash", otdTotal: 41000 });
    insertQuote({ quoteId: "c-B", dealerId: "d-B", mode: "cash", otdTotal: 39500 });
    const result = rankQuotesForProfile(db, PROFILE);
    expect(result.finance).toEqual([]);
    expect(result.lease).toEqual([]);
    // A cash buyer's OTD quotes are now ranked (was an empty result, a real bug).
    expect(result.cash).toHaveLength(2);
    expect(result.cash.map((q) => q.dealer_id)).toEqual(["d-B", "d-A"]); // lowest OTD first
  });

  it("profile-not-found → both empty (preference null)", () => {
    // No profile row inserted.
    const result = rankQuotesForProfile(db, "no-such-profile");
    expect(result.financingPreference).toBeNull();
    expect(result.finance).toEqual([]);
    expect(result.lease).toEqual([]);
  });
});
