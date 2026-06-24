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
    // quote_id rides each ranked row (the detail-modal lookup key), aligned to
    // the OTD ranking.
    expect(result.finance.map((q) => q.quote_id)).toEqual(["f-B", "f-A", "f-C"]);
    expect(result.lease.map((q) => q.quote_id)).toEqual(["l-B", "l-A"]);
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

// --------------------------------------------------------------------------- //
// Cross-state OTD normalization + attribution (Phase 5)                        //
// --------------------------------------------------------------------------- //

/** Seed a profile carrying a home (registration) state — the rate source for
 *  cross-state tax normalization. */
function insertProfileWithState(id: string, preference: string, state: string): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, brand, financing_preference, state, status) " +
        "VALUES (?, 2026, 'Hyundai', 'Tucson', 'Hyundai', ?, ?, 'active')",
    )
    .run(id, preference, state);
}

interface FullQuoteSeed {
  quoteId: string;
  dealerId: string;
  sellingPrice: number | null;
  docFee: number | null;
  salesTax: number | null;
  otdTotal: number | null;
  rebates?: { amount: number }[];
}

/** Seed a finance quote with the component columns cross-state math reads. */
function insertQuoteWithComponents(s: FullQuoteSeed): void {
  const messageId = `msg-${s.quoteId}`;
  insertMessage(messageId);
  db.$client
    .prepare(
      "INSERT INTO dealer_quotes " +
        "(quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, financing_mode, " +
        " selling_price, doc_fee, sales_tax, rebates_json, otd_total, finance_term_months) " +
        "VALUES (?, ?, ?, ?, ?, 'finance', ?, ?, ?, ?, ?, 60)",
    )
    .run(
      s.quoteId,
      s.dealerId,
      messageId,
      messageId,
      PROFILE,
      s.sellingPrice,
      s.docFee,
      s.salesTax,
      s.rebates ? JSON.stringify(s.rebates) : null,
      s.otdTotal,
    );
}

