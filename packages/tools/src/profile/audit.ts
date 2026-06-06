/**
 * audit_log writer. The audit write is a tools-layer responsibility, performed
 * in the SAME synchronous transaction as the profile write so the audit log can
 * never lag the row it records.
 *
 * ACTION VOCABULARY (frozen) — the only actions intake emits today:
 *   - 'search_profile_intake'      — persist step wrote a profile (payload =
 *                                     full intake input JSON).
 *   - 'intake_verification_forced' — user force-overrode an invalid trim.
 * Other actions (intake_verification_passed/failed, profile_replace) are
 * declared in the vocabulary const for downstream steps but not all emitted here.
 *
 * audit_id = uuid (crypto.randomUUID); `at` defaults to the server's
 * CURRENT_TIMESTAMP (the column default — we do NOT bind it). Raw better-sqlite3
 * INSERT (no drizzle-orm import — sqlite-only-in-db rule).
 */

import { randomUUID } from "node:crypto";
import type { Db } from "@autobroker/db";

/** The intake-related audit_log action vocabulary. Frozen. */
export const AUDIT_ACTIONS = {
  searchProfileIntake: "search_profile_intake",
  intakeVerificationPassed: "intake_verification_passed",
  intakeVerificationFailed: "intake_verification_failed",
  intakeVerificationForced: "intake_verification_forced",
  profileReplace: "profile_replace",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** One audit_log row (the columns a caller supplies; audit_id + at are owned
 *  here / by the DB default). */
export interface AuditEntry {
  action: AuditAction;
  actor?: string | null;
  targetTable?: string | null;
  targetId?: string | null;
  searchProfileId?: string | null;
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  reason?: string | null;
  payloadJson?: string | null;
}

const INSERT_AUDIT =
  "INSERT INTO audit_log " +
  "(audit_id, actor, action, target_table, target_id, search_profile_id, " +
  " field, old_value, new_value, reason, payload_json) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/**
 * Write exactly one audit_log row and return its audit_id. The caller passes the
 * SAME `db` used for the profile write so both land in one transaction when
 * wrapped by `db.$client.transaction(...)`. `at` is left to the column default
 * (CURRENT_TIMESTAMP).
 */
export function writeAuditLog(db: Db, entry: AuditEntry): string {
  const auditId = randomUUID();
  db.$client
    .prepare(INSERT_AUDIT)
    .run(
      auditId,
      entry.actor ?? null,
      entry.action,
      entry.targetTable ?? null,
      entry.targetId ?? null,
      entry.searchProfileId ?? null,
      entry.field ?? null,
      entry.oldValue ?? null,
      entry.newValue ?? null,
      entry.reason ?? null,
      entry.payloadJson ?? null,
    );
  return auditId;
}
