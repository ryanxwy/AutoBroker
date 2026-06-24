/**
 * In-stack tests — the quote_compare flat workflow.
 *
 * These drive the REAL flat Mastra createWorkflow → REAL createRun/start chain
 * (in-process against a tmp mastra.db) → REAL step closures, with the profile
 * resolver + the compare ranker running REAL against an ISOLATED tmp
 * autobroker.db (the committed migrations applied). NO LLM, no network, no
 * suspend — the whole run is a deterministic read.
 *
 * Acceptance (read-only / infer-ok three-branch + gating):
 *   - 1 active → runs, resolution "inferred_newest", buckets per preference;
 *   - a valid pin → runs, resolution "pinned";
 *   - 0 active → no_active_profile STOP (run failed);
 *   - 2+ active → multiple_active_profiles STOP (candidate vehicles listed);
 *   - undecided → both buckets; finance/lease → one bucket; cash → both empty;
 *   - NULL otd_total sorts last.
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
  quoteCompareWorkflow,
  QUOTE_COMPARE_WORKFLOW_ID,
  __resetQuoteCompareDepsForTests,
} from "./quoteCompare.js";

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

const PROFILE_ID = "prof-qcmp-1";

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-qcmp-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
});

afterEach(() => {
  __resetQuoteCompareDepsForTests();
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

function seedProfile(
  over: { id?: string; make?: string; model?: string; brand?: string; preference?: string | null } = {},
): void {
  const preference = over.preference === undefined ? "undecided" : over.preference;
  if (preference === null) {
    db.$client
      .prepare(
        "INSERT INTO search_profiles (search_profile_id, year, make, model, trim, account_id, brand, status) " +
          "VALUES (?, 2026, ?, ?, 'Limited', 'acct-test-1', ?, 'active')",
      )
      .run(over.id ?? PROFILE_ID, over.make ?? "Hyundai", over.model ?? "Tucson", over.brand ?? over.make ?? "Hyundai");
  } else {
    db.$client
      .prepare(
        "INSERT INTO search_profiles (search_profile_id, year, make, model, trim, account_id, brand, financing_preference, status) " +
          "VALUES (?, 2026, ?, ?, 'Limited', 'acct-test-1', ?, ?, 'active')",
      )
      .run(
        over.id ?? PROFILE_ID,
        over.make ?? "Hyundai",
        over.model ?? "Tucson",
        over.brand ?? over.make ?? "Hyundai",
        preference,
      );
  }
}

function seedDealer(id: string, name: string): void {
  db.$client
    .prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')")
    .run(id, name);
}

function seedQuote(over: {
  quoteId: string;
  dealerId: string;
  mode: "finance" | "lease" | "cash";
  otdTotal: number | null;
  apr?: number | null;
  mf?: number | null;
}): void {
  const messageId = `m-${over.quoteId}`;
  db.$client
    .prepare(
      "INSERT INTO messages (message_id, direction, quote_extraction_status, quote_extraction_intent) " +
        "VALUES (?, 'inbound', 'succeeded', 'quote')",
    )
    .run(messageId);
  db.$client
    .prepare(
      "INSERT INTO dealer_quotes " +
        "(quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, financing_mode, " +
        " otd_total, finance_apr, lease_money_factor) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      over.quoteId,
      over.dealerId,
      messageId,
      messageId,
      PROFILE_ID,
      over.mode,
      over.otdTotal,
      over.mode === "finance" ? (over.apr ?? null) : null,
      over.mode === "lease" ? (over.mf ?? null) : null,
    );
}

// ---------------------------------------------------------------------------
// run driver
// ---------------------------------------------------------------------------

function compareWorkflow() {
  const mastra = createMastraInstance({
    workflows: { [QUOTE_COMPARE_WORKFLOW_ID]: quoteCompareWorkflow as never },
  });
  return mastra.getWorkflow(QUOTE_COMPARE_WORKFLOW_ID);
}

async function startRun(runId: string, searchProfileId: string | null = null) {
  const wf = compareWorkflow();
  const run = await wf.createRun({ runId });
  const result = await run.start({ inputData: { search_profile_id: searchProfileId } });
  return { run, result };
}

interface CompareOut {
  outcome: string;
  resolution: string;
  financingPreference: string | null;
  finance: Array<{ rank: number; dealer_id: string; otd_total: number | null; apr_or_mf: string }>;
  lease: Array<{ rank: number; dealer_id: string; apr_or_mf: string }>;
  cash: Array<{ rank: number; dealer_id: string; otd_total: number | null; apr_or_mf: string }>;
  totalRanked: number;
  summary: string;
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

// ---------------------------------------------------------------------------
// cases
// ---------------------------------------------------------------------------

describe("quote_compare — read-only three-branch + gating", () => {
  it("runs 'inferred_newest' on 1 active profile, undecided → both buckets", async () => {
    seedProfile({ preference: "undecided" });
    seedDealer("d-A", "Alpha Hyundai");
    seedDealer("d-B", "Bravo Hyundai");
    seedQuote({ quoteId: "f-A", dealerId: "d-A", mode: "finance", otdTotal: 44540, apr: 6.5 });
    seedQuote({ quoteId: "f-B", dealerId: "d-B", mode: "finance", otdTotal: 42987, apr: 7.9 });
    seedQuote({ quoteId: "l-A", dealerId: "d-A", mode: "lease", otdTotal: 38000, mf: 0.0012 });

    const { result } = await startRun("qcmp-undecided-1", null);
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    const out = result.result as CompareOut;
    expect(out.outcome).toBe("compared");
    expect(out.resolution).toBe("inferred_newest");
    expect(out.financingPreference).toBe("undecided");
    expect(out.finance).toHaveLength(2);
    expect(out.lease).toHaveLength(1);
    expect(out.finance.map((q) => q.dealer_id)).toEqual(["d-B", "d-A"]);
    expect(out.finance[0]!.apr_or_mf).toBe("7.9%");
    expect(out.lease[0]!.apr_or_mf).toBe("MF 0.00120");
    expect(out.totalRanked).toBe(3);
    expect(out.summary).toBe("Compared 3 quotes (finance: 2, lease: 1, cash: 0).");
  });

  it("runs 'pinned' when a valid pin is supplied", async () => {
    seedProfile({ preference: "finance" });
    seedDealer("d-A", "Alpha Hyundai");
    seedQuote({ quoteId: "f-A", dealerId: "d-A", mode: "finance", otdTotal: 44000, apr: 5.0 });
    const { result } = await startRun("qcmp-pinned-1", PROFILE_ID);
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    const out = result.result as CompareOut;
    expect(out.resolution).toBe("pinned");
    expect(out.finance).toHaveLength(1);
    expect(out.lease).toEqual([]);
  });

  it("finance pref → finance bucket only", async () => {
    seedProfile({ preference: "finance" });
    seedDealer("d-A", "Alpha Hyundai");
    seedQuote({ quoteId: "f-A", dealerId: "d-A", mode: "finance", otdTotal: 44000, apr: 5.0 });
    seedQuote({ quoteId: "l-X", dealerId: "d-A", mode: "lease", otdTotal: 30000, mf: 0.001 });
    const { result } = await startRun("qcmp-finance-1", null);
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    const out = result.result as CompareOut;
    expect(out.finance).toHaveLength(1);
    expect(out.lease).toEqual([]);
    expect(out.summary).toBe("Compared 1 quotes (finance: 1, lease: 0, cash: 0).");
  });

  it("lease pref → lease bucket only (stray finance hidden)", async () => {
    seedProfile({ preference: "lease" });
    seedDealer("d-A", "Alpha Hyundai");
    seedQuote({ quoteId: "l-A", dealerId: "d-A", mode: "lease", otdTotal: 38000, mf: 0.0012 });
    seedQuote({ quoteId: "f-X", dealerId: "d-A", mode: "finance", otdTotal: 30000, apr: 4.0 });
    const { result } = await startRun("qcmp-lease-1", null);
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    const out = result.result as CompareOut;
    expect(out.finance).toEqual([]);
    expect(out.lease).toHaveLength(1);
  });

  it("cash pref → cash bucket ranked by OTD (finance/lease empty)", async () => {
    seedProfile({ preference: "cash" });
    seedDealer("d-A", "Alpha Hyundai");
    seedDealer("d-B", "Beta Hyundai");
    seedQuote({ quoteId: "c-A", dealerId: "d-A", mode: "cash", otdTotal: 41000 });
    seedQuote({ quoteId: "c-B", dealerId: "d-B", mode: "cash", otdTotal: 39500 });
    const { result } = await startRun("qcmp-cash-1", null);
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    const out = result.result as CompareOut;
    expect(out.finance).toEqual([]);
    expect(out.lease).toEqual([]);
    // A cash buyer's OTD quotes are now compared (was an empty result, a real bug).
    expect(out.cash).toHaveLength(2);
    expect(out.cash[0]!.otd_total).toBe(39500); // lowest OTD ranks first
    expect(out.totalRanked).toBe(2);
    expect(out.summary).toBe("Compared 2 quotes (finance: 0, lease: 0, cash: 2).");
  });

  it("NULL otd_total sorts last within a bucket", async () => {
    seedProfile({ preference: "finance" });
    seedDealer("d-A", "Alpha Hyundai");
    seedDealer("d-B", "Bravo Hyundai");
    seedQuote({ quoteId: "f-A", dealerId: "d-A", mode: "finance", otdTotal: null });
    seedQuote({ quoteId: "f-B", dealerId: "d-B", mode: "finance", otdTotal: 42000 });
    const { result } = await startRun("qcmp-nullotd-1", null);
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    const out = result.result as CompareOut;
    expect(out.finance.map((q) => q.dealer_id)).toEqual(["d-B", "d-A"]);
    expect(out.finance[1]!.otd_total).toBeNull();
  });

  it("carries cross-state normalized tax + OTD attribution through to the output", async () => {
    // Profile registers in CA; two finance quotes for the same vehicle from
    // dealers in different states. The contract must expose the home-state rate,
    // identical normalized tax across both, and the OTD-delta attribution.
    db.$client
      .prepare(
        "INSERT INTO search_profiles (search_profile_id, year, make, model, trim, account_id, brand, financing_preference, state, status) " +
          "VALUES (?, 2026, 'Hyundai', 'Tucson', 'Limited', 'acct-test-1', 'Hyundai', 'finance', 'CA', 'active')",
      )
      .run(PROFILE_ID);
    seedDealer("d-A", "Alpha CA");
    seedDealer("d-B", "Bravo OR");
    const seedFull = (
      quoteId: string,
      dealerId: string,
      sellingPrice: number,
      docFee: number,
      salesTax: number,
      otd: number,
    ): void => {
      const m = `m-${quoteId}`;
      db.$client
        .prepare(
          "INSERT INTO messages (message_id, direction, quote_extraction_status, quote_extraction_intent) " +
            "VALUES (?, 'inbound', 'succeeded', 'quote')",
        )
        .run(m);
      db.$client
        .prepare(
          "INSERT INTO dealer_quotes " +
            "(quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, financing_mode, " +
            " selling_price, doc_fee, sales_tax, otd_total, finance_term_months) " +
            "VALUES (?, ?, ?, ?, ?, 'finance', ?, ?, ?, ?, 60)",
        )
        .run(quoteId, dealerId, m, m, PROFILE_ID, sellingPrice, docFee, salesTax, otd);
    };
    seedFull("f-A", "d-A", 40000, 85, 2900, 42985); // CA dealer, CA tax
    seedFull("f-B", "d-B", 40000, 85, 0, 40085); // OR dealer, no tax

    const { result } = await startRun("qcmp-crossstate-1", null);
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    const out = result.result as unknown as {
      homeState: string | null;
      homeStateTaxRate: number | null;
      finance: Array<{
        quote_id: string;
        normalized_tax: number | null;
        normalized_otd: number | null;
        attribution: { baseline_quote_id: string; sale_price_delta: number } | null;
      }>;
    };
    expect(out.homeState).toBe("CA");
    expect(out.homeStateTaxRate).toBe(0.0725);
    const byId = new Map(out.finance.map((q) => [q.quote_id, q]));
    expect(byId.get("f-A")!.normalized_tax).toBe(2900);
    expect(byId.get("f-B")!.normalized_tax).toBe(2900); // IDENTICAL across states
    expect(byId.get("f-A")!.normalized_otd).toBe(42985);
    expect(byId.get("f-B")!.normalized_otd).toBe(42985);
    // Same vehicle + price → the only delta is zero (no cross-state tax illusion).
    const baseline = out.finance.find((q) => q.attribution === null)!;
    expect(["f-A", "f-B"]).toContain(baseline.quote_id);
  });

  it("STOPs with no_active_profile on a pin-less input with 0 active profiles", async () => {
    const { result } = await startRun("qcmp-none-1", null);
    expect(result.status).toBe("failed");
    expect(errorMessageOf(result)).toContain("No active search profile");
  });

  it("STOPs with multiple_active_profiles on 2+ active profiles (candidates listed)", async () => {
    seedProfile({ id: "prof-x", make: "Hyundai", model: "Tucson", brand: "Hyundai" });
    seedProfile({ id: "prof-y", make: "Toyota", model: "RAV4", brand: "Toyota" });
    const { result } = await startRun("qcmp-ambig-1", null);
    expect(result.status).toBe("failed");
    const msg = errorMessageOf(result);
    expect(msg).toContain("Multiple active search profiles");
    expect(msg).toContain("Tucson");
    expect(msg).toContain("RAV4");
  });
});
