/**
 * auditLogWriter — the one-row-per-run pipeline completion record. The audit_log
 * table is GENERIC (no pipeline_run_id / completed_steps / final_state /
 * next_action columns), so the structured completion body is serialized into
 * `payload_json`; the read side parses it back. No new column, no migration.
 *
 *   audit_id     = a fresh uuid
 *   action       = "quote_pipeline.complete"
 *   target_table = "audit_log" (the record is about itself — there is no
 *                  dedicated pipeline-run table)
 *   search_profile_id = the profile the run acted on
 *   payload_json = { pipeline_run_id, completed_steps[], final_state, next_action }
 *   at           = left to the column default (CURRENT_TIMESTAMP)
 *
 * Deterministic apart from the uuid + the DB-default timestamp. Raw
 * better-sqlite3 via db.$client (no drizzle-orm).
 */

import { randomUUID } from "node:crypto";
import type { Db } from "@autobroker/db";

import type { FinalState, PipelineStep } from "./finalState.js";

/** The action string for the pipeline completion row — the queryable discriminator
 *  the read side filters audit_log on to find quote_pipeline completions. */
export const PIPELINE_COMPLETE_ACTION = "quote_pipeline.complete" as const;

export interface WritePipelineCompletionArgs {
  searchProfileId: string;
  pipelineRunId: string;
  completedSteps: readonly PipelineStep[];
  finalState: FinalState;
  nextAction: string;
  /** Unused for the row value (`at` uses the column default) — accepted so the
   *  caller's clock seam stays explicit and the signature is stable. */
  nowMs?: number;
  db?: Db;
}

export interface WritePipelineCompletionResult {
  auditId: string;
}

const INSERT_AUDIT = `
INSERT INTO audit_log
  (audit_id, action, target_table, search_profile_id, payload_json)
VALUES (?, ?, ?, ?, ?)
`;

/**
 * Append exactly one audit_log completion row and return its audit_id. The
 * completion body (run id, completed steps, final state, next action) is
 * serialized into payload_json.
 */
export function writePipelineCompletion(
  args: WritePipelineCompletionArgs,
): WritePipelineCompletionResult {
  const db = args.db;
  if (db === undefined) {
    throw new Error("writePipelineCompletion: a db handle is required");
  }
  const auditId = randomUUID();
  const payload = JSON.stringify({
    pipeline_run_id: args.pipelineRunId,
    completed_steps: [...args.completedSteps],
    final_state: args.finalState,
    next_action: args.nextAction,
  });
  db.$client
    .prepare(INSERT_AUDIT)
    .run(auditId, PIPELINE_COMPLETE_ACTION, "audit_log", args.searchProfileId, payload);
  return { auditId };
}
