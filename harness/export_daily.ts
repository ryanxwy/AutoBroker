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

// TODO(phase-0): import { openDb } from "@autobroker/db/client";
// TODO(phase-0): import { testRunRecords } from "@autobroker/db/testRunRecords";

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

/**
 * Read every test_run_records row whose created_at falls on `date` and emit the
 * stable JSON shape above.
 */
export function exportDaily(_date: string): DailyHarnessExport {
  // TODO(phase-0):
  //   1. resolve the run window [date 00:00, date 23:59] in local time;
  //   2. SELECT from test_run_records where created_at in window;
  //   3. map rows -> DailyHarnessRun, preserving NULL cost (never coerce to 0);
  //   4. attach the code-repo HEAD short SHA;
  //   5. write to --out (default harness/exports/<date>.json — the first path
  //      new-day.sh probes) deterministically (stable key order) so the plan
  //      repo diff is clean.
  throw new Error("TODO(phase-0): implement export_daily once test_run_records is populated");
}

// TODO(phase-0): CLI entry — parse argv[2] as date, optional --out, call
// exportDaily, write the file. Keep it dependency-light so it runs under tsx.