describe("rankQuotesForProfile — cross-state normalization", () => {
  it("surfaces the buyer's home state + rate on the result", () => {
    insertProfileWithState(PROFILE, "finance", "CA");
    insertDealer("d-A", "Alpha");
    insertQuoteWithComponents({
      quoteId: "f-A",
      dealerId: "d-A",
      sellingPrice: 40000,
      docFee: 85,
      salesTax: 2900,
      otdTotal: 42985,
    });
    const result = rankQuotesForProfile(db, PROFILE);
    expect(result.homeState).toBe("CA");
    expect(result.homeStateTaxRate).toBe(0.0725);
  });

  it("TWO dealers in DIFFERENT states, same vehicle → IDENTICAL normalized tax", () => {
    // Buyer registers in CA. Dealer A (in CA) charged CA tax; dealer B (in OR, no
    // sales tax) charged $0 tax — B looks $2,900 cheaper on the RAW OTD. After
    // normalizing to the buyer's home (CA) tax, both have identical tax AND
    // identical OTD: the cross-state "win" was an illusion of where tax was
    // collected, not a real saving.
    insertProfileWithState(PROFILE, "finance", "CA");
    insertDealer("d-A", "Alpha CA");
    insertDealer("d-B", "Bravo OR");
    insertQuoteWithComponents({
      quoteId: "f-A",
      dealerId: "d-A",
      sellingPrice: 40000,
      docFee: 85,
      salesTax: 2900,
      otdTotal: 42985,
    });
    insertQuoteWithComponents({
      quoteId: "f-B",
      dealerId: "d-B",
      sellingPrice: 40000,
      docFee: 85,
      salesTax: 0,
      otdTotal: 40085,
    });
    const result = rankQuotesForProfile(db, PROFILE);
    const byId = new Map(result.finance.map((q) => [q.quote_id, q]));
    const a = byId.get("f-A")!;
    const b = byId.get("f-B")!;
    expect(a.normalized_tax).toBe(2900);
    expect(b.normalized_tax).toBe(2900);
    expect(a.normalized_tax).toBe(b.normalized_tax); // IDENTICAL tax
    expect(a.normalized_otd).toBe(42985);
    expect(b.normalized_otd).toBe(42985); // OR dealer picks up the omitted CA use tax
    // Raw ranking is unchanged (byte-identical): B still ranks first on raw OTD.
    expect(result.finance.map((q) => q.quote_id)).toEqual(["f-B", "f-A"]);
  });

  it("attributes an OTD delta to sale-price / doc-fee / tax components (residual reconciles)", () => {
    insertProfileWithState(PROFILE, "finance", "CA");
    insertDealer("d-A", "Alpha");
    insertDealer("d-B", "Bravo");
    // A: home CA, sp 40000 → tax 2900, otd 42985.
    insertQuoteWithComponents({
      quoteId: "f-A",
      dealerId: "d-A",
      sellingPrice: 40000,
      docFee: 85,
      salesTax: 2900,
      otdTotal: 42985,
    });
    // B (TX dealer): sp 38000, doc 600, TX tax 2375, otd 40975. Normalized to CA:
    // tax 0.0725*38000 = 2755, normalized_otd = 40975 - 2375 + 2755 = 41355.
    insertQuoteWithComponents({
      quoteId: "f-B",
      dealerId: "d-B",
      sellingPrice: 38000,
      docFee: 600,
      salesTax: 2375,
      otdTotal: 40975,
    });
    const result = rankQuotesForProfile(db, PROFILE);
    const byId = new Map(result.finance.map((q) => [q.quote_id, q]));
    const a = byId.get("f-A")!;
    const b = byId.get("f-B")!;
    // Baseline = lowest NORMALIZED OTD = B (41355). B carries no attribution.
    expect(b.normalized_otd).toBe(41355);
    expect(b.attribution).toBeNull();
    // A is $1,630 pricier than B, decomposed:
    expect(a.attribution).not.toBeNull();
    expect(a.attribution!.baseline_quote_id).toBe("f-B");
    expect(a.attribution!.otd_delta).toBe(1630);
    expect(a.attribution!.sale_price_delta).toBe(2000); // A's price is $2k higher
    expect(a.attribution!.doc_fee_delta).toBe(-515); // A's doc fee is $515 lower
    expect(a.attribution!.tax_delta).toBe(145); // home-state tax on the $2k price gap only
    expect(a.attribution!.incentive_delta).toBe(0);
    expect(a.attribution!.other_delta).toBe(0);
    const sum =
      a.attribution!.sale_price_delta +
      a.attribution!.doc_fee_delta +
      a.attribution!.tax_delta +
      a.attribution!.incentive_delta +
      a.attribution!.other_delta;
    // Reconciles to the cent (float dollars — not bit-exact, per the contract).
    expect(sum).toBeCloseTo(a.attribution!.otd_delta, 2);
  });

  it("reconciles to the cent on cents-level (non-whole-dollar) inputs", () => {
    insertProfileWithState(PROFILE, "finance", "CA");
    insertDealer("d-A", "Alpha");
    insertDealer("d-B", "Bravo");
    insertQuoteWithComponents({
      quoteId: "f-A",
      dealerId: "d-A",
      sellingPrice: 40000.33,
      docFee: 85.1,
      salesTax: 2900.07,
      otdTotal: 42985.5,
    });
    insertQuoteWithComponents({
      quoteId: "f-B",
      dealerId: "d-B",
      sellingPrice: 38000.77,
      docFee: 599.95,
      salesTax: 2375.49,
      rebates: [{ amount: 125.5 }],
      otdTotal: 41100.18,
    });
    const result = rankQuotesForProfile(db, PROFILE);
    const withAttr = result.finance.find((q) => q.attribution !== null)!;
    const a = withAttr.attribution!;
    const sum =
      a.sale_price_delta + a.doc_fee_delta + a.tax_delta + a.incentive_delta + a.other_delta;
    expect(sum).toBeCloseTo(a.otd_delta, 2); // reconciles to the cent
  });

  it("a null-selling-price peer is non-normalizable; a normalizable peer still attributes", () => {
    insertProfileWithState(PROFILE, "finance", "CA");
    insertDealer("d-A", "Alpha");
    insertDealer("d-B", "Bravo");
    // A: complete → normalizable + the baseline.
    insertQuoteWithComponents({
      quoteId: "f-A",
      dealerId: "d-A",
      sellingPrice: 40000,
      docFee: 85,
      salesTax: 2900,
      otdTotal: 42985,
    });
    // B: missing selling price → no taxable base → not normalizable.
    insertQuoteWithComponents({
      quoteId: "f-B",
      dealerId: "d-B",
      sellingPrice: null,
      docFee: 85,
      salesTax: 2900,
      otdTotal: 41000,
    });
    const result = rankQuotesForProfile(db, PROFILE);
    const byId = new Map(result.finance.map((q) => [q.quote_id, q]));
    const b = byId.get("f-B")!;
    expect(b.normalized_tax).toBeNull();
    expect(b.normalized_otd).toBeNull();
    expect(b.attribution).toBeNull(); // un-normalizable row carries no attribution
    // A is the only normalizable row → it is the baseline → its attribution is null.
    expect(byId.get("f-A")!.attribution).toBeNull();
    expect(byId.get("f-A")!.normalized_otd).toBe(42985);
  });

  it("attributes a delta driven purely by an unapplied incentive", () => {
    insertProfileWithState(PROFILE, "finance", "CA");
    insertDealer("d-A", "Alpha");
    insertDealer("d-B", "Bravo");
    insertQuoteWithComponents({
      quoteId: "f-A",
      dealerId: "d-A",
      sellingPrice: 40000,
      docFee: 85,
      salesTax: 2900,
      otdTotal: 42985,
    });
    // B identical but applies a $1,500 rebate → otd 41485.
    insertQuoteWithComponents({
      quoteId: "f-B",
      dealerId: "d-B",
      sellingPrice: 40000,
      docFee: 85,
      salesTax: 2900,
      rebates: [{ amount: 1500 }],
      otdTotal: 41485,
    });
    const result = rankQuotesForProfile(db, PROFILE);
    const a = result.finance.find((q) => q.quote_id === "f-A")!;
    expect(a.attribution!.baseline_quote_id).toBe("f-B");
    expect(a.attribution!.otd_delta).toBe(1500);
    expect(a.attribution!.incentive_delta).toBe(1500); // A is pricier by the missed rebate
    expect(a.attribution!.sale_price_delta).toBe(0);
    expect(a.attribution!.other_delta).toBe(0);
  });

  it("an unknown / missing home state leaves normalized fields null (graceful)", () => {
    insertProfile(PROFILE, "finance"); // no state column
    insertDealer("d-A", "Alpha");
    insertQuoteWithComponents({
      quoteId: "f-A",
      dealerId: "d-A",
      sellingPrice: 40000,
      docFee: 85,
      salesTax: 2900,
      otdTotal: 42985,
    });
    const result = rankQuotesForProfile(db, PROFILE);
    expect(result.homeState).toBeNull();
    expect(result.homeStateTaxRate).toBeNull();
    expect(result.finance[0]!.normalized_tax).toBeNull();
    expect(result.finance[0]!.normalized_otd).toBeNull();
    expect(result.finance[0]!.attribution).toBeNull();
  });
});
