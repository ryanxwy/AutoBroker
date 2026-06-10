/**
 * harness/export_daily.ts — the daily harness-signal export.
 *
 * Exports the day's `test_run_records` rows to a STABLE JSON file, consumed by
 * an external daily-report generator that reads harness/exports/<date>.json to
 * fill its "today's harness signals" section.
 *
 * Aggregation scope: live-harness runs each write to an ISOLATED per-run DB
 * (~/.autobroker-ts/harness-runs/<date>T…/autobroker.db), so the export unions
 * the default DB's window rows with every matching run dir's rows (read-only;
 * each ledger row lives in exactly one DB). It ALSO folds each run dir's
 * per-cell evidence verdict.json into an additive `cases` key — required
 * because a declined live run fires no model call and leaves ZERO ledger rows;
 * its outcome exists only as a case verdict.
 *
 * The sync is one-directional: this repo emits the JSON; the external reporting
 * tool reads it and never writes back here.
 *
 * Usage:
 *   tsx harness/export_daily.ts 2026-06-02 [--out <path>]
 *
 * Output path + key contract (LOCKED to the external reporting tool's parser —
 * default out is harness/exports/<date>.json, the first path it probes, and the
 * run keys are snake_case exactly as it reads them; keep keys additive):
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
 *         "anchors": {                       // COARSE row-derivable signals ONLY:
 *           "cost_and_time": true,           //   from the ledger row itself
 *           "no_external_mutation": true     //   runtime-enforcement flag, NOT the
 *         },                                 //   per-run verdict — authoritative
 *                                            //   per-anchor booleans live in the
 *                                            //   run's verdict.json (see "cases")
 *         "cost_usd": 0.0012,                // null when usage unavailable
 *         "duration_ms": 8421,
 *         "pricing_source": "deepseek-2026-06",  // 'unavailable' => cost_usd is null, NOT 0
 *         "fail_reason": null                // set on RED or usage-missing flag
 *       }
 *     ]
 *   }
 *
 * The NULL-not-$0 cost-metering rule is preserved end-to-end: when usage is
 * missing the cost is null, never $0 — a run with missing usage exports
 * `cost_usd: null` + `pricing_source:
 * "unavailable"` + a `fail_reason` flag — it is NEVER exported as 0.
 */

// READ-ONLY DB channel: the harness reads test_run_records through dbReads (which
// opens an @autobroker/db handle and runs SELECTs only — the wall-legal read path).
// The harness NEVER writes the DB; the SUT's writeTestRunRecord owns every row.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { openReadHandle, openReadHandleAt, readLedgerRowsInWindow, type LedgerRow } from "./dbReads.js";

/** Keys are snake_case ON PURPOSE — they are the wire format the external
 *  reporting tool parses (r.get("model_alias"), r.get("cost_usd"), …). Do not camelCase. */
export interface DailyHarnessExport {
  date: string; // YYYY-MM-DD
  code_repo_head_sha: string;
  runs: DailyHarnessRun[];
  /** Case-level verdicts folded from each run dir's per-cell verdict.json.
   *  ADDITIVE key (the reporting tool reads `runs`; older exports lack this).
   *  Needed because a declined run writes zero ledger rows. */
  cases: DailyHarnessCase[];
}

