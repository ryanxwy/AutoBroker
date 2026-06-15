/**
 * quotes/auditPersist — the idempotent audit-row writer. Raw better-sqlite3 via
 * `db.$client`. Re-running the same pass over the same quote UPDATEs the existing
 * row (the unique index `idx_quote_audits_quote_pass` on
 * (dealer_quote_id, audit_pass_version) is the conflict target) — never a
 * duplicate. `flags` are serialized to `flags_json`.
 */

import type { Db } from "@autobroker/db";
import type { AuditFinding } from "@autobroker/core";

import { DEFAULT_AUDIT_PASS_VERSION } from "./quotesRead.js";

export interface UpsertAuditArgs {
  dealer_quote_id: string;
  search_profile_id: string;
  flags: readonly AuditFinding[];
  /** Pass-version label; re-running the same value UPSERTs (default "v1"). */
  audit_pass_version?: string;
  /** Audit timestamp (caller-supplied; ISO string or epoch). */
  audited_at: string | number;
}

const UPSERT_SQL =
  "INSERT INTO quote_audits " +
  "(dealer_quote_id, search_profile_id, flags_json, audited_at, audit_pass_version) " +
  "VALUES (?, ?, ?, ?, ?) " +
  "ON CONFLICT(dealer_quote_id, audit_pass_version) DO UPDATE SET " +
  "  flags_json = excluded.flags_json, " +
  "  audited_at = excluded.audited_at, " +
  "  search_profile_id = excluded.search_profile_id";

/** Outcome of a single upsert (whether it inserted a new row or updated one). */
export type UpsertAuditOutcome = "inserted" | "updated";

/**
 * Persist one audit pass for a quote, idempotent on
 * (dealer_quote_id, audit_pass_version). Returns whether the row was inserted
 * or updated (probed before the write).
 */
export function upsertAudit(db: Db, args: UpsertAuditArgs): UpsertAuditOutcome {
  const passVersion = args.audit_pass_version ?? DEFAULT_AUDIT_PASS_VERSION;
  const existing = db.$client
    .prepare("SELECT audit_id FROM quote_audits WHERE dealer_quote_id = ? AND audit_pass_version = ?")
    .get(args.dealer_quote_id, passVersion);
  const flagsJson = JSON.stringify(args.flags);
  db.$client
    .prepare(UPSERT_SQL)
    .run(args.dealer_quote_id, args.search_profile_id, flagsJson, args.audited_at, passVersion);
  return existing === undefined ? "inserted" : "updated";
}
