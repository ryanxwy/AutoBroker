/**
 * preflight.test.ts — each isolation gate violation maps to a fail-closed
 * PreflightError (the runner exits 1 on any). NO network for gates ①–⑤; gate ⑥
 * uses an injected fetch. (Each violation maps to its exit-1 path.)
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb } from "@autobroker/db";

import {
  assertBlockFuseArmed,
  assertDataDirIsolated,
  assertFakeMailboxSendOnly,
  assertNoAutoApprove,
  assertProviderKeyPresent,
  assertServerActiveDbMatches,
  assertTelemetrySilent,
  PreflightError,
} from "./preflight.js";

const PARITY_DB = join(homedir(), ".autobroker-ts", "harness-runs", "t", "autobroker.db");

const SAVED: Record<string, string | undefined> = {};
const KEYS = [
  "AUTOBROKER_DATA_DIR",
  "AUTOBROKER_DB",
  "AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS",
  "AUTOBROKER_TEST_AUTO_APPROVE",
  "MASTRA_TELEMETRY_DISABLED",
  "DEEPSEEK_API_KEY",
  "AUTOBROKER_GMAIL_BACKEND",
];

beforeEach(() => {
  for (const k of KEYS) SAVED[k] = process.env[k];
  // A clean, ISOLATED, fully-armed baseline.
  process.env.AUTOBROKER_DATA_DIR = join(homedir(), ".autobroker-ts");
  delete process.env.AUTOBROKER_DB;
  process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS = "1";
  delete process.env.AUTOBROKER_TEST_AUTO_APPROVE;
  process.env.MASTRA_TELEMETRY_DISABLED = "1";
  process.env.DEEPSEEK_API_KEY = "test-key-not-printed";
  delete process.env.AUTOBROKER_GMAIL_BACKEND; // unset → fake-send-only default
});
afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe("gate ① data-dir isolation", () => {
  it("PASSES for a --db under ~/.autobroker-ts", () => {
    expect(() => assertDataDirIsolated({ db: PARITY_DB })).not.toThrow();
  });

  it("REJECTS a --db under production ~/.autobroker", () => {
    const prodDb = join(homedir(), ".autobroker", "autobroker.db");
    expect(() => assertDataDirIsolated({ db: prodDb })).toThrow(PreflightError);
  });

  it("REJECTS a relative --db path", () => {
    expect(() => assertDataDirIsolated({ db: "relative/autobroker.db" })).toThrow(PreflightError);
  });

  it("REJECTS when AUTOBROKER_DATA_DIR is not under ~/.autobroker-ts", () => {
    process.env.AUTOBROKER_DATA_DIR = "/tmp/elsewhere";
    expect(() => assertDataDirIsolated({ db: PARITY_DB })).toThrow(PreflightError);
  });
});

describe("gate ② BLOCK fuse", () => {
  it("PASSES when armed exactly '1'", () => {
    expect(() => assertBlockFuseArmed()).not.toThrow();
  });
  it("REJECTS when unset", () => {
    delete process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS;
    expect(() => assertBlockFuseArmed()).toThrow(PreflightError);
  });
  it("REJECTS when 'true' (not the exact string '1')", () => {
    process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS = "true";
    expect(() => assertBlockFuseArmed()).toThrow(PreflightError);
  });
});

describe("gate ③ no auto-approve", () => {
  it("PASSES when unset", () => {
    expect(() => assertNoAutoApprove()).not.toThrow();
  });
  it("REJECTS when set to '1' (decline path disabled)", () => {
    process.env.AUTOBROKER_TEST_AUTO_APPROVE = "1";
    expect(() => assertNoAutoApprove()).toThrow(PreflightError);
  });
});

describe("gate ④ telemetry silent", () => {
  it("PASSES when '1'", () => {
    expect(() => assertTelemetrySilent()).not.toThrow();
  });
  it("REJECTS when unset", () => {
    delete process.env.MASTRA_TELEMETRY_DISABLED;
    expect(() => assertTelemetrySilent()).toThrow(PreflightError);
  });
});

describe("gate ⑤ provider key present (never printed)", () => {
  it("PASSES when DEEPSEEK_API_KEY is set", () => {
    expect(() => assertProviderKeyPresent("deepseek")).not.toThrow();
  });
  it("REJECTS when the key is missing, and NEVER prints the value", () => {
    delete process.env.DEEPSEEK_API_KEY;
    try {
      assertProviderKeyPresent("deepseek");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PreflightError);
      // The message names the env var, not a value.
      expect((err as Error).message).toContain("DEEPSEEK_API_KEY");
    }
  });
  it("REJECTS an unknown provider (no silent default)", () => {
    expect(() => assertProviderKeyPresent("groq")).toThrow(PreflightError);
  });
});

describe("gate ⑥ server active DB matches --db", () => {
  function fakeFetch(activeDb: string, ok = true): typeof fetch {
    return (async () =>
      ({
        ok,
        status: ok ? 200 : 500,
        json: async () => ({ active_db: activeDb, data_dir: join(homedir(), ".autobroker-ts") }),
      }) as unknown as Response) as unknown as typeof fetch;
  }

  it("PASSES when /api/mode active_db === --db", async () => {
    await expect(
      assertServerActiveDbMatches({ provider: "deepseek", db: PARITY_DB, apiBase: "http://127.0.0.1:9", fetchImpl: fakeFetch(PARITY_DB) }),
    ).resolves.toBeUndefined();
  });

  it("REJECTS when the server points at a DIFFERENT DB", async () => {
    const other = join(homedir(), ".autobroker-ts", "harness-runs", "other", "autobroker.db");
    await expect(
      assertServerActiveDbMatches({ provider: "deepseek", db: PARITY_DB, apiBase: "http://127.0.0.1:9", fetchImpl: fakeFetch(other) }),
    ).rejects.toBeInstanceOf(PreflightError);
  });

  it("REJECTS when the server reports a PRODUCTION DB", async () => {
    const prod = join(homedir(), ".autobroker", "autobroker.db");
    await expect(
      assertServerActiveDbMatches({ provider: "deepseek", db: prod, apiBase: "http://127.0.0.1:9", fetchImpl: fakeFetch(prod) }),
    ).rejects.toBeInstanceOf(PreflightError);
  });

  it("REJECTS on an HTTP error from /api/mode", async () => {
    await expect(
      assertServerActiveDbMatches({ provider: "deepseek", db: PARITY_DB, apiBase: "http://127.0.0.1:9", fetchImpl: fakeFetch(PARITY_DB, false) }),
    ).rejects.toBeInstanceOf(PreflightError);
  });
});

describe("gate ⑧ fake-mailbox send-only", () => {
  // Gate ⑧ opens a real (read-only) DB handle, so it needs an isolated db that
  // actually exists under the parity dir ~/.autobroker-ts (gate ② requires it).
  // We build it in a uniquely-named throwaway subdir of ~/.autobroker-ts (the
  // isolation sandbox — never the production ~/.autobroker tree) and remove it
  // after; AUTOBROKER_DATA_DIR is restored by the outer afterEach.
  const here = dirname(fileURLToPath(import.meta.url));
  const drizzleDir = join(here, "..", "packages", "db", "drizzle");
  const migration0000 = readFileSync(join(drizzleDir, "0000_military_red_skull.sql"), "utf8");
  const migration0001 = readFileSync(join(drizzleDir, "0001_redundant_ozymandias.sql"), "utf8");
  const migration0002 = readFileSync(join(drizzleDir, "0002_pale_thunderball.sql"), "utf8");

  let sandboxDir: string;
  let withTableDb: string; // 0000+0001+0002 → fake_mailbox_messages present
  let withoutTableDb: string; // 0000+0001 only → table missing

  function applyMigrations(dbPath: string, sqls: string[]): void {
    const db = openDb(dbPath);
    try {
      for (const sql of sqls) db.$client.exec(sql);
    } finally {
      db.$client.close();
    }
  }

  beforeEach(() => {
    // mkdtemp under the parity dir so gate ② (data-dir isolation) passes.
    sandboxDir = mkdtempSync(join(homedir(), ".autobroker-ts", "preflight-test-"));
    process.env.AUTOBROKER_DATA_DIR = sandboxDir;
    withTableDb = join(sandboxDir, "autobroker.db");
    withoutTableDb = join(sandboxDir, "no-fake-tables.db");
    applyMigrations(withTableDb, [migration0000, migration0001, migration0002]);
    applyMigrations(withoutTableDb, [migration0000, migration0001]);
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("PASSES when all four conditions hold (backend unset, isolated db, fuse armed, table present)", () => {
    expect(() => assertFakeMailboxSendOnly({ db: withTableDb })).not.toThrow();
  });

  it("PASSES when AUTOBROKER_GMAIL_BACKEND is exactly 'fake'", () => {
    process.env.AUTOBROKER_GMAIL_BACKEND = "fake";
    expect(() => assertFakeMailboxSendOnly({ db: withTableDb })).not.toThrow();
  });

  it("REJECTS when AUTOBROKER_GMAIL_BACKEND is 'real'", () => {
    process.env.AUTOBROKER_GMAIL_BACKEND = "real";
    expect(() => assertFakeMailboxSendOnly({ db: withTableDb })).toThrow(PreflightError);
    expect(() => assertFakeMailboxSendOnly({ db: withTableDb })).toThrow(/AUTOBROKER_GMAIL_BACKEND/);
  });

  it("REJECTS a non-isolated --db (production ~/.autobroker)", () => {
    const prodDb = join(homedir(), ".autobroker", "autobroker.db");
    expect(() => assertFakeMailboxSendOnly({ db: prodDb })).toThrow(PreflightError);
  });

  it("REJECTS when the L1 BLOCK fuse is disarmed", () => {
    delete process.env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS;
    expect(() => assertFakeMailboxSendOnly({ db: withTableDb })).toThrow(PreflightError);
  });

  it("REJECTS when the fake_mailbox_messages table is missing (migration 0002 not applied)", () => {
    expect(() => assertFakeMailboxSendOnly({ db: withoutTableDb })).toThrow(PreflightError);
    expect(() => assertFakeMailboxSendOnly({ db: withoutTableDb })).toThrow(/fake_mailbox_messages/);
  });
});
