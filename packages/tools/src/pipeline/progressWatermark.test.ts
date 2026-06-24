/**
 * L1 unit tests — the per-profile pipeline-progress watermark (the durable
 * dormancy marker the profileHealth projection reads). Freezes:
 *   - read on a never-written profile → null;
 *   - write(iso) then read → the same iso, and the row carries search_profile_id;
 *   - a second write upserts (value wins, exactly one row per profile key).
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

import { lastProgressKey, readLastProgressAt, writeLastProgressAt } from "./progressWatermark.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

function clearState(): void {
  db.$client.prepare("DELETE FROM pipeline_state").run();
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-progress-wm-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0002_pale_thunderball.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0003_salty_jocasta.sql"), "utf8"));
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
  clearState();
});

describe("lastProgressKey", () => {
  it("keys the row by profile id", () => {
    expect(lastProgressKey("prof-A")).toBe("pipeline.last_progress_at.prof-A");
  });
});

describe("readLastProgressAt", () => {
  it("returns null for a profile that has never been written", () => {
    expect(readLastProgressAt(db, "prof-never")).toBeNull();
  });
});

describe("writeLastProgressAt", () => {
  it("write(iso) then read returns the same iso, and the row carries search_profile_id", () => {
    const iso = "2026-06-24T12:00:00.000Z";
    writeLastProgressAt(db, "prof-A", iso);

    expect(readLastProgressAt(db, "prof-A")).toBe(iso);

    const row = db.$client
      .prepare("SELECT value, search_profile_id FROM pipeline_state WHERE key = ?")
      .get(lastProgressKey("prof-A")) as { value: string; search_profile_id: string };
    expect(row.value).toBe(iso);
    expect(row.search_profile_id).toBe("prof-A");
  });

  it("a second write upserts (newest value wins) and keeps exactly one row per profile", () => {
    writeLastProgressAt(db, "prof-A", "2026-06-01T00:00:00.000Z");
    writeLastProgressAt(db, "prof-A", "2026-06-24T00:00:00.000Z");

    expect(readLastProgressAt(db, "prof-A")).toBe("2026-06-24T00:00:00.000Z");

    const count = db.$client
      .prepare("SELECT COUNT(*) AS n FROM pipeline_state WHERE key = ?")
      .get(lastProgressKey("prof-A")) as { n: number };
    expect(count.n).toBe(1);
  });
});
