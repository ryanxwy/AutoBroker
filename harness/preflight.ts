/**
 * preflight — the isolation + env envelope gate.
 *
 * Every assertion is FAIL-CLOSED: the runner calls assertPreflight() as its very
 * first act and exits 1 on ANY miss, with ZERO network touched before it passes
 * (the "before any run" rule). This mirrors legacy assert_server_sandbox_db /
 * assert_isolated, retargeted to the parity dir ~/.autobroker-ts.
 *
 * The seven gates (in order):
 *   ① AUTOBROKER_DATA_DIR isolated — under ~/.autobroker-ts, NEVER production
 *      ~/.autobroker; the --db path resolves under it.
 *   ② BLOCK fuse armed — AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS === "1" (exact "1").
 *   ③ no auto-approve — AUTOBROKER_TEST_AUTO_APPROVE unset/!="1" (keep the decline
 *      path live, invariant #11).
 *   ④ telemetry silent — MASTRA_TELEMETRY_DISABLED === "1".
 *   ⑤ provider key present — DEEPSEEK_API_KEY (or the --provider's key) is set;
 *      NEVER printed. STOP rather than silently degrade to another lane.
 *   ⑥ server active DB matches — GET /api/mode → active_db === resolve(--db); a
 *      PRODUCTION_DB path is rejected.
 *   ⑦ driver_kind self-check (the two-place lock-step: driver_kind must match in
 *      both the run-init SSE frame and the policy-derived provider) — probe one run-init SSE
 *      frame and assert init.payload.driver_kind === the case expectation BEFORE
 *      any scoring. Lives in driverKind.ts (it needs a live run); this module owns
 *      gates ①–⑥, the env/DB envelope that fires with zero network.
 *   ⑧ fake-mailbox send-only (email-pipeline skills only) — the run is in
 *      fake-send-only mode: AUTOBROKER_GMAIL_BACKEND is unset-or-"fake" (NEVER
 *      "real"), the --db is isolated (gate ①), the BLOCK fuse is armed (gate ②),
 *      and the sandbox table fake_mailbox_messages exists (so a Fake send cannot
 *      silently no-op against a DB missing migration 0002). Fail-closed; the only
 *      gate that opens a (read-only) DB handle.
 *
 * This file touches NO network for gates ①–⑤ (pure env/path checks). Gate ⑥ makes
 * exactly one GET /api/mode call — the FIRST permitted network call, and only
 * after ①–⑤ pass. Reads .env values only to test presence; the actual secret is
 * never logged, returned, or thrown in a message.
 *
 * Gate ⑧ (fake-mailbox send-only, for the email-pipeline skills) is the one gate
 * that opens a DB handle: a read-only, local, zero-network check that migration
 * 0002's sandbox table exists. It opens via @autobroker/db's openDb (the one
 * permitted DB channel) and closes the handle in a finally — no INSERT/UPDATE.
 *
 * Dependency wall: harness layer. Imports @autobroker/tools for resolveDataDir
 * (the same data-dir resolver the SUT uses) and @autobroker/db's openDb (the one
 * permitted DB channel for gate ⑧) — NEVER better-sqlite3/drizzle/playwright/
 * @ai-sdk directly (dependency-cruiser-enforced).
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

import { openDb } from "@autobroker/db";
import { resolveDataDir } from "@autobroker/tools";

/** A fail-closed preflight violation. The runner catches it, prints the reason,
 *  and exits 1. The message NEVER contains a secret value (only names/paths). */
export class PreflightError extends Error {
  constructor(message: string) {
    super(`preflight FAILED (fail-closed): ${message}`);
    this.name = "PreflightError";
  }
}

/** The provider → env-var-name map for the key-presence gate (⑤). DeepSeek is the
 *  default lane; anthropic/openai are first-class switchable providers. */
