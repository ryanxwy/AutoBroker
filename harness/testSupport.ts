/**
 * testSupport — OFFLINE test helpers for the harness unit tests.
 * Builds an ISOLATED tmp product DB with the committed migration
 * applied, plus fixture SSE frame sequences synthesized from the REAL wire shapes
 * (the committed server.integration.test.ts: init→awaiting_user→text→done for a
 * created run; init→awaiting_user→aborted{user_declined} for a decline).
 *
 * The tmp DB lets the DB-reading anchors (table_min_rows / no_external_mutation /
 * cost_and_time) be scored OFFLINE against rows we INSERT to mimic what the SUT
 * would have written — without a live server or any LLM call. This is test-only;
 * the harness production path NEVER writes the DB.
 *
 * Dependency wall: this file is imported ONLY by *.test.ts (vitest). It uses
 * @autobroker/db openDb for the isolated tmp DB. The migration apply is a test
 * bootstrap, not a product write path.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openDb, type Db } from "@autobroker/db";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "packages", "db", "drizzle");

/** Every committed migration file in journal order — a fresh test DB gets the
 *  whole set (a later migration can carry an index that upserts depend on). */
function migrationFiles(): string[] {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  return journal.entries.map((e) => join(MIGRATIONS_DIR, `${e.tag}.sql`));
}

export interface TmpDb {
  db: Db;
  dir: string;
  close: () => void;
}

/** Create an isolated tmp DB under os.tmpdir() (NEVER ~/.autobroker*), apply the
 *  committed migration + a seed account, and return the handle. */
export function makeTmpDb(): TmpDb {
  const dir = mkdtempSync(join(tmpdir(), "autobroker-harness-test-"));
  const prevDataDir = process.env.AUTOBROKER_DATA_DIR;
  const prevDb = process.env.AUTOBROKER_DB;
  process.env.AUTOBROKER_DATA_DIR = dir;
  delete process.env.AUTOBROKER_DB;

  const db = openDb();
  for (const file of migrationFiles()) db.$client.exec(readFileSync(file, "utf8"));
  db.$client.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run("acct-test-1", "t@e.com");

  return {
    db,
    dir,
    close: () => {
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
      if (prevDataDir === undefined) delete process.env.AUTOBROKER_DATA_DIR;
      else process.env.AUTOBROKER_DATA_DIR = prevDataDir;
      if (prevDb === undefined) delete process.env.AUTOBROKER_DB;
      else process.env.AUTOBROKER_DB = prevDb;
    },
  };
}

/** Insert a search_profiles row (the shape the intake persist writes). Returns id. */
export function insertProfile(db: Db, id: string, opts: { brand?: string; status?: string } = {}): void {
  db.$client
    .prepare(
      `INSERT INTO search_profiles (search_profile_id, make, model, year, brand, location_query, account_id, status)
       VALUES (?, 'Hyundai', 'Tucson Hybrid', 2026, ?, 'Irvine, CA', 'acct-test-1', ?)`,
    )
    .run(id, opts.brand ?? "Hyundai", opts.status ?? "active");
}

/** Insert an audit_log row (e.g. action='search_profile_intake' for the created
 *  profile, or action='intake_verification_forced' with a null search_profile_id). */
export function insertAudit(db: Db, opts: { auditId: string; action: string; profileId?: string | null }): void {
  db.$client
    .prepare(
      `INSERT INTO audit_log (audit_id, action, target_table, search_profile_id)
       VALUES (?, ?, 'search_profiles', ?)`,
    )
    .run(opts.auditId, opts.action, opts.profileId ?? null);
}

/** Insert a test_run_records ledger row (the SUT's writeTestRunRecord output). */
export function insertLedgerRow(
  db: Db,
  opts: {
    runId: string;
    createdAt?: string;
    layer?: string;
    provider?: string;
    modelAlias?: string;
    costUsd?: number | null;
    latencyMs?: number | null;
    pricingSource?: string;
    failReason?: string | null;
  },
): void {
  db.$client
    .prepare(
      `INSERT INTO test_run_records
        (run_id, skill, created_at, layer, provider, model_alias, cost_usd, latency_ms,
         input_tokens, output_tokens, pricing_source, price_input_per_mtok,
         price_output_per_mtok, prompt_version, schema_version, fail_reason)
       VALUES (?, 'search_profile_intake', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'm1-v1', 'm1-v1', ?)`,
    )
    .run(
      opts.runId,
      opts.createdAt ?? "2026-06-05",
      opts.layer ?? "L2",
      opts.provider ?? "deepseek",
      opts.modelAlias ?? "deepseek-v4-flash",
      opts.costUsd ?? null,
      opts.latencyMs ?? 7320,
      opts.costUsd != null ? 1200 : null,
      opts.costUsd != null ? 800 : null,
      opts.pricingSource ?? (opts.costUsd != null ? "deepseek-2026-06" : "unavailable"),
      opts.costUsd != null ? 0.27 : null,
      opts.costUsd != null ? 1.1 : null,
      opts.failReason ?? null,
    );
}

