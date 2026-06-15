/**
 * L1 — the DESTRUCTIVE pipeline_reset tools.
 *
 * Freezes (the load-bearing safety surface):
 *   - validateResetToken: verbatim YES, case-insensitive after trim; everything
 *     else rejected (the no-confirm-no-destruction floor lives here).
 *   - verifySchema: full manifest present + emptiness (accounts 1-row exception);
 *     FAIL when a table is missing OR a non-accounts table is non-empty OR
 *     accounts has 2+ rows.
 *   - pipelineReset: recreates the full fresh schema with ONE default account;
 *     idempotent replay; writes an openable VACUUM INTO backup.
 *   - the prod-DB-reject guard FIRES when the target is the production tree, and
 *     no backup/wipe happens.
 *   - clearWorkflowRuntimeState clears the workflow snapshot table but PRESERVES
 *     Memory chat threads.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; NEVER touches
 * ~/.autobroker*. The prod-reject test passes a fabricated ~/.autobroker path
 * but the guard throws BEFORE any fs touch, so nothing real is written.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { productTableNames } from "@autobroker/db/migrator";

import { closeDb, openDb, type Db } from "../db.js";
import { validateResetToken, RESET_CONFIRM_TOKEN } from "./token.js";
import { verifySchema } from "./verifySchema.js";
import { pipelineReset, DEFAULT_ACCOUNT_EMAIL } from "./reset.js";
import { backupProductDb } from "./backup.js";
import { clearWorkflowRuntimeState, WORKFLOW_RUNTIME_TABLE } from "./mastraRuntime.js";
import { PipelineResetRefusedError } from "./isolation.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = [
  "0000_military_red_skull.sql",
  "0001_redundant_ozymandias.sql",
  "0002_pale_thunderball.sql",
].map((f) => join(here, "..", "..", "..", "db", "drizzle", f));

let tmpDir: string;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

/** Open + fully migrate a product DB at the active data dir (a populated world
 *  for the reset to wipe). */
function openMigrated(): Db {
  const db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
  return db;
}

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-reset-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

// ---------------------------------------------------------------------------
// validateResetToken
// ---------------------------------------------------------------------------

describe("validateResetToken", () => {
  it("accepts the verbatim token case-insensitively after trim", () => {
    for (const ok of ["YES", "yes", "Yes", "yEs", "YES ", " yes", "  YES  ", "\tyes\n"]) {
      expect(validateResetToken(ok), `should accept "${JSON.stringify(ok)}"`).toBe(true);
    }
  });

  it("rejects anything that is not exactly the token", () => {
    for (const bad of ["y", "yeah", "yes please", "ye", "no", "", "   ", "1", "true", "OK", "yess"]) {
      expect(validateResetToken(bad), `should reject "${JSON.stringify(bad)}"`).toBe(false);
    }
  });

  it("rejects non-strings", () => {
    for (const bad of [undefined, null, 1, true, {}, []]) {
      expect(validateResetToken(bad as unknown)).toBe(false);
    }
  });

  it("exports the canonical token", () => {
    expect(RESET_CONFIRM_TOKEN).toBe("YES");
  });
});

// ---------------------------------------------------------------------------
// verifySchema
// ---------------------------------------------------------------------------

describe("verifySchema", () => {
  it("passes on a fresh migrated DB with exactly one accounts row", () => {
    const db = openMigrated();
    db.$client.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run("acc-1", "a@b");
    const res = verifySchema(db);
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
    expect(res.tablesCreated).toBe(productTableNames().length);
    db.$client.close();
  });

  it("passes with an empty accounts table (the 1-row exception is a MAX, not a min)", () => {
    const db = openMigrated();
    expect(verifySchema(db).ok).toBe(true);
    db.$client.close();
  });

  it("FAILS when a non-accounts table is non-empty", () => {
    const db = openMigrated();
    db.$client.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')").run("d1", "D");
    const res = verifySchema(db);
    expect(res.ok).toBe(false);
    expect(res.issues.join(" ")).toContain("dealers");
    db.$client.close();
  });

  it("FAILS when accounts has 2+ rows", () => {
    const db = openMigrated();
    db.$client.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run("a1", "a@x");
    db.$client.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run("a2", "b@x");
    const res = verifySchema(db);
    expect(res.ok).toBe(false);
    expect(res.issues.join(" ")).toContain("accounts");
    db.$client.close();
  });

  it("FAILS when a table from the manifest is missing", () => {
    const db = openMigrated();
    const res = verifySchema(db, { expectedTables: [...productTableNames(), "no_such_table"] });
    expect(res.ok).toBe(false);
    expect(res.issues.join(" ")).toContain("missing table: no_such_table");
    db.$client.close();
  });
});

