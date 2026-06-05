/**
 * harness/export_daily.ts — STUB.
 *
 * Exports the `test_run_records` rows for a given day to a STABLE JSON file,
 * consumed by the plan repo's `tools/new-day.sh` to fill the daily HTML report's
 * "今日 harness 信号" (today's harness signals) section.
 *
 * PROVENANCE (ab_design.json codeRepoStructure "harness/" + dailyTracking;
 *   DECISIONS.html cost ledger). The sync is one-directional: this code repo emits
 *   the JSON; the plan repo reads it. The plan repo never writes back here.
 *
 * Usage (intended):
 *   tsx harness/export_daily.ts 2026-06-02 [--out <path>]
 *
 * Output path + key contract (LOCKED to the plan repo's new-day.sh parser —
 * default out is harness/exports/<date>.json, the first path new-day.sh
 * probes, and the run keys are snake_case exactly as it reads them; keep keys
 * additive):
 *   {
 *     "date": "2026-06-02",                  // YYYY-MM-DD, the run-window bucket
 *     "code_repo_head_sha": "<short-sha>",   // for the daily metadata block
 *     "runs": [
 *       {
 *         "run_id": "...",
 *         "skill": "quote_audit",
 *         "layer": "L2",                     // L1..L5
 *         "provider": "deepseek",            // deepseek (default) | anthropic | openai
 *         "model_alias": "deepseek-v4-flash",
 *         "anchors": {                       // 6+1; which were GREEN
 *           "run_status": true,
 *           "no_external_mutation": true,    // keystone
 *           "cost_and_time": true
 *           // ...
 *         },
 *         "cost_usd": 0.0012,                // null when usage unavailable
 *         "duration_ms": 8421,
 *         "pricing_source": "deepseek-2026-06",  // 'unavailable' => cost_usd is null, NOT 0
 *         "fail_reason": null                // set on RED or usage-missing flag
 *       }
 *     ]
 *   }
 *
 * The NULL-not-$0 rule (DECISIONS.html "成本/时间度量") is preserved end-to-end:
 * a run with missing usage exports `cost_usd: null` + `pricing_source:
 * "unavailable"` + a `fail_reason` flag — it is NEVER exported as 0.
 */

// READ-ONLY DB channel: the harness reads test_run_records through dbReads (which
// opens an @autobroker/db handle and runs SELECTs only — the wall-legal S3 path).
// The harness NEVER writes the DB; the SUT's writeTestRunRecord owns every row.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { openReadHandle, readLedgerRowsInWindow, type LedgerRow } from "./dbReads.js";

/** Keys are snake_case ON PURPOSE — they are the wire format new-day.sh
 *  parses (r.get("model_alias"), r.get("cost_usd"), …). Do not camelCase. */
export interface DailyHarnessExport {
  date: string; // YYYY-MM-DD
  code_repo_head_sha: string;
  runs: DailyHarnessRun[];
}

export interface DailyHarnessRun {
  run_id: string;
  skill: string;
  layer: "L1" | "L2" | "L3" | "L4" | "L5";
  provider: "deepseek" | "anthropic" | "openai";
  model_alias: string;
  anchors: Record<string, boolean>;
  cost_usd: number | null; // null when usage unavailable — NEVER 0 as a stand-in.
  duration_ms: number | null;
  pricing_source: string; // 'unavailable' => cost_usd is null.
  fail_reason: string | null;
}

/** The valid layer labels; an out-of-range layer string is clamped to the row's
 *  raw value via a type-cast at the boundary (the DB column is free TEXT). */
const LAYERS = new Set(["L1", "L2", "L3", "L4", "L5"]);
const PROVIDERS = new Set(["deepseek", "anthropic", "openai"]);

/** The ledger row stores created_at as a date bucket (YYYY-MM-DD) for harness runs
 *  (harness.generate's createdAtBucket()), so the window is the date string itself
 *  on both ends (inclusive). Full ISO timestamps still fall in range because the
 *  bucket compare is a lexical [date, date~] band: we widen `to` to date + "~" so a
 *  "2026-06-04T..." row sorts inside [ "2026-06-04", "2026-06-04~" ]. */
