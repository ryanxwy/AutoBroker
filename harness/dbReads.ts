/**
 * dbReads — the harness's ONLY DB touch, and it is STRICTLY READ-ONLY (the
 * ground-truth channel). The trust-boundary rule: the harness's only way to CHANGE
 * the DB is through the SUT's HTTP, letting product code do the write; the harness
 * itself only reads. So this
 * module opens an @autobroker/db connection and runs SELECTs ONLY — never an
 * INSERT/UPDATE/DELETE. The ledger ROW for each LLM call is WRITTEN by the SUT
 * (packages/tools writeTestRunRecord, called from harness.generate); the harness
 * only READS those rows here for the cost_and_time anchor + export_daily.
 *
 * WHY this is wall-legal: dependency-cruiser forbids harness from importing
 * better-sqlite3/drizzle-orm DIRECTLY. We import @autobroker/db (allowed — the db
 * package owns those drivers); we call openDb() and use the returned handle's
 * read API. No raw-driver import edge is created from harness/. (The dependency
 * edge harness→@autobroker/db is permitted; the forbidden edges are
 * harness→better-sqlite3 / harness→drizzle-orm, which we never create.)
 *
 * READ ASSERTION: every statement here is a SELECT. A debug guard rejects any
 * non-SELECT SQL before it runs, so a future edit cannot smuggle a write through
 * this module.
 *
 * Dependency wall: harness layer. Imports @autobroker/db (openDb only) — the one
 * permitted DB channel; NEVER better-sqlite3/drizzle-orm directly.
 */

import { openDb, type Db } from "@autobroker/db";

/** The product tables the anchors snapshot/scan. profile_dealers is the
 *  dealer_geosearch write target (PK (search_profile_id, dealer_id) — the
 *  search_profile_id column scopes it like the others);
 *  dealer_inventory_sources + inventory_listings are the inventory_site_scan
 *  write targets (both carry a NOT NULL search_profile_id);
 *  manufacturer_incentives is the incentive_scrape write target — it carries
 *  NO search_profile_id (keyed (make, model, zip)), so its "profile scope" is
 *  the join through the profile's own make/model/postal_code slice. */
export const SNAPSHOT_TABLES = [
  "search_profiles",
  "audit_log",
  "lead_submissions",
  "profile_dealers",
  "dealer_inventory_sources",
  "inventory_listings",
  "manufacturer_incentives",
  // messages carries a nullable search_profile_id; the dealer_web_lead_submit
  // keystone asserts a profile-scoped messages delta (an email-fallback send
  // writes a row; under BLOCK=1 the send is fuse-blocked → Δ=0) — without it the
  // table_min_rows(messages) anchor would read a vacuous 0.
  "messages",
] as const;
export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];

/** Profile-scoped + global counts captured at step boundaries (before/after). */
export interface TableCounts {
  /** Profile-scoped: rows whose search_profile_id = the run's profile (or, for
   *  search_profiles, the row whose PK = the profile id). null profileId → 0. */
  profile: Record<string, number>;
  /** Global counts (fallback only; profile-scoped is the rule). */
  global: Record<string, number>;
}

/** One test_run_records row as the harness reads it (snake_case wire of the DB). */
export interface LedgerRow {
  runId: string;
  skill: string;
  createdAt: string;
  layer: string;
  provider: string;
  modelAlias: string;
  costUsd: number | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  pricingSource: string;
  priceInputPerMtok: number | null;
  priceOutputPerMtok: number | null;
  promptVersion: string | null;
  schemaVersion: string | null;
  failReason: string | null;
}

/** Fail-closed: refuse any non-SELECT SQL through this read-only module. */
function assertReadOnly(sql: string): void {
  const head = sql.trimStart().slice(0, 12).toUpperCase();
  if (!head.startsWith("SELECT")) {
    throw new Error(`dbReads is READ-ONLY — refusing non-SELECT SQL: "${sql.slice(0, 40)}…"`);
  }
}

/** Run a guarded read query through the db handle's raw client (.prepare().all()). */
function readAll<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): T[] {
  assertReadOnly(sql);
  return db.$client.prepare(sql).all(...params) as T[];
}

function readOne<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): T | undefined {
  assertReadOnly(sql);
  return db.$client.prepare(sql).get(...params) as T | undefined;
}

/** Count rows in a table whose search_profile_id matches (profile scope). For
 *  search_profiles the "profile-scoped" count is the existence of the row whose
 *  PK = profileId (0 or 1). manufacturer_incentives has NO profile column —
 *  its scope is the profile's OWN (make, model, postal_code) slice, joined
 *  through search_profiles. null profileId → 0 (nothing scoped yet). */
