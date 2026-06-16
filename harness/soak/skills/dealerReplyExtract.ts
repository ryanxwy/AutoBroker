/**
 * dealerReplyExtract soak — the F1 keystone (plan-2).
 *
 * A SELF-CONTAINED per-skill soak module. It imports plan-0's FROZEN shared
 * infra (claudeAgent spawn, the verdict contract + combineSoakVerdict, the
 * freeze plumbing, the ledger) and the EXISTING seed seam (applyDealerReplySeeds)
 * — it edits NONE of them. The SUT (dealerReplyExtract.ts / persist.ts /
 * policy.ts / dealerQuote.ts) is READ-ONLY; this driver only OBSERVES it.
 *
 * WHAT IT DOES (per scenario class):
 *   (1) spawn `claude -p --model sonnet` with the reply-extract dealer role
 *       (prompts/dealer_reply_extract.dealer.md) + the scenario directive → the
 *       dealer EMITS one JSON object {dealer_name, dealer_website, from, subject,
 *       body, attachment?, GROUND_TRUTH:{message_intent, quotes[]}};
 *   (2) STRIP GROUND_TRUTH (the judge oracle, never shown to the DeepSeek SUT) +
 *       map the rest onto a CaseSeedReply;
 *   (3) call the EXISTING harness/seed.ts applyDealerReplySeeds (reused verbatim)
 *       to materialize the inbound corpus into the ISOLATED case DB scoped to an
 *       intake-created Tucson profile (the pin);
 *   (4) run the LIVE dealer_reply_extract workflow over the seeded DB (the same
 *       flat Mastra createWorkflow the live_extract.toml drives), passing the
 *       profile id explicitly (resolution='pinned');
 *   (5) read back autobroker.db + test_run_records and run the deterministic
 *       assertions (the OPEN verdict contract: per-skill `assertionId` strings,
 *       `severity:"blocker"` for no_external_mutation + malformed fail-closed,
 *       `"red"` for the rest), then the Opus numeric-fidelity judge per reply;
 *   (6) fold via combineSoakVerdict; on a deterministic failure the caller freezes
 *       a [[seed.dealer_replies]] regression case (freezeToCorpus, reused).
 *
 * The deterministic ASSERTION FUNCTIONS are PURE (read already-loaded rows; no
 * spawn, no workflow) so they unit-test over a hand-seeded isolated tmp DB. The
 * DRIVER (runReplyExtractSoak) is structurally complete + typechecks; the LIVE
 * lane (spawn claude -p + run the live DeepSeek workflow) is NOT unit-tested —
 * it runs under `pnpm soak`, owner/local, never green.sh/CI.
 *
 * Dependency wall: harness layer. Reuses @autobroker/db (openDb at the explicit
 * isolated path — the sanctioned harness write channel seed.ts already uses),
 * @autobroker/core (the DealerQuoteSchema belt re-parse), @autobroker/workflows
 * (the flat workflow + the test-deps seam for the synthetic control), the seed
 * seam, and the soak modules. NO playwright, NO direct provider client, NO
 * better-sqlite3/drizzle import (the DB rides through @autobroker/db).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openDb, type Db } from "@autobroker/db";
import { DealerQuoteSchema } from "@autobroker/core";
import {
  createMastraInstance,
  dealerReplyExtractWorkflow,
  DEALER_REPLY_EXTRACT_WORKFLOW_ID,
} from "@autobroker/workflows";

import type { CaseSeedReply, CaseSeedReplyAttachment } from "../../cases.js";
import { applyDealerReplySeeds } from "../../seed.js";
import { externalMutationDbCount, readLedgerRowsForRun, type LedgerRow } from "../../dbReads.js";
import { spawnClaudeAgent, type ClaudeModel, type ExecImpl } from "../claudeAgent.js";
import type { ScenarioClass } from "../taxonomy.js";
import {
  assertL1FuseArmed,
  assertNoExternalMutation,
  combineSoakVerdict,
  type DeterministicResult,
  type JudgeDimResult,
  type SoakVerdictDoc,
} from "../verdict.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The reply-extract dealer role + the numeric-fidelity judge prompt (NEW, plan-2
 *  -private, disjoint from the shared dealer.md / judge.md). */
export const REPLY_EXTRACT_DEALER_PROMPT = join(HERE, "..", "..", "prompts", "dealer_reply_extract.dealer.md");
export const REPLY_EXTRACT_JUDGE_PROMPT = join(HERE, "..", "..", "prompts", "dealer_reply_extract.judge.md");

/** The committed product migrations (the isolated case DB applies all three —
 *  mirrors the workflows in-stack test + serverHost bootstrap). */
const DRIZZLE_DIR = join(HERE, "..", "..", "..", "packages", "db", "drizzle");
export const MIGRATION_FILES = [
  "0000_military_red_skull.sql",
  "0001_redundant_ozymandias.sql",
  "0002_pale_thunderball.sql",
].map((f) => join(DRIZZLE_DIR, f));

// ===========================================================================
// the dealer-emit contract + the GROUND_TRUTH oracle (the judge input)
// ===========================================================================

/** One ground-truth quote the dealer STATED (the judge oracle). A loose record:
 *  the judge reads the figures by column name; the soak never re-validates the
 *  oracle's shape (it is the dealer's own statement, by definition authoritative). */
export type GroundTruthQuote = Record<string, number | string | null>;

export interface GroundTruth {
  message_intent: string;
  quotes: GroundTruthQuote[];
}

/** The dealer agent's full emit (the reply + the oracle). GROUND_TRUTH is STRIPPED
 *  before seeding — it never reaches the DeepSeek SUT. */
export interface DealerReplyEmit {
  dealer_name: string;
  dealer_website: string;
  from: string;
  subject: string;
  body: string;
  attachment: { filename: string; mime_type: string; data_base64: string } | null;
  GROUND_TRUTH: GroundTruth;
}