// ---------------------------------------------------------------------------
// pipelineReset
// ---------------------------------------------------------------------------

describe("pipelineReset", () => {
  it("wipes a populated DB → fresh empty schema + ONE default account + a backup", () => {
    // Seed a populated world.
    const db = openMigrated();
    db.$client.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run("old", "old@x");
    db.$client.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')").run("d1", "D1");
    closeDb();
    db.$client.close();

    const res = pipelineReset({ dataDir: tmpDir, nowMs: 1_700_000_000_000 });

    expect(res.tablesCreated).toBe(productTableNames().length);
    expect(existsSync(res.backupPath)).toBe(true);

    // The recreated DB has the full schema, zero dealers, and exactly ONE
    // default account (a fresh id, the default email).
    const fresh = openDb();
    expect(verifySchema(fresh).ok).toBe(true);
    const dealers = fresh.$client.prepare("SELECT COUNT(*) AS n FROM dealers").get() as { n: number };
    expect(dealers.n).toBe(0);
    const accounts = fresh.$client.prepare("SELECT account_id, email FROM accounts").all() as {
      account_id: string;
      email: string;
    }[];
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.email).toBe(DEFAULT_ACCOUNT_EMAIL);
    expect(accounts[0]!.account_id).not.toBe("old");
    fresh.$client.close();
  });

  it("writes an OPENABLE VACUUM INTO backup that captured the pre-wipe rows", () => {
    const db = openMigrated();
    db.$client.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')").run("keep", "Kept");
    closeDb();
    db.$client.close();

    const res = pipelineReset({ dataDir: tmpDir, nowMs: 1_700_000_000_001 });

    // The backup file is openable (a valid SQLite DB) and captured the pre-wipe
    // world. Open it as its OWN file (a private handle, not the product cache).
    const backup = openDb(res.backupPath);
    try {
      const n = backup.$client.prepare("SELECT COUNT(*) AS n FROM dealers").get() as { n: number };
      expect(n.n).toBe(1); // the snapshot captured the pre-wipe world
    } finally {
      backup.$client.close();
    }
  });

  it("is idempotent on replay — a second reset yields the same fresh schema", () => {
    openMigrated().$client.close();
    closeDb();

    const first = pipelineReset({ dataDir: tmpDir, nowMs: 1_700_000_000_002 });
    const second = pipelineReset({ dataDir: tmpDir, nowMs: 1_700_000_000_003 });

    expect(second.tablesCreated).toBe(first.tablesCreated);
    const db = openDb();
    expect(verifySchema(db).ok).toBe(true);
    const accounts = db.$client.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number };
    expect(accounts.n).toBe(1); // still exactly one default account, not two
    db.$client.close();
  });

  it("skips the internal backup when skipBackup is set (caller already backed up)", () => {
    openMigrated().$client.close();
    closeDb();
    const res = pipelineReset({ dataDir: tmpDir, nowMs: 1_700_000_000_010, skipBackup: true });
    expect(res.backupPath).toBe(""); // no internal snapshot taken
    expect(existsSync(join(tmpDir, "backups"))).toBe(false);
    const db = openDb();
    expect(verifySchema(db).ok).toBe(true);
    db.$client.close();
  });

  it("recreates the schema even when no DB existed yet (no backup needed)", () => {
    // No openMigrated() — the data dir has never had a product DB.
    const res = pipelineReset({ dataDir: tmpDir, nowMs: 1_700_000_000_004 });
    expect(res.tablesCreated).toBe(productTableNames().length);
    expect(res.backupPath).toBe(""); // nothing to back up
    const db = openDb();
    expect(verifySchema(db).ok).toBe(true);
    db.$client.close();
  });
});

