/**
 * dealerReplyExtract.test.ts — the PURE assertion + judge-parse pieces of the
 * plan-2 reply-extract soak, over a REAL isolated tmp DB.
 *
 * Mirrors verdict.test.ts: a throwaway tmp DB at an EXPLICIT path (never
 * ~/.autobroker*), the three committed migrations applied, dealer_quotes /
 * messages / test_run_records rows hand-inserted, then the per-skill assertion
 * functions scored against the read-back rows. NO live LLM, no workflow run, no
 * claude spawn — the impure driver spine (spawn + live DeepSeek workflow) is the
 * `pnpm soak` lane, exercised live, NOT here.
 *
 * The judge proof is the load-bearing acceptance: a deliberately number-corrupted
 * persisted fixture (selling_price ≠ GROUND_TRUTH) yields a judge FAIL, while a
 * faithful fixture yields a PASS — through the SAME runReplyJudge wiring (the
 * judge spawn injected as a deterministic mini-judge that actually compares the
 * oracle to the rows). This proves the judge path is not a rubber stamp.
 *
 * ISOLATION: a throwaway tmp DB at an EXPLICIT path; never ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "@autobroker/db";

import type { LedgerRow } from "../../dbReads.js";
import type { ExecImpl } from "../claudeAgent.js";
import { combineSoakVerdict } from "../verdict.js";
import {
  assertAllOrNothingUpsert,
  assertCostAndTimeAttributable,
  assertFloatDollars,
  assertIdempotentReextract,
  assertNoQuoteZeroRows,
  assertPinnedProfile,
  assertRule1Rule2Belt,
  assertUniqueTwoMode,
  buildReplyJudgeTask,
  parseDealerReplyEmit,
  parseReplyJudgeVerdict,
  rehydrateQuoteRow,
  readQuoteRows,
  runReplyJudge,
  toCaseSeedReply,
  type GroundTruth,
} from "./dealerReplyExtract.js";

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "packages", "db", "drizzle");
const MIGRATIONS = [
  "0000_military_red_skull.sql",
  "0001_redundant_ozymandias.sql",
  "0002_pale_thunderball.sql",
].map((f) => join(DRIZZLE_DIR, f));

const PROFILE_ID = "soak-dre-profile";
const ACCOUNT_ID = "soak-dre-account";
const DEALER_ID = "soak-dre-dealer";

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-soak-dre-"));
  db = openDb(join(tmpDir, "autobroker.db"));
  for (const sql of MIGRATIONS) db.$client.exec(readFileSync(sql, "utf8"));
  // The minimal identity world every quote row keys to.
  db.$client.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run(ACCOUNT_ID, "b@example.com");
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, account_id, brand, status) " +
        "VALUES (?, 2026, 'Hyundai', 'Tucson Hybrid', ?, 'Hyundai', 'active')",
    )
    .run(PROFILE_ID, ACCOUNT_ID);
  db.$client.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, 'Soak Hyundai', 'US')").run(DEALER_ID);
});

afterAll(() => {
  db.$client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// Each test owns a fresh message id so the rows never collide across cases.
beforeEach(() => {
  db.$client.prepare("DELETE FROM dealer_quotes").run();
  db.$client.prepare("DELETE FROM messages").run();
  db.$client.prepare("DELETE FROM threads").run();
});

// ---------------------------------------------------------------------------
// hand-seed helpers (mirror the persist writer's column shape)
// ---------------------------------------------------------------------------

/** A full dealer_quotes row with explicit nulls everywhere but the overrides. */
function quoteRow(over: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    quote_id: "q-default",
    dealer_id: DEALER_ID,
    message_id: "m-default",
    source_gmail_message_id: "gmsg-default",
    search_profile_id: PROFILE_ID,
    vin: null,
    inventory_status: null,
    msrp: null,
    selling_price: null,
    dealer_discount: null,
    rebates_json: null,
    doc_fee: null,
    dealer_fee: null,
    sales_tax: null,
    dmv_fees: null,
    title_fee: null,
    registration_fee: null,
    license_fee: null,
    other_fees_json: null,
    add_ons_json: null,
    taxable_rebates_json: null,
    otd_total: null,
    quote_format: null,
    intent: null,
    confidence: null,
    raw_source_blob: null,
    quote_received_at: null,
    quote_expires_at: null,
    extracted_at: null,
    extractor_provider: "deepseek",
    extraction_method: "text",
    financing_mode: "cash",
    finance_apr: null,
    finance_term_months: null,
    finance_down_payment: null,
    finance_monthly_payment: null,
    finance_amount_financed: null,
    lease_term_months: null,
    lease_money_factor: null,
    lease_residual_pct: null,
    lease_residual_value: null,
    lease_due_at_signing: null,
    lease_monthly_payment: null,
    lease_miles_per_year: null,
    lease_acquisition_fee: null,
    lease_disposition_fee: null,
    lease_cap_cost_gross: null,
    lease_cap_cost_adjusted: null,
    lease_rent_charge: null,
    source_listing_id: null,
  };
  return { ...base, ...over };
}

