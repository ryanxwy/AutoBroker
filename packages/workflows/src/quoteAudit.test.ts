/**
 * In-stack tests — the quote_audit flat workflow.
 *
 * These drive the REAL flat Mastra createWorkflow → REAL createRun/start chain
 * (in-process against a tmp mastra.db) → REAL step closures, with the profile
 * resolver + the read helpers + the pure 10-check audit + the idempotent writer
 * running REAL against an ISOLATED tmp autobroker.db (the committed migrations
 * applied). NO LLM, no network, no suspend — the whole run is a deterministic
 * read-then-record.
 *
 * Acceptance:
 *   - 1 active, a 4-quote set → audits all 4, the per-quote codes match (one
 *     DOC_FEE_CAP, one MATH_SANITY, one MISSING_REBATE, one clean), the header
 *     tallies (audited/flagged/flagCounts) are correct;
 *   - a same-pass RE-RUN → quote_audits Δ=0 EXACT (idempotency keystone — the
 *     UPSERT on (dealer_quote_id, audit_pass_version) UPDATEs in place);
 *   - 0 active → no_active_profile STOP (run failed, zero writes);
 *   - 2+ active → multiple_active_profiles STOP;
 *   - single-quote mode (quote_id) → exactly one row audited;
 *   - Probe-6: a DIFFERENT-model incentive raises NO MISSING_REBATE.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/restored);
 * mastra.db + autobroker.db both live there; NEVER ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/tools";

import { createMastraInstance } from "./mastra.js";
import {
  quoteAuditWorkflow,
  QUOTE_AUDIT_WORKFLOW_ID,
  __resetQuoteAuditDepsForTests,
} from "./quoteAudit.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = [
  "0000_military_red_skull.sql",
  "0001_redundant_ozymandias.sql",
].map((f) => join(here, "..", "..", "db", "drizzle", f));

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

const PROFILE_ID = "prof-qa-1";
const DEALER_A = "dealer-a";
const DEALER_B = "dealer-b";

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-qa-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
});

afterEach(() => {
  __resetQuoteAuditDepsForTests();
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

/** Seed an active CA Hyundai Tucson profile (state CA → the doc-fee cap is $85;
 *  finance preference → no MODE_MISMATCH on the finance quotes). */
function seedProfile(
  over: { id?: string; make?: string; model?: string; brand?: string; state?: string } = {},
): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, trim, " +
        "budget_max, search_radius_miles, account_id, brand, status, state, postal_code, " +
        "financing_preference, current_brand_owner, military_first_responder) " +
        "VALUES (?, 2026, ?, ?, 'Limited', 50000, 25, 'acct-test-1', ?, 'active', ?, '92614', " +
        "'finance', 0, 0)",
    )
    .run(
      over.id ?? PROFILE_ID,
      over.make ?? "Hyundai",
      over.model ?? "Tucson",
      over.brand ?? over.make ?? "Hyundai",
      over.state ?? "CA",
    );
}

function seedDealer(id: string, name: string): void {
  db.$client
    .prepare("INSERT INTO dealers (dealer_id, name, distance_miles, country) VALUES (?, ?, 5.0, 'US')")
    .run(id, name);
}

/** Seed a message with a 'succeeded' extraction (the recent-batch join + the
 *  CHECK constraint require a non-null intent when status is 'succeeded'). */
function seedMessage(messageId: string): void {
  db.$client
    .prepare(
      "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, " +
        "quote_extraction_status, quote_extraction_intent) " +
        "VALUES (?, NULL, NULL, 'inbound', 'succeeded', 'quote')",
    )
    .run(messageId);
}

interface QuoteSeed {
  quoteId: string;
  dealerId: string;
  messageId: string;
  financingMode?: string;
  sellingPrice?: number | null;
  docFee?: number | null;
  salesTax?: number | null;
  otdTotal?: number | null;
  financeApr?: number | null;
  rebatesJson?: string | null;
  receivedAt?: string | null;
}

/** Seed one dealer_quotes row + its succeeded message. */
function seedQuote(q: QuoteSeed): void {
  seedMessage(q.messageId);
  db.$client
    .prepare(
      "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, " +
        "search_profile_id, financing_mode, selling_price, doc_fee, sales_tax, otd_total, " +
        "finance_apr, rebates_json, quote_received_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      q.quoteId,
      q.dealerId,
      q.messageId,
      `gmsg-${q.quoteId}`,
      PROFILE_ID,
      q.financingMode ?? "finance",
      q.sellingPrice ?? null,
      q.docFee ?? null,
      q.salesTax ?? null,
      q.otdTotal ?? null,
      q.financeApr ?? null,
      q.rebatesJson ?? null,
      q.receivedAt ?? null,
    );
}

function seedIncentive(
  over: { make?: string; model?: string; zip?: string; type?: string; eligibility?: string; amount?: number } = {},
): void {
  db.$client
    .prepare(
      "INSERT INTO manufacturer_incentives (make, model, zip, type, amount, eligibility, " +
        "scraped_at, scrape_source_url) VALUES (?, ?, ?, ?, ?, ?, '2026-06-01', 'https://example.com')",
    )
    .run(
      over.make ?? "Hyundai",
      over.model ?? "Tucson",
      over.zip ?? "92614",
      over.type ?? "customer_cash",
      over.amount ?? 1500,
      over.eligibility ?? "all",
    );
}