export const PROVIDER_KEY_ENV: Record<string, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/** The options the env/DB envelope needs. apiBase/db come from the runner flags. */
export interface PreflightOpts {
  provider: string;
  /** The isolated throwaway DB absolute path (--db). */
  db: string;
  /** The SUT base URL for the GET /api/mode active-DB check (gate ⑥). */
  apiBase: string;
  /** Injected fetch for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

/** Tilde-expand a path the same way the SUT's resolveDbPath/resolveDataDir do
 *  (Node does NOT expand "~"). Keeps the comparison in gate ① honest. */
function expandTilde(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/** True when `child` is the same path as, or nested under, `parent`. Compares
 *  resolved absolute paths with a trailing separator so ".../.autobroker-ts" does
 *  not accidentally match ".../.autobroker-ts-evil". */
function isUnder(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Gate ① — the --db path must live under the parity dir ~/.autobroker-ts and NEVER
 * under production ~/.autobroker. Both the env-resolved data dir AND the literal
 * production-home dir are checked, so a mis-set AUTOBROKER_DATA_DIR cannot smuggle
 * a production path through.
 */
export function assertDataDirIsolated(opts: Pick<PreflightOpts, "db">): void {
  if (!isAbsolute(opts.db)) {
    throw new PreflightError(`--db must be an absolute path, got "${opts.db}"`);
  }
  const db = resolve(expandTilde(opts.db));

  // Hard rule (invariant #11): never the production ~/.autobroker tree.
  const productionDir = join(homedir(), ".autobroker");
  const parityDir = join(homedir(), ".autobroker-ts");
  if (isUnder(db, productionDir) && !isUnder(db, parityDir)) {
    throw new PreflightError(
      `refuse: --db is under the PRODUCTION dir ~/.autobroker (${db}) — harness DBs live under ~/.autobroker-ts only`,
    );
  }

  // The env-resolved data dir must itself be the parity dir (or under it), and the
  // --db must live under THAT resolved dir (the SUT writes there).
  const envDataDir = resolve(expandTilde(resolveDataDir()));
  if (!isUnder(envDataDir, parityDir)) {
    throw new PreflightError(
      `AUTOBROKER_DATA_DIR resolves to "${envDataDir}", which is not under ~/.autobroker-ts (${parityDir})`,
    );
  }
  if (!isUnder(db, envDataDir)) {
    throw new PreflightError(
      `--db "${db}" is not under the active AUTOBROKER_DATA_DIR "${envDataDir}"`,
    );
  }

  // Gate ①b (review HIGH, 2026-06-05): a stray AUTOBROKER_DB OVERRIDES the data
  // dir in packages/db resolveDbPath() — the HARNESS'S OWN read handle (keystone
  // scan, table_min_rows, cost_and_time) would silently read whatever it names
  // (e.g. production) while gates ①/⑥ still pass on the server's view. Forbid it
  // unless it points exactly at the throwaway --db.
  const strayDbOverride = process.env["AUTOBROKER_DB"];
  if (strayDbOverride !== undefined && strayDbOverride !== "") {
    const resolvedOverride = resolve(expandTilde(strayDbOverride));
    if (resolvedOverride !== db) {
      throw new PreflightError(
        `refuse: AUTOBROKER_DB is set ("${resolvedOverride}") and differs from --db ("${db}") — ` +
          `the harness read handle would score the WRONG database. Unset AUTOBROKER_DB or point it at --db.`,
      );
    }
  }
}

/** Gate ② — the L1 BLOCK fuse must be armed with the EXACT string "1". */
export function assertBlockFuseArmed(): void {
  if (process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS !== "1") {
    throw new PreflightError(
      'AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS must be exactly "1" (the L1 fuse is not armed)',
    );
  }
}

/** Gate ③ — AUTO_APPROVE must NOT be set to "1" (keep the decline path live). */
export function assertNoAutoApprove(): void {
  if (process.env.AUTOBROKER_TEST_AUTO_APPROVE === "1") {
    throw new PreflightError(
      "AUTOBROKER_TEST_AUTO_APPROVE is set — the decline path would be disabled (invariant #11)",
    );
  }
}

/** Gate ④ — Mastra telemetry must be silenced before any run. */
export function assertTelemetrySilent(): void {
  if (process.env.MASTRA_TELEMETRY_DISABLED !== "1") {
    throw new PreflightError('MASTRA_TELEMETRY_DISABLED must be exactly "1" (telemetry not silenced)');
  }
}

/**
 * Gate ⑤ — the provider's api key is PRESENT (non-empty). The value is read only
 * to test presence; it is NEVER printed, returned, or placed in a thrown message.
 * An unknown provider is itself a fail-closed condition (no silent default).
 */
export function assertProviderKeyPresent(provider: string): void {
  const envName = PROVIDER_KEY_ENV[provider];
  if (envName === undefined) {
    throw new PreflightError(
      `unknown provider "${provider}" — no api-key env mapping (expected one of ${Object.keys(PROVIDER_KEY_ENV).join("|")})`,
    );
  }
  const value = process.env[envName];
  if (value === undefined || value.length === 0) {
    // Name the env var, NEVER the value.
    throw new PreflightError(`${envName} is not set for provider "${provider}" (will not silently change lane)`);
  }
}

/**
 * Gate ⑥ — the SUT's ACTIVE product DB must equal --db. One GET /api/mode call
 * (the first permitted network call). Rejects a server pointed at a different DB
 * (we'd be testing the wrong file) and any production path.
 */
export async function assertServerActiveDbMatches(opts: PreflightOpts): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${opts.apiBase.replace(/\/$/, "")}/api/mode`;
  let mode: { active_db?: unknown; data_dir?: unknown };
  try {
    const res = await fetchImpl(url, { method: "GET" });
    if (!res.ok) {
      throw new PreflightError(`GET /api/mode returned HTTP ${res.status}`);
    }
    mode = (await res.json()) as { active_db?: unknown; data_dir?: unknown };
  } catch (err) {
    if (err instanceof PreflightError) throw err;
    throw new PreflightError(`GET /api/mode failed: ${(err as Error).message}`);
  }

  if (typeof mode.active_db !== "string") {
    throw new PreflightError("GET /api/mode response missing a string active_db");
  }
  const serverDb = resolve(expandTilde(mode.active_db));
  const wantDb = resolve(expandTilde(opts.db));
  if (serverDb !== wantDb) {
    throw new PreflightError(
      `server active DB "${serverDb}" != --db "${wantDb}" — the harness would be testing the wrong DB`,
    );
  }
  // Belt: the server's own active DB must also not be production.
  const productionDir = join(homedir(), ".autobroker");
  const parityDir = join(homedir(), ".autobroker-ts");
  if (isUnder(serverDb, productionDir) && !isUnder(serverDb, parityDir)) {
    throw new PreflightError(`server active DB "${serverDb}" is the PRODUCTION DB — refusing`);
  }
}

/**
 * Run the full env/DB envelope (gates ①–⑥) in order, fail-closed. Gates ①–⑤ touch
 * no network; gate ⑥ makes the single GET /api/mode call only after ①–⑤ pass.
 * The driver_kind self-check (gate ⑦) is a separate live probe (driverKind.ts),
 * run after a server is reachable but BEFORE scoring.
 */
export async function assertPreflight(opts: PreflightOpts): Promise<void> {
  assertDataDirIsolated(opts); // ①
  assertBlockFuseArmed(); // ②
  assertNoAutoApprove(); // ③
  assertTelemetrySilent(); // ④
  assertProviderKeyPresent(opts.provider); // ⑤ (zero network up to here)
  await assertServerActiveDbMatches(opts); // ⑥ (first network call)
}

/** The synchronous, zero-network subset (gates ①–⑤). Exposed so the runner can
 *  assert the env envelope BEFORE it even spawns/contacts a server. */
export function assertEnvEnvelope(opts: Pick<PreflightOpts, "provider" | "db">): void {
  assertDataDirIsolated(opts); // ①
  assertBlockFuseArmed(); // ②
  assertNoAutoApprove(); // ③
  assertTelemetrySilent(); // ④
  assertProviderKeyPresent(opts.provider); // ⑤
}

/**
 * Gate ⑧ — fake-mailbox send-only preflight for the email-pipeline skills. The
 * whole run must be in fake-send-only mode before the first run starts, so no real
 * Gmail send can be reached. FAIL-CLOSED: any of the four conditions missing throws
 * a PreflightError. Synchronous; the table-existence check is a read-only local DB
 * query (no network). Each branch names the exact condition that failed.
 *
 *   ① backend is fake — AUTOBROKER_GMAIL_BACKEND is unset-or-"fake"; "real" (or any
 *      other non-empty value) is rejected.
 *   ② data-dir isolated — reuses assertDataDirIsolated (the ~/.autobroker-ts-only
 *      check), so the sandbox DB is never the production tree.
 *   ③ L1 fuse armed — reuses assertBlockFuseArmed (the redundant outer ring).
 *   ④ sandbox table present — fake_mailbox_messages exists (migration 0002), so a
 *      Fake send cannot silently no-op against a DB missing the table.
 */
export function assertFakeMailboxSendOnly(opts: Pick<PreflightOpts, "db">): void {
  // ① backend is fake (unset-or-"fake"); reject "real" and any other value.
  const backend = process.env.AUTOBROKER_GMAIL_BACKEND;
  if (backend !== undefined && backend !== "" && backend !== "fake") {
    throw new PreflightError(
      `AUTOBROKER_GMAIL_BACKEND="${backend}" — email-pipeline runs require fake-send-only ` +
        `(unset or "fake"); refusing to run with a non-fake mailbox backend`,
    );
  }

  // ② data-dir isolation (reuse gate ①).
  assertDataDirIsolated(opts);

  // ③ L1 BLOCK fuse armed (reuse gate ②).
  assertBlockFuseArmed();

  // ④ the sandbox table fake_mailbox_messages must exist (migration 0002). Open the
  //    read handle through the one permitted DB channel and close it in a finally.
  const db = openDb(opts.db);
  try {
    const row = db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fake_mailbox_messages'")
      .get() as { name?: unknown } | undefined;
    if (row === undefined) {
      throw new PreflightError(
        `the fake_mailbox_messages table is missing from "${resolve(expandTilde(opts.db))}" ` +
          `(migration 0002 not applied) — a fake send would silently no-op`,
      );
    }
  } finally {
    db.$client.close();
  }
}

/** The email-pipeline preflight aggregate: the env envelope (gates ①–⑤) plus the
 *  fake-mailbox send-only gate (⑧). The email-skill runner path asserts this before
 *  any run so a real Gmail send can never be reached. Fail-closed, zero network
 *  beyond the local read handle gate ⑧ opens. */
export function assertEmailEnvelope(opts: Pick<PreflightOpts, "provider" | "db">): void {
  assertEnvEnvelope(opts); // ①–⑤
  assertFakeMailboxSendOnly(opts); // ⑧
}
