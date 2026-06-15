/**
 * L1 unit tests — the per-profile digest watermark. Freezes the
 * `digest.last_at.<profileId>` key format, the upsert (each digest overwrites
 * the prior value, exactly one row per profile), the search_profile_id stamp,
 * and the null read before any digest. Isolated under an os.tmpdir() dir.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/db";

import { lastDigestAtKey, readLastDigestAt, writeLastDigestAt } from "./digestWatermark.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-digestwm-"));
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

describe("digest watermark", () => {
  it("key format is digest.last_at.<profileId>", () => {
    expect(lastDigestAtKey("sp_abc")).toBe("digest.last_at.sp_abc");
  });

  it("reads null before any digest", () => {
    expect(readLastDigestAt(db, "sp_abc")).toBeNull();
  });

  it("writes and reads back the epoch-ms string + stamps search_profile_id", () => {
    writeLastDigestAt(db, "sp_abc", 1_750_000_000_000);
    expect(readLastDigestAt(db, "sp_abc")).toBe("1750000000000");
    const row = db.$client
      .prepare("SELECT search_profile_id FROM pipeline_state WHERE key = ?")
      .get("digest.last_at.sp_abc") as { search_profile_id: string };
    expect(row.search_profile_id).toBe("sp_abc");
  });

  it("upserts — a later digest overwrites (one row per profile)", () => {
    writeLastDigestAt(db, "sp_abc", 1000);
    writeLastDigestAt(db, "sp_abc", 2000);
    expect(readLastDigestAt(db, "sp_abc")).toBe("2000");
    const count = db.$client
      .prepare("SELECT COUNT(*) AS n FROM pipeline_state WHERE key = ?")
      .get("digest.last_at.sp_abc") as { n: number };
    expect(count.n).toBe(1);
  });

  it("the digest key is distinct from the scheduler key (both coexist)", () => {
    writeLastDigestAt(db, "sp_abc", 5000);
    db.$client
      .prepare("INSERT INTO pipeline_state (key, value) VALUES (?, ?)")
      .run("scheduler.last_success.daily_digest", "6000");
    expect(readLastDigestAt(db, "sp_abc")).toBe("5000");
    const sched = db.$client
      .prepare("SELECT value FROM pipeline_state WHERE key = ?")
      .get("scheduler.last_success.daily_digest") as { value: string };
    expect(sched.value).toBe("6000");
  });
});
