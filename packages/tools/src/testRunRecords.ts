/**
 * test_run_records writer — the ONE write path for the cost/time + harness-result
 * ledger. THIS IS THE ONLY PLACE A LEDGER ROW IS BORN.
 *
 * SQLITE INVARIANT (CLAUDE.md "The SQLite / external-API invariant"):
 *   Only packages/tools (and packages/db beneath it) may touch the product DB.
 *   Routes, CLI, workflows, and model code MUST delegate down into this writer —
 *   they never open the product DB connection themselves. The evaluator's
 *   "every call writes a row" rule (AI_ORCH §3.3 stage 6) funnels through here.
 *
 * NULL-not-$0 DISCIPLINE (HARNESS_FRAMEWORK "NULL-not-$0"; BACKEND_SERVICES §14
 *   M0 ledger writer; AI_ORCH §3.3 stage 6 usage→cost):
 *   Cost is the APPLICATION's own job: usage tokens × a self-managed pricing
 *   table → USD (AI SDK #3932 is wontfix — the SDK will not compute cost). When
 *   usage is unavailable the row is recorded as cost_usd = SQL NULL +
 *   pricing_source = 'unavailable' — it is NEVER silently rounded to $0. A $0
 *   row that round-trips as 0.0 is indistinguishable from a "genuinely free"
 *   call and is exactly the silent-$0 trend-faking bug this contract bans.
 *
 *   This writer therefore:
 *     - passes `costUsd: null` straight through to SQL NULL (no null→0 coercion);
 *     - fails LOUD if a caller tries to write the forbidden combination
 *       cost_usd = 0 AND pricing_source = 'unavailable' (a concrete $0 with the
 *       very flag that means "we had no usage" — the silent-$0 bug incarnate).
 *
 * Dependency wall: imports @autobroker/db (openDb + the hand-authored
 * testRunRecords table) only. core/model/workflows never reach this layer.
 */

import { openDb, testRunRecords, type Db } from "@autobroker/db";

/**
 * Insert shape for one ledger row: the table's drizzle `$inferInsert` minus the
 * DB-defaulted `id` (integer PRIMARY KEY AUTOINCREMENT — assigned by SQLite, a
 * caller must never supply it). Every other column is caller-provided; the
 * NULLable cost/time/token/price columns accept explicit `null`.
 */
export type TestRunRecordInsert = Omit<typeof testRunRecords.$inferInsert, "id">;

/** Thrown when a caller asks to persist the banned silent-$0 combination. */
export class SilentZeroCostError extends Error {
  constructor() {
    super(
      "Refusing to write cost_usd = 0 with pricing_source = 'unavailable' — " +
        "the NULL-not-$0 contract requires cost_usd = NULL when usage is " +
        "unavailable, never a $0 row that fakes a free call.",
    );
    this.name = "SilentZeroCostError";
  }
}

/**
 * Write exactly one test_run_records row and return its DB-assigned `id`.
 *
 * Fail-LOUD guard (NULL-not-$0): a row with costUsd === 0 AND
 * pricingSource === 'unavailable' is rejected before any DB write. Genuine
 * "no usage" rows must pass costUsd: null (which round-trips as SQL NULL).
 *
 * @param record   the 16 caller-owned columns (id is DB-assigned).
 * @param db       optional pre-opened connection (the app singleton / a test's
 *                 isolated DB); defaults to opening the resolved product DB.
 *                 Callers MUST NOT open their own connection — pass one obtained
 *                 from this layer's openDb, or let the default resolve it.
 * @returns the autoincrement `id` of the inserted row.
 */
export function writeTestRunRecord(
  record: TestRunRecordInsert,
  db: Db = openDb(),
): number {
  // Fail-CLOSED on the silent-$0 combination. A NULL cost is the only honest
  // way to record "usage unavailable"; a concrete 0.0 here is the banned bug.
  if (record.costUsd === 0 && record.pricingSource === "unavailable") {
    throw new SilentZeroCostError();
  }

  // Single INSERT … RETURNING id. better-sqlite3 is the synchronous dialect, so
  // `.get()` returns the row directly (no Promise). null in `record` is passed
  // straight to SQL NULL — drizzle never coerces it to 0.
  const inserted = db
    .insert(testRunRecords)
    .values(record)
    .returning({ id: testRunRecords.id })
    .get();

  return inserted.id;
}