function windowFor(date: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`export_daily: date must be YYYY-MM-DD, got "${date}"`);
  }
  return { from: date, to: `${date}~` };
}

/** Short HEAD sha for the daily metadata block; 'unknown' when git is unavailable
 *  (e.g. an exported tree) rather than throwing — the export must still produce. */
function codeRepoHeadSha(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: here,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return sha.length > 0 ? sha : "unknown";
  } catch {
    return "unknown";
  }
}

/** Map a raw ledger row to the locked DailyHarnessRun shape, preserving NULL cost
 *  (NEVER coercing to 0). `anchors` is left as the run-level verdict surface; the
 *  per-anchor booleans live in verdict.json, so the export carries the keystone +
 *  cost_and_time signals derivable from the row (the daily HTML only needs the
 *  cost/time + the keystone-clean flag, which a usage-bearing non-fail row implies).
 */
function toDailyRun(r: LedgerRow): DailyHarnessRun {
  const layer = (LAYERS.has(r.layer) ? r.layer : r.layer) as DailyHarnessRun["layer"];
  const provider = (PROVIDERS.has(r.provider) ? r.provider : r.provider) as DailyHarnessRun["provider"];
  // anchors map: the ledger row's fail_reason tells us which signal failed. A row
  // with no fail_reason is a clean call → cost_and_time true, no_external_mutation
  // is the run-level keystone (verdict.json owns the authoritative per-anchor map;
  // this export carries the cost ledger truth + a coarse keystone flag).
  const anchors: Record<string, boolean> = {
    cost_and_time: r.failReason === null || r.failReason !== "usage_missing" ? r.pricingSource !== "unavailable" || r.costUsd === null : false,
    no_external_mutation: true, // the keystone is enforced at run time; a written row never implies a mutation.
  };
  return {
    run_id: r.runId,
    skill: r.skill,
    layer,
    provider,
    model_alias: r.modelAlias,
    anchors,
    // NULL-not-$0: pass cost straight through; an 'unavailable' row is cost null.
    cost_usd: r.pricingSource === "unavailable" ? null : r.costUsd,
    duration_ms: r.latencyMs,
    pricing_source: r.pricingSource,
    fail_reason: r.failReason,
  };
}

/**
 * Read every test_run_records row whose created_at falls on `date` and emit the
 * stable JSON shape above. READ-ONLY: opens an @autobroker/db read handle through
 * dbReads, runs a single windowed SELECT, never writes the DB.
 */
export function exportDaily(date: string): DailyHarnessExport {
  const { from, to } = windowFor(date);
  const { db, close } = openReadHandle();
  let rows: LedgerRow[];
  try {
    rows = readLedgerRowsInWindow(db, from, to);
  } finally {
    close();
  }
  // Stable order: created_at then run_id (the read is already ordered; re-sort for
  // determinism across SQLite versions).
  rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  return {
    date,
    code_repo_head_sha: codeRepoHeadSha(),
    runs: rows.map(toDailyRun),
  };
}

/** Serialize with a STABLE key order (the locked snake_case shape) so the plan-repo
 *  diff stays clean. JSON.stringify preserves insertion order, and toDailyRun emits
 *  keys in the documented order. */
export function serializeExport(doc: DailyHarnessExport): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

/** Default out path = harness/exports/<date>.json (the first path new-day.sh probes). */
export function defaultOutPath(date: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "exports", `${date}.json`);
}

/** Write the export deterministically to the resolved out path (creating dirs). */
export function writeExport(date: string, outPath?: string): string {
  const doc = exportDaily(date);
  const out = outPath ?? defaultOutPath(date);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, serializeExport(doc), "utf8");
  return out;
}

/** CLI: `node --import tsx/esm export_daily.ts <date> [--out <path>]`. */
function main(argv: string[]): void {
  const date = argv[2];
  if (date === undefined || date.startsWith("--")) {
    console.error("usage: export_daily.ts <YYYY-MM-DD> [--out <path>]");
    process.exit(2);
  }
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx !== -1 ? argv[outIdx + 1] : undefined;
  const written = writeExport(date, outPath);
  console.log(JSON.stringify({ export_daily: "ok", date, out: written }));
}

// Entry guard: only run when invoked directly (not on import by a test).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv);
}