function profileScopedCount(db: Db, table: SnapshotTable, profileId: string | null): number {
  if (profileId === null) return 0;
  if (table === "manufacturer_incentives") {
    const row = readOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM manufacturer_incentives mi
        JOIN search_profiles sp ON sp.search_profile_id = ?
       WHERE LOWER(mi.make) = LOWER(sp.make)
         AND LOWER(mi.model) = LOWER(sp.model)
         AND mi.zip = sp.postal_code`,
      [profileId],
    );
    return row?.n ?? 0;
  }
  const sql =
    table === "search_profiles"
      ? `SELECT COUNT(*) AS n FROM search_profiles WHERE search_profile_id = ?`
      : `SELECT COUNT(*) AS n FROM ${table} WHERE search_profile_id = ?`;
  const row = readOne<{ n: number }>(db, sql, [profileId]);
  return row?.n ?? 0;
}

/** Global row count (fallback metric). */
function globalCount(db: Db, table: SnapshotTable): number {
  const row = readOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table}`, []);
  return row?.n ?? 0;
}

/**
 * Snapshot the profile-scoped + global counts for every snapshot table. Called
 * once before the run (profileId null → all profile-scoped 0) and once after
 * (profileId = the newly created id). When no handle is passed it opens (and
 * closes) its own short-lived read handle; when a handle is passed the caller owns
 * its lifetime.
 */
export function snapshotCounts(profileId: string | null, db?: Db): TableCounts {
  const ownHandle = db === undefined;
  const handle = db ?? openDb();
  try {
    const profile: Record<string, number> = {};
    const global: Record<string, number> = {};
    for (const table of SNAPSHOT_TABLES) {
      profile[table] = profileScopedCount(handle, table, profileId);
      global[table] = globalCount(handle, table);
    }
    return { profile, global };
  } finally {
    if (ownHandle) handle.$client.close();
  }
}

/** Count audit_log rows for a given action, optionally profile-scoped. Used by the
 *  table_min_rows(audit_log) anchor and the force-override forced-audit check. */