// ---------------------------------------------------------------------------
// prod-DB-reject guard
// ---------------------------------------------------------------------------

describe("prod-DB-reject guard", () => {
  it("REFUSES a reset against the production tree ~/.autobroker (no backup, no wipe)", () => {
    const prodDir = join(homedir(), ".autobroker");
    expect(() => pipelineReset({ dataDir: prodDir, nowMs: 1 })).toThrow(PipelineResetRefusedError);
    // Defensive: the guard throws before any fs touch — assert no backups dir was
    // created under the (fabricated) prod path by THIS call. We never write there.
    expect(existsSync(join(prodDir, "backups", "autobroker-1.db"))).toBe(false);
  });

  it("REFUSES a backup against the production tree", () => {
    const prodDir = join(homedir(), ".autobroker", "nested");
    expect(() => backupProductDb({ dataDir: prodDir, nowMs: 1 })).toThrow(PipelineResetRefusedError);
  });

  it("allows the isolated parity tree and tmp dirs (denylist, not allowlist)", () => {
    // The active tmpDir is already isolated → a reset succeeds (covered above);
    // here just assert the guard does NOT throw for it.
    expect(() => pipelineReset({ dataDir: tmpDir, nowMs: 5 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// mastra.db runtime partition
// ---------------------------------------------------------------------------

describe("clearWorkflowRuntimeState", () => {
  it("is a clean no-op when there is no mastra.db yet", () => {
    const res = clearWorkflowRuntimeState(tmpDir);
    expect(res).toEqual({ cleared: false, rowsCleared: 0 });
  });

  it("clears the workflow snapshot table but PRESERVES Memory chat threads", () => {
    // Fabricate a minimal mastra.db with the two table families (via the same
    // openDb factory; mastra.db is just an on-disk SQLite file).
    const mastraPath = join(tmpDir, "mastra.db");
    const m = openDb(mastraPath);
    const mc = m.$client;
    mc.exec(`CREATE TABLE ${WORKFLOW_RUNTIME_TABLE} (run_id TEXT, snapshot TEXT)`);
    mc.exec(`CREATE TABLE mastra_threads (id TEXT, title TEXT)`);
    mc.exec(`CREATE TABLE mastra_messages (id TEXT, content TEXT)`);
    mc.prepare(`INSERT INTO ${WORKFLOW_RUNTIME_TABLE} (run_id, snapshot) VALUES (?, ?)`).run("r1", "{}");
    mc.prepare(`INSERT INTO ${WORKFLOW_RUNTIME_TABLE} (run_id, snapshot) VALUES (?, ?)`).run("r2", "{}");
    mc.prepare("INSERT INTO mastra_threads (id, title) VALUES (?, ?)").run("t1", "chat 1");
    mc.prepare("INSERT INTO mastra_messages (id, content) VALUES (?, ?)").run("msg1", "hi");
    mc.close();

    const res = clearWorkflowRuntimeState(tmpDir);
    expect(res.cleared).toBe(true);
    expect(res.rowsCleared).toBe(2);

    const check = openDb(mastraPath);
    const cc = check.$client;
    try {
      const snaps = cc.prepare(`SELECT COUNT(*) AS n FROM ${WORKFLOW_RUNTIME_TABLE}`).get() as { n: number };
      const threads = cc.prepare("SELECT COUNT(*) AS n FROM mastra_threads").get() as { n: number };
      const messages = cc.prepare("SELECT COUNT(*) AS n FROM mastra_messages").get() as { n: number };
      expect(snaps.n).toBe(0); // workflow runtime cleared
      expect(threads.n).toBe(1); // Memory thread PRESERVED
      expect(messages.n).toBe(1); // Memory message PRESERVED
      // The snapshot table still EXISTS (DELETE FROM, never DROP).
      const exists = cc
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(WORKFLOW_RUNTIME_TABLE);
      expect(exists).toBeDefined();
    } finally {
      cc.close();
    }
  });
});