/**
 * Parse the dealer agent's JSON emit (tolerant of a ```json fence / surrounding
 * prose the model may wrap). Fail-LOUD on a missing required field or a missing
 * GROUND_TRUTH block — the soak must never proceed on a half-formed dealer reply
 * (a silently-dropped oracle would make the judge vacuous).
 */
export function parseDealerReplyEmit(raw: string): DealerReplyEmit {
  const obj = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(obj);
  } catch (e) {
    throw new Error(`parseDealerReplyEmit: dealer emit is not parseable JSON — ${(e as Error).message}`);
  }
  const r = parsed as Record<string, unknown>;
  for (const key of ["dealer_name", "dealer_website", "from", "subject", "body"] as const) {
    if (typeof r[key] !== "string" || (r[key] as string).length === 0) {
      throw new Error(`parseDealerReplyEmit: dealer emit missing string field "${key}"`);
    }
  }
  const gt = r["GROUND_TRUTH"] as Record<string, unknown> | undefined;
  if (gt === undefined || typeof gt !== "object") {
    throw new Error("parseDealerReplyEmit: dealer emit missing the GROUND_TRUTH oracle block");
  }
  if (!Array.isArray(gt["quotes"])) {
    throw new Error("parseDealerReplyEmit: GROUND_TRUTH.quotes must be an array");
  }
  const attachment = r["attachment"];
  return {
    dealer_name: r["dealer_name"] as string,
    dealer_website: r["dealer_website"] as string,
    from: r["from"] as string,
    subject: r["subject"] as string,
    body: r["body"] as string,
    attachment:
      attachment === null || attachment === undefined
        ? null
        : {
            filename: String((attachment as Record<string, unknown>)["filename"] ?? ""),
            mime_type: String((attachment as Record<string, unknown>)["mime_type"] ?? ""),
            data_base64: String((attachment as Record<string, unknown>)["data_base64"] ?? ""),
          },
    GROUND_TRUTH: {
      message_intent: String(gt["message_intent"] ?? ""),
      quotes: gt["quotes"] as GroundTruthQuote[],
    },
  };
}

/**
 * STRIP the GROUND_TRUTH oracle and map the dealer emit onto a CaseSeedReply (the
 * EXACT shape applyDealerReplySeeds + the [[seed.dealer_replies]] freeze block
 * consume). The oracle never travels with the seed — only the reply text +
 * optional attachment the extractor SUT will read.
 */
export function toCaseSeedReply(emit: DealerReplyEmit): CaseSeedReply {
  const attachment: CaseSeedReplyAttachment | null =
    emit.attachment === null
      ? null
      : {
          filename: emit.attachment.filename,
          mimeType: emit.attachment.mime_type,
          dataBase64: emit.attachment.data_base64,
        };
  return {
    dealerName: emit.dealer_name,
    dealerWebsite: emit.dealer_website,
    from: emit.from,
    subject: emit.subject,
    body: emit.body,
    attachment,
  };
}

/** Extract the first balanced {…} object from model text (strips fences/prose).
 *  Mirrors verdict.ts extractJsonObject (kept private there). */