export interface DailyHarnessCase {
  cell_id: string;
  /** The case TOML [meta].id. Newer verdicts carry it inline; for older ones
   *  it is recovered from the sibling narrative.json ("" if neither has it).
   *  Distinguishes cases sharing one cell_id (decline vs force_override). */
  case_id: string;
  run_id: string;
  layer: string;
  /** The driver lane ("ui" | "api"). Older verdicts lack the key → "api". */
  lane: string;
  verdict: string; // GREEN | GREEN_WITH_WAIVER | RED | BLOCKER
  status: string; // PASS | FAIL
  run_dir: string; // the harness-runs/<ts> dir name the verdict came from
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

/** The isolated per-run roots the live harness writes (runner.ts runRoot).
 *  Exported as the default for exportDaily's runsRoot param; tests pass an
 *  isolated dir so machine state never leaks into unit assertions. */
export function defaultHarnessRunsRoot(): string {
  return join(homedir(), ".autobroker-ts", "harness-runs");
}

/** The day's isolated run dirs (names start with `<date>T`). */
function runDirsFor(date: string, runsRoot: string): string[] {
  if (!existsSync(runsRoot)) return [];
  return readdirSync(runsRoot)
    .filter((d) => d.startsWith(`${date}T`))
    .sort()
    .map((d) => join(runsRoot, d));
}

/** Recover the case id for an old verdict (written before verdict.json carried
 *  case_id) from the sibling narrative.json's "case" field; "" if absent. */
function narrativeCaseId(cellDir: string): string {
  const nPath = join(cellDir, "narrative.json");
  if (!existsSync(nPath)) return "";
  try {
    const n = JSON.parse(readFileSync(nPath, "utf8")) as Record<string, unknown>;
    return typeof n["case"] === "string" ? n["case"] : "";
  } catch {
    return "";
  }
}

/** Fold every evidence/<cell>/verdict.json under the day's run dirs into the
 *  additive case list. A malformed/unreadable verdict file is skipped loudly. */
function readCases(date: string, runsRoot: string): DailyHarnessCase[] {
  const cases: DailyHarnessCase[] = [];
  for (const runDir of runDirsFor(date, runsRoot)) {
    const evidence = join(runDir, "evidence");
    if (!existsSync(evidence)) continue;
    for (const cell of readdirSync(evidence).sort()) {
      const vPath = join(evidence, cell, "verdict.json");
      if (!existsSync(vPath)) continue;
      try {
        const v = JSON.parse(readFileSync(vPath, "utf8")) as Record<string, unknown>;
        cases.push({
          cell_id: String(v["cell_id"] ?? cell),
          case_id: String(v["case_id"] ?? narrativeCaseId(join(evidence, cell))),
          run_id: String(v["run_id"] ?? ""),
          layer: String(v["layer"] ?? ""),
          lane: String(v["lane"] ?? "api"),
          verdict: String(v["verdict"] ?? ""),
          status: String(v["status"] ?? ""),
          run_dir: runDir.slice(runsRoot.length + 1),
        });
      } catch (err) {
        console.warn(`export_daily: skipping unreadable verdict ${vPath}: ${String(err)}`);
      }
    }
  }
  return cases;
}

/**
 * Read every test_run_records row whose created_at falls on `date` and emit the
 * stable JSON shape above. READ-ONLY: opens @autobroker/db read handles through
 * dbReads (the default DB + each isolated run dir's DB), runs windowed SELECTs,
 * never writes any DB. Each ledger row lives in exactly one DB; the default-DB
 * file is realpath-deduped against the run DBs in case AUTOBROKER_DB points at one.
 */
export function exportDaily(date: string, runsRoot: string = defaultHarnessRunsRoot()): DailyHarnessExport {
  const { from, to } = windowFor(date);
  const rows: LedgerRow[] = [];
  const seenFiles = new Set<string>();

  const def = openReadHandle();
  try {
    seenFiles.add(realpathSync((def.db.$client as { name: string }).name));
    rows.push(...readLedgerRowsInWindow(def.db, from, to));
  } finally {
    def.close();
  }

  for (const runDir of runDirsFor(date, runsRoot)) {
    const dbPath = join(runDir, "autobroker.db");
    if (!existsSync(dbPath)) continue;
    const real = realpathSync(dbPath);
    if (seenFiles.has(real)) continue;
    seenFiles.add(real);
    const h = openReadHandleAt(dbPath);
    try {
      rows.push(...readLedgerRowsInWindow(h.db, from, to));
    } finally {
      h.close();
    }
  }

  // Stable order: created_at then run_id (re-sort for determinism across DBs).
  rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  return {
    date,
    code_repo_head_sha: codeRepoHeadSha(),
    runs: rows.map(toDailyRun),
    cases: readCases(date, runsRoot),
  };
}

/** Serialize with a STABLE key order (the locked snake_case shape) so the plan-repo
 *  diff stays clean. JSON.stringify preserves insertion order, and toDailyRun emits
 *  keys in the documented order. */
export function serializeExport(doc: DailyHarnessExport): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

/** Default out path = harness/exports/<date>.json (the first path the reporting tool probes). */
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