/** Insert a lead_submissions row with outcome='submitted' (a KEYSTONE violation to
 *  prove the anchor catches it). Uses the xor-check-valid web_form shape. */
export function insertSubmittedLead(db: Db, opts: { submissionId: string; dealerId: string; profileId?: string | null }): void {
  // The lead_submissions check constraint requires a valid outcome combination; a
  // submitted web_form lead needs submission_channel='web_form'. Seed the dealer FK.
  db.$client
    .prepare(`INSERT OR IGNORE INTO dealers (dealer_id, name) VALUES (?, 'Test Dealer')`)
    .run(opts.dealerId);
  db.$client
    .prepare(
      `INSERT INTO lead_submissions (submission_id, dealer_id, search_profile_id, outcome, submission_channel)
       VALUES (?, ?, ?, 'submitted', 'web_form')`,
    )
    .run(opts.submissionId, opts.dealerId, opts.profileId ?? null);
}

// ---------------------------------------------------------------------------
// fixture SSE frame sequences (synthesized from the REAL committed wire shapes)
// ---------------------------------------------------------------------------

export interface FixtureFrame {
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
}

let tsCounter = 0;
function nextTs(): string {
  tsCounter += 1;
  return `2026-06-05T00:00:0${tsCounter % 10}.000Z`;
}

/** init frame (runPubSub injects driver_kind='deepseek_apikey'). */
export function initFrame(driverKind = "deepseek_apikey"): FixtureFrame {
  return { ts: nextTs(), kind: "init", payload: { run_id: "r_fixture", skill: "search_profile_intake", driver_kind: driverKind } };
}

export function awaitingUserFrame(kind = "data_collection", decisionId = "dc-1", step = "collect"): FixtureFrame {
  return {
    ts: nextTs(),
    kind: "awaiting_user",
    payload: { form_kind: kind, spec_inline: { kind }, decision_id: decisionId, step },
  };
}

export function textFrame(text = "Created search profile for 2026 Hyundai Tucson Hybrid."): FixtureFrame {
  return { ts: nextTs(), kind: "text", payload: { text } };
}

export function doneFrame(): FixtureFrame {
  return { ts: nextTs(), kind: "done", payload: {} };
}

export function abortedDeclineFrame(): FixtureFrame {
  return { ts: nextTs(), kind: "aborted", payload: { reason: "user_declined" } };
}

export function errorFrame(reason = "workflow_failed"): FixtureFrame {
  return { ts: nextTs(), kind: "error", payload: { reason } };
}

/** A created-run frame sequence: init → awaiting_user → text → done. */
export function createdRunFrames(): FixtureFrame[] {
  return [initFrame(), awaitingUserFrame(), textFrame(), doneFrame()];
}

/** A declined-run frame sequence: init → awaiting_user → aborted{user_declined}. */
export function declinedRunFrames(): FixtureFrame[] {
  return [initFrame(), awaitingUserFrame(), abortedDeclineFrame()];
}

/** A force-override run: init → awaiting_user(collect) → awaiting_user(force_override)
 *  → text → done. The gate frame precedes prose. */
export function forceOverrideRunFrames(): FixtureFrame[] {
  return [
    initFrame(),
    awaitingUserFrame("data_collection", "dc-1", "collect"),
    awaitingUserFrame("force_override", "fo-1", "forceOverrideGate"),
    textFrame(),
    doneFrame(),
  ];
}

/** A #1244 fail-closed run: init → awaiting_user(malformed) → error (no prose-fall). */
export function malformedFailClosedFrames(): FixtureFrame[] {
  return [initFrame(), awaitingUserFrame("malformed_tool_call", "mf-1", "trimVerify"), errorFrame("malformed_tool_call")];
}