/**
 * The canonical 4-quote set:
 *   q-doc   → DOC_FEE_CAP (CA, doc_fee 599 > $85 cap; selling/tax/otd reconcile)
 *   q-math  → MATH_SANITY (selling+doc+tax ≠ otd by far)
 *   q-rebate→ MISSING_REBATE (seeded customer_cash incentive not in rebates_json)
 *   q-clean → ZERO findings (within cap, math reconciles, rebate applied)
 */
function seedFourQuoteSet(): void {
  seedDealer(DEALER_A, "Alpha Hyundai");
  seedDealer(DEALER_B, "Bravo Hyundai");
  seedIncentive(); // Hyundai Tucson 92614 customer_cash $1500 eligibility all.

  // q-doc: doc_fee over the CA $85 cap; math reconciles (40000 + 599 + 3000 = 43599).
  // rebate applied (so no MISSING_REBATE), breakdown complete (no MISSING_BREAKDOWN).
  seedQuote({
    quoteId: "q-doc",
    dealerId: DEALER_A,
    messageId: "m-doc",
    sellingPrice: 40000,
    docFee: 599,
    salesTax: 3000,
    otdTotal: 43599,
    rebatesJson: JSON.stringify([{ type: "customer_cash", name: "Customer Cash" }]),
  });

  // q-math: 40000 + 85 + 3000 = 43085 but stated 50000 → MATH_SANITY. doc within
  // cap, breakdown complete, rebate applied → MATH_SANITY is the only finding.
  seedQuote({
    quoteId: "q-math",
    dealerId: DEALER_B,
    messageId: "m-math",
    sellingPrice: 40000,
    docFee: 85,
    salesTax: 3000,
    otdTotal: 50000,
    rebatesJson: JSON.stringify([{ type: "customer_cash", name: "Customer Cash" }]),
  });

  // q-rebate: no rebate applied → MISSING_REBATE. doc within cap, math reconciles.
  seedQuote({
    quoteId: "q-rebate",
    dealerId: DEALER_A,
    messageId: "m-rebate",
    sellingPrice: 38000,
    docFee: 85,
    salesTax: 2850,
    otdTotal: 40935,
    rebatesJson: null,
  });

  // q-clean: everything reconciles, doc within cap, rebate applied → ZERO findings.
  seedQuote({
    quoteId: "q-clean",
    dealerId: DEALER_B,
    messageId: "m-clean",
    sellingPrice: 41000,
    docFee: 80,
    salesTax: 3075,
    otdTotal: 44155,
    rebatesJson: JSON.stringify([{ type: "customer_cash", name: "Customer Cash" }]),
  });
}

// ---------------------------------------------------------------------------
// run driver
// ---------------------------------------------------------------------------

function auditWorkflow() {
  const mastra = createMastraInstance({
    workflows: { [QUOTE_AUDIT_WORKFLOW_ID]: quoteAuditWorkflow as never },
  });
  return mastra.getWorkflow(QUOTE_AUDIT_WORKFLOW_ID);
}

async function startRun(
  runId: string,
  searchProfileId: string | null = null,
  quoteId: string | null = null,
) {
  const wf = auditWorkflow();
  const run = await wf.createRun({ runId });
  const result = await run.start({
    inputData: { search_profile_id: searchProfileId, quote_id: quoteId },
  });
  return { run, result };
}

function errorMessageOf(result: unknown): string {
  const err = (result as { error?: unknown }).error;
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err !== null && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "";
}

function countAudits(): number {
  const row = db.$client.prepare("SELECT COUNT(*) AS n FROM quote_audits").get() as { n: number };
  return row.n;
}

interface AuditOutput {
  outcome: string;
  resolution: string;
  audited: number;
  flagged: number;
  flagCounts: { info: number; warn: number; block: number };
  bestOtd: { dealerName: string; otdTotal: number } | null;
  perQuote: Array<{ quote_id: string; dealer_name: string; otd_total: number | null; flags: Array<{ code: string; severity: string }> }>;
  summary: string;
}

/** The set of finding codes for a quote in the output, by quote id. */
function codesFor(out: AuditOutput, quoteId: string): string[] {
  const row = out.perQuote.find((p) => p.quote_id === quoteId);
  return (row?.flags ?? []).map((f) => f.code);
}

// ---------------------------------------------------------------------------
// cases
// ---------------------------------------------------------------------------