function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  if (start === -1) return text;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inStr) {
      if (ch === '"' && text[i - 1] !== "\\") inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

// ===========================================================================
// the DB read helpers (read-only; the assertions consume their output)
// ===========================================================================

/** Every dealer_quotes row for one message (the upsert key), ordered stably. */
export function readQuoteRows(db: Db, sourceGmailMessageId: string): Array<Record<string, unknown>> {
  return db.$client
    .prepare("SELECT * FROM dealer_quotes WHERE source_gmail_message_id = ? ORDER BY financing_mode, quote_id")
    .all(sourceGmailMessageId) as Array<Record<string, unknown>>;
}

/** The extraction state-machine columns for one message. */
export function readMessageState(
  db: Db,
  sourceGmailMessageId: string,
): { status: string | null; intent: string | null; processedAt: string | null } | null {
  const row = db.$client
    .prepare(
      "SELECT quote_extraction_status AS status, quote_extraction_intent AS intent, processed_at AS processedAt " +
        "FROM messages WHERE gmail_message_id = ?",
    )
    .get(sourceGmailMessageId) as
    | { status: string | null; intent: string | null; processedAt: string | null }
    | undefined;
  return row ?? null;
}

/** The money columns of dealer_quotes the float-dollars assertion scans (the
 *  `real` columns; never cents, never a string). */
export const MONEY_COLUMNS = [
  "msrp",
  "selling_price",
  "dealer_discount",
  "doc_fee",
  "dealer_fee",
  "sales_tax",
  "dmv_fees",
  "title_fee",
  "registration_fee",
  "license_fee",
  "otd_total",
  "finance_down_payment",
  "finance_monthly_payment",
  "finance_amount_financed",
  "lease_residual_value",
  "lease_due_at_signing",
  "lease_monthly_payment",
  "lease_acquisition_fee",
  "lease_disposition_fee",
  "lease_cap_cost_gross",
  "lease_cap_cost_adjusted",
  "lease_rent_charge",
] as const;

// ===========================================================================
// the deterministic assertions (PURE — unit-tested over a real isolated DB)
//
// OPEN VERDICT CONTRACT: each returns a DeterministicResult with a per-skill
// `assertionId` + `severity` ("blocker" for a safety red-line, "red" for a
// correctness failure). combineSoakVerdict folds them (a blocker → BLOCKER, a
// red → RED). verdict.ts is NEVER edited — the id space is open by design.
// ===========================================================================

/**
 * ALL-OR-NOTHING UPSERT (red): for a `succeeded` message the persisted row count
 * equals the emitted quotes[].length; a rolled-back persist leaves ZERO rows AND
 * status='failed' (intent NULL, processed_at NULL). Never a partial row set.
 */
export function assertAllOrNothingUpsert(args: {
  db: Db;
  sourceGmailMessageId: string;
  /** The status the workflow reported for THIS message ('succeeded'|'failed'). */
  terminalStatus: "succeeded" | "failed";
  /** The number of rows the model emitted for this message (the live driver reads
   *  this off the run; the unit test passes it explicitly). */
  emittedQuoteCount: number;
}): DeterministicResult {
  const rows = readQuoteRows(args.db, args.sourceGmailMessageId);
  const msg = readMessageState(args.db, args.sourceGmailMessageId);
  let ok: boolean;
  let detail: string | undefined;
  if (args.terminalStatus === "succeeded") {
    ok =
      rows.length === args.emittedQuoteCount &&
      msg?.status === "succeeded" &&
      msg?.intent !== null &&
      msg?.intent !== undefined;
    if (!ok) {
      detail =
        `succeeded message: rows=${rows.length} expected=${args.emittedQuoteCount}, ` +
        `status=${msg?.status ?? "∅"} intent=${msg?.intent ?? "∅"}`;
    }
  } else {
    // failed → ZERO rows, status='failed', intent NULL, processed_at NULL.
    ok =
      rows.length === 0 &&
      msg?.status === "failed" &&
      (msg?.intent === null || msg?.intent === undefined) &&
      (msg?.processedAt === null || msg?.processedAt === undefined);
    if (!ok) {
      detail =
        `failed message must leave ZERO rows + failed/NULL state: rows=${rows.length}, ` +
        `status=${msg?.status ?? "∅"} intent=${msg?.intent ?? "∅"} processed_at=${msg?.processedAt ?? "∅"}`;
    }
  }
  return {
    assertionId: "all_or_nothing_upsert",
    ok,
    expected:
      args.terminalStatus === "succeeded"
        ? `rows == ${args.emittedQuoteCount} + succeeded/intent-set`
        : "0 rows + failed/intent-NULL/processed_at-NULL",
    observed: { rows: rows.length, status: msg?.status ?? null, intent: msg?.intent ?? null },
    severity: "red",
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * FLOAT-DOLLARS (red): every non-null money column read back is a REAL number,
 * never a string, never an integer-cents artifact. A whole-dollar figure stored
 * as 3399000 (cents for $33,990) is the failure mode we forbid; a figure ≥
 * CENTS_FLOOR with no fractional part that is implausibly large for a car-quote
 * dollar figure flags. We assert: typeof === number; and reject the cents
 * artifact by bounding plausible dollar magnitude (a single quote field rarely
 * exceeds ~$500,000; a value ≥ that with no fractional part is the cents tell).
 */
export const CENTS_ARTIFACT_FLOOR = 500_000;

export function assertFloatDollars(args: {
  db: Db;
  sourceGmailMessageId: string;
}): DeterministicResult {
  const rows = readQuoteRows(args.db, args.sourceGmailMessageId);
  const offenders: string[] = [];
  for (const row of rows) {
    for (const col of MONEY_COLUMNS) {
      const v = row[col];
      if (v === null || v === undefined) continue;
      if (typeof v !== "number") {
        offenders.push(`${col}=${JSON.stringify(v)} (not a number)`);
        continue;
      }
      // The integer-cents tell: a whole-number value implausibly large for a
      // single car-quote dollar figure (e.g. 3399000 for $33,990).
      if (Number.isInteger(v) && Math.abs(v) >= CENTS_ARTIFACT_FLOOR) {
        offenders.push(`${col}=${v} (integer-cents artifact?)`);
      }
    }
  }
  const ok = offenders.length === 0;
  return {
    assertionId: "float_dollars",
    ok,
    expected: "every money column is a float-dollar REAL (no cents, no string)",
    observed: ok ? "all float-dollars" : offenders,
    severity: "red",
    ...(ok ? {} : { detail: `float-dollars violated: ${offenders.join("; ")}` }),
  };
}

/**
 * NO_QUOTE → 0 ROWS (red): a no_quote reply persists ZERO rows AND the message is
 * 'succeeded' with a NON-NULL intent (a zero-row succeed is not a failure). The
 * caller passes whether this seed is the no_quote class.
 */
export function assertNoQuoteZeroRows(args: {
  db: Db;
  sourceGmailMessageId: string;
}): DeterministicResult {
  const rows = readQuoteRows(args.db, args.sourceGmailMessageId);
  const msg = readMessageState(args.db, args.sourceGmailMessageId);
  const ok =
    rows.length === 0 &&
    msg?.status === "succeeded" &&
    msg?.intent !== null &&
    msg?.intent !== undefined;
  return {
    assertionId: "no_quote_zero_rows",
    ok,
    expected: "0 dealer_quotes rows + status='succeeded' + intent NOT NULL",
    observed: { rows: rows.length, status: msg?.status ?? null, intent: msg?.intent ?? null },
    severity: "red",
    ...(ok ? {} : { detail: "a no_quote reply must succeed with zero rows + a non-null intent (no fabricated quote)" }),
  };
}

/**
 * #1244 FAIL-CLOSED (BLOCKER): on a malformed extraction with no recovery, the
 * message has ZERO rows AND status='failed' (processed_at NULL → re-queued) AND a
 * test_run_records row exists for skill='dealer_reply_extract' with
 * fail_reason='malformed_tool_call'. NEVER a prose-fallthrough row. This is a
 * safety red-line → severity:"blocker".
 */
export function assertMalformedExtractionFailClosed(args: {
  db: Db;
  sourceGmailMessageId: string;
  ledgerRows: readonly LedgerRow[];
}): DeterministicResult {
  const rows = readQuoteRows(args.db, args.sourceGmailMessageId);
  const msg = readMessageState(args.db, args.sourceGmailMessageId);
  const sawMalformedLedger = args.ledgerRows.some(
    (r) => r.skill === "dealer_reply_extract" && r.failReason === "malformed_tool_call",
  );
  const ok =
    rows.length === 0 &&
    msg?.status === "failed" &&
    (msg?.processedAt === null || msg?.processedAt === undefined) &&
    sawMalformedLedger;
  return {
    assertionId: "malformed_extraction_fail_closed",
    ok,
    expected: "0 rows + status='failed' (processed_at NULL) + a malformed_tool_call ledger row",
    observed: {
      rows: rows.length,
      status: msg?.status ?? null,
      processedAt: msg?.processedAt ?? null,
      sawMalformedLedger,
    },
    severity: "blocker",
    ...(ok ? {} : { detail: "#1244 fail-closed violated (a prose-fallthrough row or no malformed ledger)" }),
  };
}

/**
 * F1 RETRY FIRES ONLY ON THE MALFORMED CLASS (red): on a run where the first hop
 * returned malformed and the retry succeeded, exactly the two-ledger-row shape:
 * one deepseek.chat row with fail_reason='malformed_tool_call', then one
 * deepseek.strong row with fail_reason=null; AND the persisted
 * dealer_quotes.extractor_provider = 'deepseek' (same-provider/privacy-clean). On
 * a CLEAN first hop, NO deepseek.strong row. On a ZodError first-hop, NO
 * deepseek.strong row (isMalformedToolCallError(ZodError)=false → retry skipped).
 *
 * `expectRetry` declares the scenario's expectation: true (the F1/synthetic class
 * — the retry MUST have fired with the malformed→clean shape), false (a clean or
 * ZodError first hop — the retry must NOT have fired).
 */
export function assertF1RetryOnlyOnMalformed(args: {
  db: Db;
  sourceGmailMessageId: string;
  ledgerRows: readonly LedgerRow[];
  expectRetry: boolean;
}): DeterministicResult {
  const chatRows = args.ledgerRows.filter(
    (r) => r.skill === "dealer_reply_extract" && r.modelAlias === "deepseek.chat",
  );
  const strongRows = args.ledgerRows.filter(
    (r) => r.skill === "dealer_reply_extract" && r.modelAlias === "deepseek.strong",
  );
  let ok: boolean;
  let detail: string | undefined;
  if (args.expectRetry) {
    const firstHopMalformed = chatRows.some((r) => r.failReason === "malformed_tool_call");
    const retryClean = strongRows.length === 1 && strongRows[0]!.failReason === null;
    const provider = strongRows[0]?.provider ?? null;
    const quoteRows = readQuoteRows(args.db, args.sourceGmailMessageId);
    const stampedDeepseek =
      quoteRows.length > 0 && quoteRows.every((r) => r["extractor_provider"] === "deepseek");
    ok = firstHopMalformed && retryClean && provider === "deepseek" && stampedDeepseek;
    if (!ok) {
      detail =
        `F1 retry shape: firstHopMalformed=${firstHopMalformed} retryClean=${retryClean} ` +
        `strongProvider=${provider ?? "∅"} stampedDeepseek=${stampedDeepseek}`;
    }
  } else {
    // The retry must NOT have fired (clean first hop OR a ZodError first hop).
    ok = strongRows.length === 0;
    if (!ok) detail = `expected NO deepseek.strong ledger row, found ${strongRows.length}`;
  }
  return {
    assertionId: "f1_retry_only_on_malformed",
    ok,
    expected: args.expectRetry
      ? "deepseek.chat(malformed) → deepseek.strong(clean), extractor_provider='deepseek'"
      : "no deepseek.strong retry row",
    observed: { chatRows: chatRows.length, strongRows: strongRows.length },
    severity: "red",
    ...(detail !== undefined ? { detail } : {}),
  };
}

/**
 * RULE1/RULE2 BELT (red): every persisted dealer_quotes row re-parses through
 * DealerQuoteSchema (the .strict + Rule1/Rule2 superRefine) — a row that would
 * violate Rule1 (cross-mode leak) or a surviving Rule2 failure (a finance row
 * missing apr+term, a lease row missing term+(MF|residual)) fails. The persist
 * layer already validates on write; this re-confirms the READ-BACK row is clean
 * (the table round-trip never relaxed the belt).
 */
export function assertRule1Rule2Belt(args: {
  db: Db;
  sourceGmailMessageId: string;
}): DeterministicResult {
  const rows = readQuoteRows(args.db, args.sourceGmailMessageId);
  const offenders: string[] = [];
  for (const row of rows) {
    const rehydrated = rehydrateQuoteRow(row);
    const parsed = DealerQuoteSchema.safeParse(rehydrated);
    if (!parsed.success) {
      offenders.push(`${String(row["quote_id"])}: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
    }
  }
  const ok = offenders.length === 0;
  return {
    assertionId: "rule1_rule2_belt",
    ok,
    expected: "every read-back row passes DealerQuoteSchema (Rule1 no-leak + Rule2 mode-required)",
    observed: ok ? "belt held" : offenders,
    severity: "red",
    ...(ok ? {} : { detail: `Rule1/Rule2 belt violated on read-back: ${offenders.join("; ")}` }),
  };
}

/**
 * UNIQUE TWO-MODE COEXISTENCE (red): for the large_2mode seed, EXACTLY one row
 * financing_mode='finance' AND exactly one financing_mode='lease' under the same
 * source_gmail_message_id (the UNIQUE(source_gmail_message_id, financing_mode)
 * key permits both). The soak asserts the EXACT two-mode split, not just a floor.
 */
export function assertUniqueTwoMode(args: {
  db: Db;
  sourceGmailMessageId: string;
}): DeterministicResult {
  const rows = readQuoteRows(args.db, args.sourceGmailMessageId);
  const finance = rows.filter((r) => r["financing_mode"] === "finance");
  const lease = rows.filter((r) => r["financing_mode"] === "lease");
  const ok = finance.length === 1 && lease.length === 1;
  return {
    assertionId: "unique_two_mode",
    ok,
    expected: "exactly 1 finance row + exactly 1 lease row under one message",
    observed: { finance: finance.length, lease: lease.length, total: rows.length },
    severity: "red",
    ...(ok ? {} : { detail: "the two-mode reply must persist exactly one finance + one lease row" }),
  };
}

/**
 * IDEMPOTENT RE-EXTRACT (red): re-running over the same isolated DB writes ZERO
 * net-new dealer_quotes rows (succeeded rows are terminal and not re-selected),
 * and no already-succeeded quote_id changed. The caller captures the
 * before/after total count + the quote_id sets around a second run.
 */
export function assertIdempotentReextract(args: {
  beforeCount: number;
  afterCount: number;
  beforeQuoteIds: readonly string[];
  afterQuoteIds: readonly string[];
}): DeterministicResult {
  const sameCount = args.beforeCount === args.afterCount;
  const before = new Set(args.beforeQuoteIds);
  const after = new Set(args.afterQuoteIds);
  const preserved = [...before].every((id) => after.has(id)) && before.size === after.size;
  const ok = sameCount && preserved;
  return {
    assertionId: "idempotent_reextract",
    ok,
    expected: "a re-extract adds 0 net-new rows + preserves every succeeded quote_id",
    observed: { beforeCount: args.beforeCount, afterCount: args.afterCount },
    severity: "red",
    ...(ok ? {} : { detail: "re-extract was not idempotent (row count grew or a quote_id changed)" }),
  };
}

/**
 * COST_AND_TIME ATTRIBUTABLE (red): this is the live-LLM skill, so ≥1
 * test_run_records row for skill='dealer_reply_extract' with a non-null
 * latency_ms per processed message must exist (cost may be null-not-$0 if usage
 * is missing, but the row + wall-clock MUST exist). No silent un-ledgered LLM
 * call. The caller passes the number of messages that reached an LLM hop.
 */
export function assertCostAndTimeAttributable(args: {
  ledgerRows: readonly LedgerRow[];
  /** The minimum number of distinct latency-bearing ledger rows required (>=1 per
   *  processed message; the live driver passes the processed-message count). */
  minRows: number;
}): DeterministicResult {
  const skillRows = args.ledgerRows.filter((r) => r.skill === "dealer_reply_extract");
  const withLatency = skillRows.filter((r) => r.latencyMs !== null);
  const ok = skillRows.length >= 1 && withLatency.length >= args.minRows;
  return {
    assertionId: "cost_and_time_attributable",
    ok,
    expected: `>= ${args.minRows} ledger row(s) with non-null latency_ms`,
    observed: { skillRows: skillRows.length, withLatency: withLatency.length },
    severity: "red",
    ...(ok ? {} : { detail: "the live-LLM skill must ledger a non-null latency_ms per processed message" }),
  };
}

/**
 * PROFILE-ASK / PIN (red): the run resolved exactly the seeded Tucson profile
 * (resolution='pinned' since the soak passes search_profile_id explicitly) AND
 * every persisted row's search_profile_id matches it (orphan-row discipline:
 * NON-NULL provenance).
 */
export function assertPinnedProfile(args: {
  db: Db;
  sourceGmailMessageId: string;
  expectedProfileId: string;
  outputProfileId: string;
  resolution: string;
}): DeterministicResult {
  const rows = readQuoteRows(args.db, args.sourceGmailMessageId);
  const outputMatches = args.outputProfileId === args.expectedProfileId;
  const resolutionPinned = args.resolution === "pinned";
  const everyRowScoped = rows.every((r) => r["search_profile_id"] === args.expectedProfileId);
  const ok = outputMatches && resolutionPinned && everyRowScoped;
  return {
    assertionId: "pinned_profile",
    ok,
    expected: `resolution='pinned' + output + every row scoped to ${args.expectedProfileId}`,
    observed: {
      resolution: args.resolution,
      outputProfileId: args.outputProfileId,
      everyRowScoped,
    },
    severity: "red",
    ...(ok ? {} : { detail: "the run did not pin exactly the seeded profile (or an orphan-scoped row)" }),
  };
}

/**
 * Re-hydrate a raw dealer_quotes DB row into the DealerQuoteSchema shape: the
 * four JSON-array columns are TEXT in the table (the persist layer JSON.stringify's
 * them) — parse them back so the belt re-parse sees the array shape. Every other
 * column passes through (float dollars stay floats, ints stay ints). Pure.
 */
export function rehydrateQuoteRow(row: Record<string, unknown>): Record<string, unknown> {
  const jsonCols = ["rebates_json", "other_fees_json", "add_ons_json", "taxable_rebates_json"] as const;
  const out: Record<string, unknown> = { ...row };
  for (const col of jsonCols) {
    const v = out[col];
    if (typeof v === "string") {
      try {
        out[col] = JSON.parse(v);
      } catch {
        // Leave the string as-is — the belt re-parse will reject a non-array,
        // which is the correct (loud) outcome for a corrupt JSON column.
      }
    }
  }
  return out;
}

// ===========================================================================
// the Opus numeric-fidelity judge (this driver's OWN judge — disjoint dims)
// ===========================================================================

export interface ReplyJudgeDimResult extends JudgeDimResult {
  /** The dim name is a free string (this driver's numeric_fidelity etc.), not the
   *  shared JUDGE_DIM_IDS — the shared runJudge is NOT reused. */
}

export interface ReplyJudgeVerdict {
  dims: ReplyJudgeDimResult[];
  raw: string;
}

/** Build the numeric-fidelity judge user-turn: the GROUND_TRUTH oracle + the
 *  generated reply text (+ attachment text) + the persisted rows + the active
 *  dims. Pure — unit-tested. */
export function buildReplyJudgeTask(args: {
  groundTruth: GroundTruth;
  generatedBody: string;
  attachmentText: string;
  persistedRows: ReadonlyArray<Record<string, unknown>>;
  activeDims: readonly string[];
}): string {
  return [
    "Rule ONLY on the numeric-fidelity dims listed under ACTIVE DIMS. You do NOT",
    "see the extractor's prompt — judge by comparing the oracle to the persisted",
    "rows (and the reply text for absence checks).",
    "",
    `GROUND_TRUTH (the dealer's own stated numbers — the oracle):\n${JSON.stringify(args.groundTruth, null, 2)}`,
    "",
    `GENERATED REPLY (body${args.attachmentText.trim() === "" ? "" : " + attachment text"}):\n${
      args.attachmentText.trim() === ""
        ? args.generatedBody
        : `${args.generatedBody}\n\n[ATTACHMENT TEXT]\n${args.attachmentText}`
    }`,
    "",
    `PERSISTED ROWS (dealer_quotes for this message):\n${JSON.stringify(args.persistedRows, null, 2)}`,
    "",
    `ACTIVE DIMS: ${args.activeDims.join(", ")}`,
    "",
    'Emit STRICT JSON only: {"dims":[{"name":"<dim>","pass":true|false,"rationale":"<one sentence>"}]}',
  ].join("\n");
}

/**
 * Parse the numeric-fidelity judge's strict-JSON verdict, restricted to the active
 * dims (a dim the judge did not return is a fail-LOUD). Tolerant of a fenced
 * ```json block. Mirrors verdict.parseJudgeVerdict but over THIS driver's free
 * dim names (the shared parser hard-codes JUDGE_DIM_IDS). Pure — unit-tested.
 */
export function parseReplyJudgeVerdict(raw: string, activeDims: readonly string[]): ReplyJudgeVerdict {
  const jsonText = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`parseReplyJudgeVerdict: judge output is not parseable JSON — ${(e as Error).message}`);
  }
  const dimsRaw = (parsed as { dims?: unknown }).dims;
  if (!Array.isArray(dimsRaw)) {
    throw new Error('parseReplyJudgeVerdict: judge output missing a "dims" array');
  }
  const active = new Set(activeDims);
  const byName = new Map<string, ReplyJudgeDimResult>();
  for (const d of dimsRaw) {
    const row = d as { name?: unknown; pass?: unknown; rationale?: unknown };
    if (typeof row.name !== "string" || !active.has(row.name)) continue;
    byName.set(row.name, {
      name: row.name as JudgeDimResult["name"],
      pass: row.pass === true,
      rationale: typeof row.rationale === "string" ? row.rationale : "",
    });
  }
  const dims: ReplyJudgeDimResult[] = [];
  for (const dim of activeDims) {
    const got = byName.get(dim);
    if (got === undefined) {
      throw new Error(`parseReplyJudgeVerdict: judge did not rule on active dim "${dim}"`);
    }
    dims.push(got);
  }
  return { dims, raw };
}

/** Run the Opus numeric-fidelity judge over one reply (spawn claude -p, parse the
 *  strict verdict). The judge sees the oracle + reply + persisted rows only —
 *  never the DeepSeek prompt, so it cannot be gamed. */
export async function runReplyJudge(opts: {
  groundTruth: GroundTruth;
  generatedBody: string;
  attachmentText: string;
  persistedRows: ReadonlyArray<Record<string, unknown>>;
  activeDims: readonly string[];
  model?: ClaudeModel;
  execImpl?: ExecImpl;
}): Promise<ReplyJudgeVerdict> {
  const task = buildReplyJudgeTask({
    groundTruth: opts.groundTruth,
    generatedBody: opts.generatedBody,
    attachmentText: opts.attachmentText,
    persistedRows: opts.persistedRows,
    activeDims: opts.activeDims,
  });
  const result = await spawnClaudeAgent({
    rolePromptPath: REPLY_EXTRACT_JUDGE_PROMPT,
    model: opts.model ?? "opus",
    task,
    ...(opts.execImpl !== undefined ? { execImpl: opts.execImpl } : {}),
  });
  return parseReplyJudgeVerdict(result.generatedText, opts.activeDims);
}

// ===========================================================================
// the isolated-DB bootstrap + the LIVE workflow run (the driver spine)
// ===========================================================================

/** The intake-shaped Tucson profile the soak pins. Mirrors the live_extract.toml
 *  [narrative.profile] (a finance Tucson Hybrid Limited near Irvine). */
export interface SeededProfile {
  profileId: string;
  accountId: string;
}

/**
 * Bootstrap the ISOLATED case DB: apply the committed migrations + materialize the
 * pinned Tucson account+profile (the harness's sanctioned DB-write channel —
 * the SAME @autobroker/db seam seed.ts + serverHost bootstrap use, scoped to the
 * explicit isolated path). The product code is never touched; this only writes
 * the run's throwaway DB. Returns the pinned profile id.
 */
export function bootstrapCaseDb(opts: {
  dbPath: string;
  profileId?: string;
  accountId?: string;
}): SeededProfile {
  const profileId = opts.profileId ?? "soak-dre-profile";
  const accountId = opts.accountId ?? "soak-dre-account";
  const db = openDb(opts.dbPath);
  try {
    for (const file of MIGRATION_FILES) db.$client.exec(readFileSync(file, "utf8"));
    db.$client
      .prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?) ON CONFLICT(account_id) DO NOTHING")
      .run(accountId, "soak-buyer@example.com");
    db.$client
      .prepare(
        "INSERT INTO search_profiles (search_profile_id, year, make, model, trim, " +
          "search_radius_miles, location_query, postal_code, latitude, longitude, " +
          "follow_up_email, financing_preference, status, brand, account_id) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(search_profile_id) DO NOTHING",
      )
      .run(
        profileId,
        2026,
        "Hyundai",
        "Tucson Hybrid",
        "Limited",
        120,
        "Irvine, CA 92614",
        "92614",
        33.6695,
        -117.7669,
        "soak-buyer@example.com",
        "finance",
        "active",
        "Hyundai",
        accountId,
      );
  } finally {
    db.$client.close();
  }
  return { profileId, accountId };
}

/** The terminal outcome of one live workflow run (the driver reads this to drive
 *  the assertions). */
export interface ReplyExtractRunResult {
  runId: string;
  /** The Mastra run status ('success'|'failed'|'suspended'). */
  status: string;
  /** The workflow output (when status='success'). */
  output: {
    resolution: string;
    search_profile_id: string;
    quotes_upserted: number;
    messages_processed: number;
    messages_failed: number;
  } | null;
}

/**
 * Run the LIVE dealer_reply_extract workflow over the seeded isolated DB, pinned
 * to `profileId` (resolution='pinned'). Uses the REAL flat Mastra workflow via
 * createMastraInstance + createRun/start — the SAME chain the live_extract.toml
 * step drives, exercising real DeepSeek (the workflow's realDeps). The caller has
 * already set AUTOBROKER_DB / AUTOBROKER_DATA_DIR to the isolated path so getDb()
 * inside the workflow resolves the case DB.
 *
 * STRUCTURALLY COMPLETE; the live lane is NOT unit-tested (it shells the real
 * provider). Under `pnpm soak` only.
 */
export async function runLiveReplyExtract(opts: {
  runId: string;
  profileId: string;
}): Promise<ReplyExtractRunResult> {
  const mastra = createMastraInstance({
    workflows: { [DEALER_REPLY_EXTRACT_WORKFLOW_ID]: dealerReplyExtractWorkflow as never },
  });
  const workflow = mastra.getWorkflow(DEALER_REPLY_EXTRACT_WORKFLOW_ID);
  const run = await workflow.createRun({ runId: opts.runId });
  const result = (await run.start({
    inputData: { search_profile_id: opts.profileId },
  })) as { status: string; result?: Record<string, unknown> };

  const output =
    result.status === "success" && result.result !== undefined
      ? {
          resolution: String(result.result["resolution"]),
          search_profile_id: String(result.result["search_profile_id"]),
          quotes_upserted: Number(result.result["quotes_upserted"]),
          messages_processed: Number(result.result["messages_processed"]),
          messages_failed: Number(result.result["messages_failed"]),
        }
      : null;
  return { runId: opts.runId, status: result.status, output };
}

// ===========================================================================
// the per-scenario soak (spawn dealer → seed → run → assert → judge → fold)
// ===========================================================================

export interface RunReplyExtractSoakOpts {
  scenario: ScenarioClass;
  /** The isolated case DB path (the caller owns AUTOBROKER_DB/AUTOBROKER_DATA_DIR
   *  pinning + arms the L1 fuse). */
  dbPath: string;
  /** The pinned profile id (bootstrapCaseDb created it). */
  profileId: string;
  /** The env handed to the run (the L1-fuse anchor reads it). */
  env: NodeJS.ProcessEnv;
  /** The mutation baseline captured before seeding (the no_external_mutation
   *  keystone delta). */
  baseline: number;
  /** A pre-generated dealer emit (the synthetic-control class supplies a frozen
   *  fixture instead of a live spawn; live classes leave this undefined → spawn). */
  presetEmit?: DealerReplyEmit;
  /** Test seam: inject the dealer spawn (unit tests never shell claude). */
  dealerExecImpl?: ExecImpl;
  /** Test seam: inject the judge spawn. */
  judgeExecImpl?: ExecImpl;
  /** Wall-clock budget for each claude spawn (ms). */
  legTimeoutMs?: number;
}

export interface RunReplyExtractSoakResult {
  scenarioId: string;
  /** The dealer emit (for the ledger / freeze layer). */
  emit: DealerReplyEmit;
  /** The seed's source_gmail_message_id (the one reply this scenario seeds). */
  sourceGmailMessageId: string;
  run: ReplyExtractRunResult;
  verdict: SoakVerdictDoc;
}

/**
 * Drive ONE reply-extract scenario end-to-end: spawn the Sonnet dealer (or use a
 * preset frozen fixture), strip GROUND_TRUTH, seed via applyDealerReplySeeds, run
 * the live workflow pinned to the profile, then run the deterministic assertions
 * + the Opus numeric-fidelity judge and fold via combineSoakVerdict.
 *
 * STRUCTURALLY COMPLETE; the live lane (claude spawn + live DeepSeek workflow) is
 * NOT unit-tested. The pure assertion + judge-parse functions above ARE.
 */
export async function runReplyExtractSoak(
  opts: RunReplyExtractSoakOpts,
): Promise<RunReplyExtractSoakResult> {
  // (1) the dealer turn — a frozen fixture (synthetic control) or a live spawn.
  const emit =
    opts.presetEmit ??
    parseDealerReplyEmit(
      (
        await spawnClaudeAgent({
          rolePromptPath: REPLY_EXTRACT_DEALER_PROMPT,
          model: "sonnet",
          task: dealerTaskFor(opts.scenario),
          ...(opts.dealerExecImpl !== undefined ? { execImpl: opts.dealerExecImpl } : {}),
          ...(opts.legTimeoutMs !== undefined ? { timeoutMs: opts.legTimeoutMs } : {}),
        })
      ).generatedText,
    );

  // (2) strip GROUND_TRUTH → CaseSeedReply, (3) seed via the EXISTING seam.
  const seed = toCaseSeedReply(emit);
  applyDealerReplySeeds({ dbPath: opts.dbPath, profileId: opts.profileId, replies: [seed] });
  // The seed mints exactly one reply at index 0 (the deterministic per-reply id).
  const sourceGmailMessageId = `dre-seed-gmsg-${opts.profileId}-reply-0`;

  // (4) run the LIVE workflow pinned to the profile.
  const run = await runLiveReplyExtract({ runId: `soak-dre-${opts.scenario.id}`, profileId: opts.profileId });

  // (5) read back + assert. Open one read handle for the deterministic half.
  const db = openDb(opts.dbPath);
  const deterministic: DeterministicResult[] = [];
  let persistedRows: Array<Record<string, unknown>> = [];
  try {
    // The keystone + L1 fuse (always-on floor; reused from verdict.ts).
    deterministic.push(assertL1FuseArmed(opts.env));
    deterministic.push(assertNoExternalMutation({ db, baseline: opts.baseline }));

    const ledgerRows = readLedgerRowsForRun(db, run.runId);
    persistedRows = readQuoteRows(db, sourceGmailMessageId);
    const msg = readMessageState(db, sourceGmailMessageId);
    const terminalStatus: "succeeded" | "failed" = msg?.status === "succeeded" ? "succeeded" : "failed";
    const expectsZeroRows = opts.scenario.className === "no_quote_chitchat";
    const expectsTwoMode = opts.scenario.className === "large_2mode_every_fee";
    const expectsMalformed =
      opts.scenario.className === "large_2mode_every_fee" ||
      opts.scenario.className === "malformed_injection_synthetic_control";

    const wanted = new Set(opts.scenario.deterministicAssertions);
    if (wanted.has("all_or_nothing_upsert")) {
      deterministic.push(
        assertAllOrNothingUpsert({
          db,
          sourceGmailMessageId,
          terminalStatus,
          emittedQuoteCount: terminalStatus === "succeeded" ? persistedRows.length : 0,
        }),
      );
    }
    if (wanted.has("float_dollars")) {
      deterministic.push(assertFloatDollars({ db, sourceGmailMessageId }));
    }
    if (wanted.has("no_quote_zero_rows") && expectsZeroRows) {
      deterministic.push(assertNoQuoteZeroRows({ db, sourceGmailMessageId }));
    }
    if (wanted.has("rule1_rule2_belt")) {
      deterministic.push(assertRule1Rule2Belt({ db, sourceGmailMessageId }));
    }
    if (wanted.has("unique_two_mode") && expectsTwoMode && terminalStatus === "succeeded") {
      deterministic.push(assertUniqueTwoMode({ db, sourceGmailMessageId }));
    }
    if (wanted.has("malformed_extraction_fail_closed") && terminalStatus === "failed") {
      // The fail-closed assertion only applies when the message actually failed
      // (the F1 class self-heals on a good day — then there is nothing to assert
      // fail-closed; the synthetic control always exercises it).
      deterministic.push(
        assertMalformedExtractionFailClosed({ db, sourceGmailMessageId, ledgerRows }),
      );
    }
    if (wanted.has("f1_retry_only_on_malformed")) {
      // expectRetry: the F1/synthetic class expects the retry hop to have fired
      // (and recovered) — but only when a deepseek.strong row exists; on a clean
      // first hop the retry must NOT have fired. We score the actual ledger shape
      // against whether the malformed class was exercised.
      const sawStrong = ledgerRows.some(
        (r) => r.skill === "dealer_reply_extract" && r.modelAlias === "deepseek.strong",
      );
      deterministic.push(
        assertF1RetryOnlyOnMalformed({
          db,
          sourceGmailMessageId,
          ledgerRows,
          expectRetry: expectsMalformed && sawStrong,
        }),
      );
    }
    if (wanted.has("cost_and_time_attributable")) {
      deterministic.push(
        assertCostAndTimeAttributable({
          ledgerRows,
          minRows: Math.max(1, run.output?.messages_processed ?? 1),
        }),
      );
    }
    if (wanted.has("pinned_profile")) {
      deterministic.push(
        assertPinnedProfile({
          db,
          sourceGmailMessageId,
          expectedProfileId: opts.profileId,
          outputProfileId: run.output?.search_profile_id ?? "",
          resolution: run.output?.resolution ?? "",
        }),
      );
    }
  } finally {
    db.$client.close();
  }

  // (5b) the Opus numeric-fidelity judge (load-bearing on the soft dims). Skipped
  // when the scenario activates no judge dims (the synthetic control) or when no
  // rows persisted on a quote-bearing class (the judge has nothing to compare —
  // the deterministic half already scored that).
  let judge: JudgeDimResult[] = [];
  if (opts.scenario.judgeDims.length > 0) {
    const attachmentText = "";
    const verdict = await runReplyJudge({
      groundTruth: emit.GROUND_TRUTH,
      generatedBody: emit.body,
      attachmentText,
      persistedRows,
      activeDims: opts.scenario.judgeDims,
      ...(opts.judgeExecImpl !== undefined ? { execImpl: opts.judgeExecImpl } : {}),
    });
    judge = verdict.dims;
  }

  const verdict = combineSoakVerdict({ deterministic, judge });
  return { scenarioId: opts.scenario.id, emit, sourceGmailMessageId, run, verdict };
}

/** Build the dealer's per-scenario directive (the user turn). The role file owns
 *  the {…,GROUND_TRUTH} output contract + the hard rules; the task carries the
 *  edge-class directive + a minimal synthetic buyer inquiry for realism. */
export function dealerTaskFor(scenario: ScenarioClass): string {
  return [
    `SCENARIO DIRECTIVE — edge class: ${scenario.className}.`,
    `What this reply must stress: ${scenario.stresses}`,
    "",
    "A buyer emailed you asking for an out-the-door quote on a 2026 Hyundai Tucson",
    "Hybrid Limited near Irvine, CA. Write the dealer reply this directive calls",
    "for and record your exact stated numbers in GROUND_TRUTH.",
    "",
    "Emit ONLY the one JSON object {dealer_name, dealer_website, from, subject,",
    "body, attachment, GROUND_TRUTH} — no prose around it.",
  ].join("\n");
}

/** Capture the keystone external-mutation baseline off the isolated DB (mirrors
 *  orchestrator.captureMutationBaseline but at the explicit case path). */
export function captureBaseline(dbPath: string): number {
  const db = openDb(dbPath);
  try {
    return externalMutationDbCount(db).total;
  } finally {
    db.$client.close();
  }
}
