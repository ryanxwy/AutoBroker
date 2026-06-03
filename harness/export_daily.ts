/**
 * harness/export_daily.ts — STUB.
 *
 * Exports the `test_run_records` rows for a given day to a STABLE JSON file,
 * consumed by the plan repo's `tools/new-day.sh` to fill the daily HTML report's
 * "今日 harness 信号" (today's harness signals) section.
 *
 * PROVENANCE (ab_design.json codeRepoStructure "harness/" + dailyTracking;
 *   DECISIONS.md cost ledger). The sync is one-directional: this code repo emits
 *   the JSON; the plan repo reads it. The plan repo never writes back here.
 *
 * Usage (intended):
 *   tsx harness/export_daily.ts 2026-06-02 [--out <path>]
 *
 * Output shape (stable — new-day.sh parses this; keep keys additive):
 *   {
 *     "date": "2026-06-02",                 // YYYY-MM-DD, the run-window bucket
 *     "codeRepoHeadSha": "<short-sha>",     // for the daily metadata block
 *     "runs": [
 *       {
 *         "runId": "...",
 *         "skill": "quote_audit",
 *         "layer": "L2",                    // L1..L5
 *         "provider": "deepseek",           // deepseek (default) | anthropic | openai
 *         "modelAlias": "deepseek-v4-flash",
 *         "anchors": {                      // 6+1; which were GREEN
 *           "run_status": true,
 *           "no_external_mutation": true,   // keystone
 *           "cost_and_time": true
 *           // ...
 *         },
 *         "costUsd": 0.0012,                // null when usage unavailable
 *         "durationMs": 8421,
 *         "pricingSource": "deepseek-2026-06",  // 'unavailable' => costUsd is null, NOT 0
 *         "failReason": null                // set on RED or usage-missing flag
 *       }
 *     ]
 *   }
 *
 * The NULL-not-$0 rule (DECISIONS.md "成本/时间度量") is preserved end-to-end:
 * a run with missing usage exports `costUsd: null` + `pricingSource:
 * "unavailable"` + a `failReason` flag — it is NEVER exported as 0.
 */

// TODO(phase-0): import { openDb } from "@autobroker/db/client";
// TODO(phase-0): import { testRunRecords } from "@autobroker/db/testRunRecords";

export interface DailyHarnessExport {
  date: string; // YYYY-MM-DD
  codeRepoHeadSha: string;
  runs: DailyHarnessRun[];
}

export interface DailyHarnessRun {
  runId: string;
  skill: string;
  layer: "L1" | "L2" | "L3" | "L4" | "L5";
  provider: "deepseek" | "anthropic" | "openai";
  modelAlias: string;
  anchors: Record<string, boolean>;
  costUsd: number | null; // null when usage unavailable — NEVER 0 as a stand-in.
  durationMs: number | null;
  pricingSource: string; // 'unavailable' => costUsd is null.
  failReason: string | null;
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
  //   5. write to --out (default harness/artifacts/<date>.json) deterministically
  //      (stable key order) so the plan repo diff is clean.
  throw new Error("TODO(phase-0): implement export_daily once test_run_records is populated");
}

// TODO(phase-0): CLI entry — parse argv[2] as date, optional --out, call
// exportDaily, write the file. Keep it dependency-light so it runs under tsx.