export function countAuditRows(
  db: Db,
  opts: { action?: string; profileId?: string | null },
): number {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.action !== undefined) {
    clauses.push("action = ?");
    params.push(opts.action);
  }
  if (opts.profileId !== undefined && opts.profileId !== null) {
    clauses.push("search_profile_id = ?");
    params.push(opts.profileId);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const row = readOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM audit_log${where}`, params);
  return row?.n ?? 0;
}

/**
 * The no_external_mutation KEYSTONE DB scan. Counts the rows that would
 * indicate a real outbound side effect — tolerance is ZERO. Two DB signals (the
 * event signal is scanned in the evaluator off RunDetail):
 *   - lead_submissions with outcome='submitted'  (a real submitted lead)
 *   - audit_log with a send/submit-shaped action (a real send/submit event)
 *   - messages with a real (non-sandbox) gmail_message_id, when the table exists
 * created_at windowing is approximate (the ledger uses ISO timestamps); for intake
 * (which never produces ANY of these) a global count of 0 is the honest assertion.
 */
const SEND_SUBMIT_ACTIONS = new Set([
  "gmail_send",
  "dealer_web_lead_submit",
  "lead_submit",
  "send",
  "submit",
  "dealer_closeout_email",
  "negotiation_followup",
]);

export function externalMutationDbCount(
  db: Db,
  opts: { allowFakeOutbound?: boolean } = {},
): { total: number; breakdown: Record<string, number> } {
  const breakdown: Record<string, number> = {};

  // (1) submitted leads. Under the harness lane the L1 fuse (BLOCK=1) makes a
  // real dealer-form POST / Gmail send physically impossible, so a
  // lead_submissions row with outcome='submitted' is the FAKE-submit LOCAL
  // record (invariant #1: fake-submit = a lead_submissions row + NO real POST is
  // LEGAL — recordSubmission is a local write, not fuse-gated). When the step
  // explicitly opted into allowFakeOutbound (the X1 approve/email-fallback
  // keystone), these fake-submit rows are EXPECTED and do NOT count as an
  // external mutation. Real-escape detection stays intact regardless: a real
  // send still surfaces through (2) audit_log.send_submit and (3) the non-sandbox
  // messages scan below — neither is relaxed by the flag.
  const submitted = opts.allowFakeOutbound
    ? 0
    : (readOne<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM lead_submissions WHERE outcome = 'submitted'`,
        [],
      )?.n ?? 0);
  breakdown["lead_submissions.submitted"] = submitted;

  // (2) send/submit-shaped audit actions. Pull distinct actions and filter in JS
  // so the set stays the single source of truth (no giant IN list to drift).
  const actions = readAll<{ action: string; n: number }>(
    db,
    `SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action`,
    [],
  );
  let auditSendSubmit = 0;
  for (const row of actions) {
    if (SEND_SUBMIT_ACTIONS.has(row.action)) auditSendSubmit += row.n;
  }
  breakdown["audit_log.send_submit"] = auditSendSubmit;

  // (3) real (non-sandbox) outbound messages, if the messages table is populated.
  // A real send carries a gmail_message_id NOT shaped like the sandbox 'sandbox-out-%'.
  let realOutbound = 0;
  try {
    const msgs = readOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM messages WHERE gmail_message_id IS NOT NULL AND gmail_message_id NOT LIKE 'sandbox-out-%'`,
      [],
    );
    realOutbound = msgs?.n ?? 0;
  } catch {
    // messages table absent/empty at intake time — nothing outbound, count 0.
    realOutbound = 0;
  }
  breakdown["messages.real_outbound"] = realOutbound;

  const total = submitted + auditSendSubmit + realOutbound;
  return { total, breakdown };
}

/** Read every test_run_records row for a runId (the cost_and_time ledger rows the
 *  SUT wrote, one per harness.generate call). Read-only. */
export function readLedgerRowsForRun(db: Db, runId: string): LedgerRow[] {
  const rows = readAll<Record<string, unknown>>(
    db,
    `SELECT run_id, skill, created_at, layer, provider, model_alias, cost_usd, latency_ms,
            input_tokens, output_tokens, pricing_source, price_input_per_mtok,
            price_output_per_mtok, prompt_version, schema_version, fail_reason
       FROM test_run_records WHERE run_id = ? ORDER BY id ASC`,
    [runId],
  );
  return rows.map(mapLedgerRow);
}

/** Read every test_run_records row whose created_at falls in [from, to] (inclusive
 *  string compare on ISO/date buckets) — the export_daily window read. Read-only.
 *  Tolerates a missing test_run_records table (a brand-new data dir on a no-runs
 *  day) by returning [] — the daily export must still produce an empty file rather
 *  than crash the mechanical sync. A missing table during a LIVE run is a different
 *  matter (readLedgerRowsForRun stays strict). */
export function readLedgerRowsInWindow(db: Db, from: string, to: string): LedgerRow[] {
  let rows: Record<string, unknown>[];
  try {
    rows = readAll<Record<string, unknown>>(
      db,
      `SELECT run_id, skill, created_at, layer, provider, model_alias, cost_usd, latency_ms,
              input_tokens, output_tokens, pricing_source, price_input_per_mtok,
              price_output_per_mtok, prompt_version, schema_version, fail_reason
         FROM test_run_records WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC, id ASC`,
      [from, to],
    );
  } catch (err) {
    if (/no such table: test_run_records/.test((err as Error).message)) return [];
    throw err;
  }
  return rows.map(mapLedgerRow);
}

function mapLedgerRow(r: Record<string, unknown>): LedgerRow {
  return {
    runId: String(r["run_id"]),
    skill: String(r["skill"]),
    createdAt: String(r["created_at"]),
    layer: String(r["layer"]),
    provider: String(r["provider"]),
    modelAlias: String(r["model_alias"]),
    costUsd: r["cost_usd"] === null ? null : Number(r["cost_usd"]),
    latencyMs: r["latency_ms"] === null ? null : Number(r["latency_ms"]),
    inputTokens: r["input_tokens"] === null ? null : Number(r["input_tokens"]),
    outputTokens: r["output_tokens"] === null ? null : Number(r["output_tokens"]),
    pricingSource: String(r["pricing_source"]),
    priceInputPerMtok: r["price_input_per_mtok"] === null ? null : Number(r["price_input_per_mtok"]),
    priceOutputPerMtok: r["price_output_per_mtok"] === null ? null : Number(r["price_output_per_mtok"]),
    promptVersion: r["prompt_version"] === null || r["prompt_version"] === undefined ? null : String(r["prompt_version"]),
    schemaVersion: r["schema_version"] === null || r["schema_version"] === undefined ? null : String(r["schema_version"]),
    failReason: r["fail_reason"] === null || r["fail_reason"] === undefined ? null : String(r["fail_reason"]),
  };
}

/** Open a fresh read handle (caller closes via the returned close()). A thin
 *  wrapper so callers never import @autobroker/db themselves (one DB channel). */
export function openReadHandle(): { db: Db; close: () => void } {
  const db = openDb();
  return { db, close: () => db.$client.close() };
}

/** Open a read handle at an EXPLICIT path (isolated per-run harness DBs). Same
 *  one-DB-channel rule; the caller supplies the file instead of env resolution. */
export function openReadHandleAt(dbPath: string): { db: Db; close: () => void } {
  const db = openDb(dbPath);
  return { db, close: () => db.$client.close() };
}