function insertQuote(over: Record<string, unknown>): void {
  const row = quoteRow(over);
  const cols = Object.keys(row);
  db.$client
    .prepare(`INSERT INTO dealer_quotes (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .run(...cols.map((c) => row[c]));
}

/** Insert a thread + an inbound message in a given extraction state. */
function insertMessage(opts: {
  messageId: string;
  gmailMessageId: string;
  threadId?: string;
  status: "pending" | "succeeded" | "failed";
  intent?: string | null;
  processedAt?: string | null;
}): void {
  const threadId = opts.threadId ?? `t-${opts.messageId}`;
  db.$client
    .prepare("INSERT INTO threads (thread_id, dealer_id, state, search_profile_id) VALUES (?, ?, 'replied', ?)")
    .run(threadId, DEALER_ID, PROFILE_ID);
  db.$client
    .prepare(
      "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, body_text, " +
        "search_profile_id, quote_extraction_status, quote_extraction_intent, processed_at) " +
        "VALUES (?, ?, ?, 'inbound', 'body', ?, ?, ?, ?)",
    )
    .run(
      opts.messageId,
      threadId,
      opts.gmailMessageId,
      PROFILE_ID,
      opts.status,
      opts.intent ?? null,
      opts.processedAt ?? null,
    );
}

function ledger(over: Partial<LedgerRow>): LedgerRow {
  return {
    runId: "run-1",
    skill: "dealer_reply_extract",
    createdAt: "2026-06-15T00:00:00.000Z",
    layer: "L2",
    provider: "deepseek",
    modelAlias: "deepseek.chat",
    costUsd: null,
    latencyMs: 1200,
    inputTokens: null,
    outputTokens: null,
    pricingSource: "unavailable",
    priceInputPerMtok: null,
    priceOutputPerMtok: null,
    promptVersion: "p3-e2-v1",
    schemaVersion: "p3-e2-v1",
    failReason: null,
    ...over,
  };
}

// ===========================================================================
// the emit parse + GROUND_TRUTH strip
// ===========================================================================

describe("parseDealerReplyEmit + toCaseSeedReply (strip GROUND_TRUTH)", () => {
  const RAW = JSON.stringify({
    dealer_name: "Alpha Hyundai",
    dealer_website: "alpha-hyundai.example.com",
    from: "Sandra <sandra@alpha-hyundai.example.com>",
    subject: "Re: your Tucson quote",
    body: "Selling price $33,990, doc fee $85.",
    attachment: null,
    GROUND_TRUTH: { message_intent: "real_quote", quotes: [{ financing_mode: "cash", selling_price: 33990 }] },
  });

  it("parses a fenced + prose-wrapped emit", () => {
    const wrapped = "Here you go:\n```json\n" + RAW + "\n```\nthanks";
    const emit = parseDealerReplyEmit(wrapped);
    expect(emit.dealer_name).toBe("Alpha Hyundai");
    expect(emit.GROUND_TRUTH.quotes).toHaveLength(1);
  });

  it("toCaseSeedReply DROPS the GROUND_TRUTH oracle (it never reaches the SUT)", () => {
    const seed = toCaseSeedReply(parseDealerReplyEmit(RAW));
    expect(seed).toEqual({
      dealerName: "Alpha Hyundai",
      dealerWebsite: "alpha-hyundai.example.com",
      from: "Sandra <sandra@alpha-hyundai.example.com>",
      subject: "Re: your Tucson quote",
      body: "Selling price $33,990, doc fee $85.",
      attachment: null,
    });
    // The seed shape has no GROUND_TRUTH key.
    expect(Object.keys(seed)).not.toContain("GROUND_TRUTH");
  });

  it("fails LOUD on a missing GROUND_TRUTH block", () => {
    const bad = JSON.stringify({ dealer_name: "X", dealer_website: "x", from: "x", subject: "x", body: "x" });
    expect(() => parseDealerReplyEmit(bad)).toThrow(/missing the GROUND_TRUTH/);
  });

  it("maps a PDF attachment through verbatim", () => {
    const withAtt = JSON.stringify({
      dealer_name: "Bravo",
      dealer_website: "bravo.example.com",
      from: "q@bravo.example.com",
      subject: "quote",
      body: "see attached",
      attachment: { filename: "q.pdf", mime_type: "application/pdf", data_base64: "QUJD" },
      GROUND_TRUTH: { message_intent: "real_quote", quotes: [] },
    });
    const seed = toCaseSeedReply(parseDealerReplyEmit(withAtt));
    expect(seed.attachment).toEqual({ filename: "q.pdf", mimeType: "application/pdf", dataBase64: "QUJD" });
  });
});

// ===========================================================================
// all_or_nothing_upsert
// ===========================================================================

describe("assertAllOrNothingUpsert", () => {
  it("succeeded message: row count == emitted count + intent set → ok", () => {
    insertMessage({ messageId: "m1", gmailMessageId: "g1", status: "succeeded", intent: "real_quote", processedAt: "2026-06-15T00:00:00Z" });
    insertQuote({ quote_id: "q1", message_id: "m1", source_gmail_message_id: "g1", selling_price: 33990 });
    const r = assertAllOrNothingUpsert({ db, sourceGmailMessageId: "g1", terminalStatus: "succeeded", emittedQuoteCount: 1 });
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("red");
  });

  it("succeeded but a partial row set (rows != emitted) → fail", () => {
    insertMessage({ messageId: "m2", gmailMessageId: "g2", status: "succeeded", intent: "real_quote", processedAt: "z" });
    insertQuote({ quote_id: "q2", message_id: "m2", source_gmail_message_id: "g2", selling_price: 1 });
    const r = assertAllOrNothingUpsert({ db, sourceGmailMessageId: "g2", terminalStatus: "succeeded", emittedQuoteCount: 2 });
    expect(r.ok).toBe(false);
  });

  it("failed message: ZERO rows + failed/intent-NULL/processed_at-NULL → ok", () => {
    insertMessage({ messageId: "m3", gmailMessageId: "g3", status: "failed", intent: null, processedAt: null });
    const r = assertAllOrNothingUpsert({ db, sourceGmailMessageId: "g3", terminalStatus: "failed", emittedQuoteCount: 0 });
    expect(r.ok).toBe(true);
  });

  it("failed message with a surviving row → fail (a partial row set)", () => {
    insertMessage({ messageId: "m4", gmailMessageId: "g4", status: "failed", intent: null, processedAt: null });
    insertQuote({ quote_id: "q4", message_id: "m4", source_gmail_message_id: "g4" });
    const r = assertAllOrNothingUpsert({ db, sourceGmailMessageId: "g4", terminalStatus: "failed", emittedQuoteCount: 0 });
    expect(r.ok).toBe(false);
  });
});

// ===========================================================================
// float_dollars
// ===========================================================================

describe("assertFloatDollars", () => {
  it("ok when every money column is a float-dollar REAL", () => {
    insertQuote({ quote_id: "q1", source_gmail_message_id: "gf1", selling_price: 33990, doc_fee: 85, otd_total: 38420.5 });
    const r = assertFloatDollars({ db, sourceGmailMessageId: "gf1" });
    expect(r.ok).toBe(true);
  });

  it("fails on an integer-cents artifact (3399000 for $33,990)", () => {
    insertQuote({ quote_id: "q2", source_gmail_message_id: "gf2", selling_price: 3399000 });
    const r = assertFloatDollars({ db, sourceGmailMessageId: "gf2" });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/integer-cents/);
  });

  it("fails on a non-numeric string money value (SQLite keeps it TEXT)", () => {
    // A `real`-affinity column coerces a numeric-looking string to a number, but
    // a NON-numeric string stays TEXT — the guard must catch that (a model that
    // dumped a prose token like "N/A" into a money column).
    insertQuote({ quote_id: "q3", source_gmail_message_id: "gf3", doc_fee: "N/A" });
    const r = assertFloatDollars({ db, sourceGmailMessageId: "gf3" });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/not a number/);
  });
});

// ===========================================================================
// no_quote_zero_rows
// ===========================================================================

describe("assertNoQuoteZeroRows", () => {
  it("ok: 0 rows + succeeded + non-null intent", () => {
    insertMessage({ messageId: "mn", gmailMessageId: "gn", status: "succeeded", intent: "come_in", processedAt: "z" });
    const r = assertNoQuoteZeroRows({ db, sourceGmailMessageId: "gn" });
    expect(r.ok).toBe(true);
  });

  it("fails if the no_quote reply fabricated a row", () => {
    insertMessage({ messageId: "mn2", gmailMessageId: "gn2", status: "succeeded", intent: "come_in", processedAt: "z" });
    insertQuote({ quote_id: "qn2", message_id: "mn2", source_gmail_message_id: "gn2", selling_price: 1 });
    const r = assertNoQuoteZeroRows({ db, sourceGmailMessageId: "gn2" });
    expect(r.ok).toBe(false);
  });
});

// ===========================================================================
// rule1_rule2_belt (re-parse the read-back row)
// ===========================================================================

describe("assertRule1Rule2Belt", () => {
  it("ok: a clean finance row (apr+term present, no lease bleed) re-parses", () => {
    insertQuote({
      quote_id: "qb1",
      source_gmail_message_id: "gb1",
      financing_mode: "finance",
      finance_apr: 5.9,
      finance_term_months: 60,
      selling_price: 35500,
    });
    const r = assertRule1Rule2Belt({ db, sourceGmailMessageId: "gb1" });
    expect(r.ok).toBe(true);
  });

  it("fails on a Rule1 cross-mode bleed read back (finance field on a cash row)", () => {
    insertQuote({ quote_id: "qb2", source_gmail_message_id: "gb2", financing_mode: "cash", finance_apr: 4.9 });
    const r = assertRule1Rule2Belt({ db, sourceGmailMessageId: "gb2" });
    expect(r.ok).toBe(false);
  });

  it("rehydrateQuoteRow parses the TEXT JSON-array columns back into arrays", () => {
    const row = rehydrateQuoteRow({ rebates_json: '[{"label":"loyalty","amount":500}]', selling_price: 1 });
    expect(Array.isArray(row["rebates_json"])).toBe(true);
  });
});

// ===========================================================================
// unique_two_mode
// ===========================================================================

describe("assertUniqueTwoMode", () => {
  it("ok: exactly one finance + one lease row under one message", () => {
    insertQuote({ quote_id: "qt1", source_gmail_message_id: "gt", financing_mode: "finance", finance_apr: 5.9, finance_term_months: 60 });
    insertQuote({ quote_id: "qt2", source_gmail_message_id: "gt", financing_mode: "lease", lease_term_months: 36, lease_money_factor: 0.00185 });
    const r = assertUniqueTwoMode({ db, sourceGmailMessageId: "gt" });
    expect(r.ok).toBe(true);
  });

  it("fails when only one mode landed", () => {
    insertQuote({ quote_id: "qt3", source_gmail_message_id: "gt2", financing_mode: "finance", finance_apr: 5.9, finance_term_months: 60 });
    const r = assertUniqueTwoMode({ db, sourceGmailMessageId: "gt2" });
    expect(r.ok).toBe(false);
  });
});

// ===========================================================================
// idempotent_reextract / cost_and_time / pinned_profile
// ===========================================================================

describe("assertIdempotentReextract", () => {
  it("ok: same count + every quote_id preserved", () => {
    const r = assertIdempotentReextract({ beforeCount: 2, afterCount: 2, beforeQuoteIds: ["a", "b"], afterQuoteIds: ["a", "b"] });
    expect(r.ok).toBe(true);
  });
  it("fails when the row count grew on a re-extract", () => {
    const r = assertIdempotentReextract({ beforeCount: 2, afterCount: 3, beforeQuoteIds: ["a", "b"], afterQuoteIds: ["a", "b", "c"] });
    expect(r.ok).toBe(false);
  });
  it("fails when a quote_id changed (re-mint instead of preserve)", () => {
    const r = assertIdempotentReextract({ beforeCount: 1, afterCount: 1, beforeQuoteIds: ["a"], afterQuoteIds: ["z"] });
    expect(r.ok).toBe(false);
  });
});

describe("assertCostAndTimeAttributable", () => {
  it("ok: >= minRows ledger rows with non-null latency_ms", () => {
    const rows = [ledger({ latencyMs: 1200 }), ledger({ latencyMs: 900 })];
    const r = assertCostAndTimeAttributable({ ledgerRows: rows, minRows: 2 });
    expect(r.ok).toBe(true);
  });
  it("fails on a silent un-ledgered call (no rows)", () => {
    const r = assertCostAndTimeAttributable({ ledgerRows: [], minRows: 1 });
    expect(r.ok).toBe(false);
  });
  it("fails when a row has a null latency (no wall-clock)", () => {
    const r = assertCostAndTimeAttributable({ ledgerRows: [ledger({ latencyMs: null })], minRows: 1 });
    expect(r.ok).toBe(false);
  });
});

describe("assertPinnedProfile", () => {
  it("ok: pinned + output + every row scoped to the seeded profile", () => {
    insertQuote({ quote_id: "qp1", source_gmail_message_id: "gp1", search_profile_id: PROFILE_ID });
    const r = assertPinnedProfile({
      db,
      sourceGmailMessageId: "gp1",
      expectedProfileId: PROFILE_ID,
      outputProfileId: PROFILE_ID,
      resolution: "pinned",
    });
    expect(r.ok).toBe(true);
  });
  it("fails when resolution is inferred_newest (not an explicit pin)", () => {
    insertQuote({ quote_id: "qp2", source_gmail_message_id: "gp2", search_profile_id: PROFILE_ID });
    const r = assertPinnedProfile({
      db,
      sourceGmailMessageId: "gp2",
      expectedProfileId: PROFILE_ID,
      outputProfileId: PROFILE_ID,
      resolution: "inferred_newest",
    });
    expect(r.ok).toBe(false);
  });
  it("fails on an orphan-scoped row (a row for a different profile)", () => {
    insertQuote({ quote_id: "qp3", source_gmail_message_id: "gp3", search_profile_id: "some-other-profile" });
    const r = assertPinnedProfile({
      db,
      sourceGmailMessageId: "gp3",
      expectedProfileId: PROFILE_ID,
      outputProfileId: PROFILE_ID,
      resolution: "pinned",
    });
    expect(r.ok).toBe(false);
  });
});

// ===========================================================================
// the numeric-fidelity JUDGE — load-bearing: NOT a rubber stamp
// ===========================================================================

/** A claude-stream-shaped stdout (the parseClaudeStreamJson contract: a `result`
 *  element carrying the verdict text + a session id). */
function claudeStream(resultText: string): string {
  return JSON.stringify([
    { type: "system", subtype: "init" },
    { type: "result", result: resultText, session_id: "sess-judge-1", total_cost_usd: 0, is_error: false, model: "claude-opus-4-8" },
  ]);
}

/**
 * A DETERMINISTIC mini-judge injected as the claude spawn: it reads the judge
 * TASK (which carries GROUND_TRUTH + PERSISTED ROWS), compares the oracle's
 * selling_price to the persisted selling_price, and emits a numeric_fidelity
 * verdict. This proves the judge WIRING distinguishes a faithful extraction from
 * a number-corrupted one — the same call returns PASS on a match and FAIL on a
 * mismatch (so it is not a rubber stamp). NO live LLM.
 */
const miniJudgeExec: ExecImpl = (args) => {
  // The task is the `-p` prompt (argv[1] in buildClaudeArgs).
  const task = args[1] ?? "";
  const gtMatch = task.match(/GROUND_TRUTH[^\n]*:\n([\s\S]*?)\n\nGENERATED/);
  const rowsMatch = task.match(/PERSISTED ROWS[^\n]*:\n([\s\S]*?)\n\nACTIVE DIMS/);
  const gt = gtMatch ? (JSON.parse(gtMatch[1]!) as GroundTruth) : { message_intent: "", quotes: [] };
  const rows = rowsMatch ? (JSON.parse(rowsMatch[1]!) as Array<Record<string, unknown>>) : [];
  const truthPrice = gt.quotes[0]?.["selling_price"] ?? null;
  const rowPrice = rows[0]?.["selling_price"] ?? null;
  const pass = truthPrice === rowPrice;
  const verdict = JSON.stringify({
    dims: [
      {
        name: "numeric_fidelity",
        pass,
        rationale: pass ? "selling_price matches the oracle" : "selling_price diverges from the oracle",
      },
    ],
  });
  return Promise.resolve(claudeStream(verdict));
};

describe("runReplyJudge — load-bearing numeric fidelity (NOT a rubber stamp)", () => {
  const groundTruth: GroundTruth = { message_intent: "real_quote", quotes: [{ financing_mode: "cash", selling_price: 33990 }] };

  it("a FAITHFUL extraction (selling_price == oracle) → judge PASS", async () => {
    const verdict = await runReplyJudge({
      groundTruth,
      generatedBody: "Selling price $33,990.",
      attachmentText: "",
      persistedRows: [{ financing_mode: "cash", selling_price: 33990 }],
      activeDims: ["numeric_fidelity"],
      execImpl: miniJudgeExec,
    });
    expect(verdict.dims[0]!.pass).toBe(true);
    // A passing judge folds GREEN with a clean deterministic half.
    expect(combineSoakVerdict({ deterministic: [], judge: verdict.dims }).verdict).toBe("GREEN");
  });

  it("a NUMBER-CORRUPTED extraction (selling_price != oracle) → judge FAIL", async () => {
    const verdict = await runReplyJudge({
      groundTruth,
      generatedBody: "Selling price $33,990.",
      attachmentText: "",
      // The extractor wrote a WRONG price (the corruption the judge must catch).
      persistedRows: [{ financing_mode: "cash", selling_price: 31000 }],
      activeDims: ["numeric_fidelity"],
      execImpl: miniJudgeExec,
    });
    expect(verdict.dims[0]!.pass).toBe(false);
    // A failed soft-dim judge folds RED (the judge is load-bearing, not advisory).
    const folded = combineSoakVerdict({ deterministic: [], judge: verdict.dims });
    expect(folded.verdict).toBe("RED");
    expect(folded.defect?.kind).toBe("judge:numeric_fidelity");
  });
});

describe("buildReplyJudgeTask + parseReplyJudgeVerdict (pure)", () => {
  it("the task carries the oracle, the reply, the persisted rows + the active dims", () => {
    const task = buildReplyJudgeTask({
      groundTruth: { message_intent: "real_quote", quotes: [{ financing_mode: "cash", selling_price: 33990 }] },
      generatedBody: "Selling price $33,990.",
      attachmentText: "",
      persistedRows: [{ selling_price: 33990 }],
      activeDims: ["numeric_fidelity", "no_hallucinated_numbers"],
    });
    expect(task).toContain("GROUND_TRUTH");
    expect(task).toContain("33990");
    expect(task).toContain("PERSISTED ROWS");
    expect(task).toContain("numeric_fidelity, no_hallucinated_numbers");
    expect(task).toContain("STRICT JSON");
  });

  it("parses a strict-JSON verdict restricted to the active dims", () => {
    const raw = '{"dims":[{"name":"numeric_fidelity","pass":true,"rationale":"ok"},{"name":"intent_coherence","pass":false,"rationale":"x"}]}';
    const v = parseReplyJudgeVerdict(raw, ["numeric_fidelity", "intent_coherence"]);
    expect(v.dims).toHaveLength(2);
    expect(v.dims[1]!.pass).toBe(false);
  });

  it("fails LOUD when the judge omits an active dim", () => {
    const raw = '{"dims":[{"name":"numeric_fidelity","pass":true,"rationale":"ok"}]}';
    expect(() => parseReplyJudgeVerdict(raw, ["numeric_fidelity", "no_hallucinated_numbers"])).toThrow(
      /did not rule on active dim "no_hallucinated_numbers"/,
    );
  });

  it("fails LOUD on unparseable judge output", () => {
    expect(() => parseReplyJudgeVerdict("not json", ["numeric_fidelity"])).toThrow(/not parseable JSON/);
  });
});

// ===========================================================================
// a small read-back sanity (the helper reads the rows the assertions consume)
// ===========================================================================

describe("readQuoteRows", () => {
  it("returns every row for a source_gmail_message_id, stably ordered", () => {
    insertQuote({ quote_id: "qz1", source_gmail_message_id: "gz", financing_mode: "finance", finance_apr: 1, finance_term_months: 1 });
    insertQuote({ quote_id: "qz2", source_gmail_message_id: "gz", financing_mode: "lease", lease_term_months: 1, lease_money_factor: 1 });
    const rows = readQuoteRows(db, "gz");
    expect(rows.map((r) => r["financing_mode"])).toEqual(["finance", "lease"]);
  });
});
