/**
 * L1 unit tests — the scheduler watermark accessors (pipeline_state-backed
 * per-job last-success store). Freezes:
 *   - a never-written job reads as epoch 0 ("never ran");
 *   - a written watermark round-trips as epoch-ms;
 *   - a second write UPSERTS (one row per job, the second value wins);
 *   - the key is namespaced per job (two jobs never collide).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; the committed
 * migration SQL runs against the throwaway DB. NEVER touches ~/.autobroker-ts.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/db";

import {
  readLastSuccess,
  releaseScheduledJobClaim,
  scheduledJobClaimKey,
  tryClaimScheduledJob,
  watermarkKey,
  writeLastSuccess,
} from "./watermark.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-watermark-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
});

afterAll(() => {
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

beforeEach(() => {
  db.$client.prepare("DELETE FROM pipeline_state").run();
});

describe("watermark accessors", () => {
  it("a never-written job reads as epoch 0", () => {
    expect(readLastSuccess("inbox_poll", db)).toBe(0);
  });

  it("a written watermark round-trips as epoch-ms", () => {
    const at = Date.parse("2026-06-12T12:00:00Z");
    writeLastSuccess("inbox_poll", at, db);
    expect(readLastSuccess("inbox_poll", db)).toBe(at);
  });

  it("a second write upserts (one row per job, the latest value wins)", () => {
    writeLastSuccess("inbox_poll", 1000, db);
    writeLastSuccess("inbox_poll", 2000, db);
    expect(readLastSuccess("inbox_poll", db)).toBe(2000);
    const rows = db.$client
      .prepare("SELECT COUNT(*) AS n FROM pipeline_state WHERE key = ?")
      .get(watermarkKey("inbox_poll")) as { n: number };
    expect(rows.n).toBe(1);
  });

  it("two jobs use distinct keys and never collide", () => {
    writeLastSuccess("inbox_poll", 1000, db);
    writeLastSuccess("daily_digest", 2000, db);
    expect(readLastSuccess("inbox_poll", db)).toBe(1000);
    expect(readLastSuccess("daily_digest", db)).toBe(2000);
    expect(watermarkKey("inbox_poll")).not.toBe(watermarkKey("daily_digest"));
  });
});

describe("scheduled job claims", () => {
  it("allows exactly one owner across two SQLite connections", () => {
    const second = openDb(join(tmpDir, "autobroker.db"));
    try {
      const first = tryClaimScheduledJob({
        jobName: "daily_digest",
        ownerId: "process-a",
        nowMs: 1_000,
        leaseMs: 500,
        db,
      });
      const loser = tryClaimScheduledJob({
        jobName: "daily_digest",
        ownerId: "process-b",
        nowMs: 1_000,
        leaseMs: 500,
        db: second,
      });
      expect(first).not.toBeNull();
      expect(loser).toBeNull();
      expect(readLastSuccess("daily_digest", second)).toBe(0);
    } finally {
      second.$client.close();
    }
  });

  it("reclaims only after expiry and an old owner cannot release its successor", () => {
    const first = tryClaimScheduledJob({
      jobName: "inbox_poll",
      ownerId: "process-a",
      nowMs: 1_000,
      leaseMs: 500,
      db,
    })!;
    expect(
      tryClaimScheduledJob({
        jobName: "inbox_poll",
        ownerId: "process-b",
        nowMs: 1_499,
        leaseMs: 500,
        db,
      }),
    ).toBeNull();
    const successor = tryClaimScheduledJob({
      jobName: "inbox_poll",
      ownerId: "process-b",
      nowMs: 1_500,
      leaseMs: 500,
      db,
    })!;
    expect(successor.ownerId).toBe("process-b");
    expect(releaseScheduledJobClaim(first, db)).toBe(0);
    expect(releaseScheduledJobClaim(successor, db)).toBe(1);
  });

  it("uses a separate keyspace from success watermarks", () => {
    const claim = tryClaimScheduledJob({
      jobName: "daily_digest",
      ownerId: "process-a",
      nowMs: 1_000,
      leaseMs: 500,
      db,
    })!;
    expect(readLastSuccess("daily_digest", db)).toBe(0);
    expect(scheduledJobClaimKey("daily_digest")).not.toBe(watermarkKey("daily_digest"));
    expect(releaseScheduledJobClaim(claim, db)).toBe(1);
  });
});