describe("quote_audit — read-only three-branch + idempotent audit", () => {
  it("audits the 4-quote set: per-quote codes + header tallies", async () => {
    seedProfile();
    seedFourQuoteSet();

    const { result } = await startRun("qa-happy-1", null);
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    const out = result.result as AuditOutput;

    expect(out.outcome).toBe("audited");
    expect(out.resolution).toBe("inferred_newest");
    expect(out.audited).toBe(4);

    // Per-quote codes.
    expect(codesFor(out, "q-doc")).toContain("DOC_FEE_CAP");
    expect(codesFor(out, "q-math")).toContain("MATH_SANITY");
    expect(codesFor(out, "q-rebate")).toContain("MISSING_REBATE");
    expect(codesFor(out, "q-clean")).toHaveLength(0);

    // flagged = the three non-clean quotes.
    expect(out.flagged).toBe(3);
    // All three fired codes are warn-classified.
    expect(out.flagCounts.warn).toBeGreaterThanOrEqual(3);
    expect(out.flagCounts.block).toBe(0);

    // bestOtd = the lowest otd_total across audited quotes (q-rebate, 40935).
    expect(out.bestOtd).not.toBeNull();
    expect(out.bestOtd?.otdTotal).toBe(40935);

    // Summary carries the audited + flagged counts; NO budget number.
    expect(out.summary).toContain("Audited 4 quotes. 3 flagged.");
    expect(out.summary).not.toContain("50000");

    // Four audit rows were UPSERTed.
    expect(countAudits()).toBe(4);
  });

  it("is idempotent: a same-pass re-run leaves quote_audits Δ=0 EXACT", async () => {
    seedProfile();
    seedFourQuoteSet();

    // The recent batch audits only UNAUDITED-at-this-pass quotes, so the first
    // run audits all 4. The second run finds them already audited → the recent
    // anti-join returns ZERO candidates → zero upserts; the existing rows stay.
    const first = await startRun("qa-idem-1", null);
    expect(first.result.status).toBe("success");
    const afterFirst = countAudits();
    expect(afterFirst).toBe(4);

    const second = await startRun("qa-idem-2", null);
    expect(second.result.status).toBe("success");
    const afterSecond = countAudits();

    // Δ=0 EXACT — no duplicate rows, no new rows (idempotency keystone).
    expect(afterSecond - afterFirst).toBe(0);
    expect(afterSecond).toBe(4);
  });

  it("re-auditing the SAME quote (single-quote mode, twice) UPSERTs in place — Δ=0", async () => {
    seedProfile();
    seedFourQuoteSet();

    // Single-quote mode bypasses the recent anti-join, so it RE-AUDITS the named
    // quote every time. The UPSERT on (dealer_quote_id, audit_pass_version) means
    // the second pass UPDATEs the existing row — never a duplicate.
    const first = await startRun("qa-single-1", null, "q-doc");
    expect(first.result.status).toBe("success");
    if (first.result.status !== "success") return;
    const out1 = first.result.result as AuditOutput;
    expect(out1.audited).toBe(1);
    expect(codesFor(out1, "q-doc")).toContain("DOC_FEE_CAP");
    const afterFirst = countAudits();
    expect(afterFirst).toBe(1);

    const second = await startRun("qa-single-2", null, "q-doc");
    expect(second.result.status).toBe("success");
    const afterSecond = countAudits();
    // The same (quote, pass) UPSERTs in place → Δ=0.
    expect(afterSecond - afterFirst).toBe(0);
    expect(afterSecond).toBe(1);
  });

  it("STOPs with no_active_profile on a pin-less input with 0 active profiles", async () => {
    const { result } = await startRun("qa-none-1", null);
    expect(result.status).toBe("failed");
    expect(errorMessageOf(result)).toContain("No active search profile");
    expect(countAudits()).toBe(0);
  });

  it("STOPs with multiple_active_profiles on 2+ active profiles (candidates listed)", async () => {
    seedProfile({ id: "prof-x", make: "Hyundai", model: "Tucson", brand: "Hyundai" });
    seedProfile({ id: "prof-y", make: "Toyota", model: "RAV4", brand: "Toyota" });
    const { result } = await startRun("qa-ambig-1", null);
    expect(result.status).toBe("failed");
    const msg = errorMessageOf(result);
    expect(msg).toContain("Multiple active search profiles");
    expect(msg).toContain("Tucson");
    expect(msg).toContain("RAV4");
    expect(countAudits()).toBe(0);
  });

  it("Probe-6: a DIFFERENT-model incentive raises NO MISSING_REBATE", async () => {
    seedProfile(); // Hyundai Tucson 92614.
    seedDealer(DEALER_A, "Alpha Hyundai");
    // An incentive for a DIFFERENT model — the (make,model,zip)-exact slice query
    // excludes it, so the missing-rebate check sees an empty incentive set.
    seedIncentive({ model: "Elantra" });
    seedQuote({
      quoteId: "q-probe",
      dealerId: DEALER_A,
      messageId: "m-probe",
      sellingPrice: 38000,
      docFee: 80,
      salesTax: 2850,
      otdTotal: 40930,
      rebatesJson: null,
    });

    const { result } = await startRun("qa-probe6-1", null);
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    const out = result.result as AuditOutput;
    expect(out.audited).toBe(1);
    // No MISSING_REBATE — the only incentive is for a different model.
    expect(codesFor(out, "q-probe")).not.toContain("MISSING_REBATE");
    expect(codesFor(out, "q-probe")).toHaveLength(0);
  });
});
