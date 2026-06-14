/**
 * L1 unit tests — the profile-scoped inbox read closures + the per-profile
 * sweep watermark. Freezes:
 *   - listProfileThreadRows / listProfileMessageRows return ONLY the passed
 *     profile's rows (the orphan-fix read mirror), joined to the dealer name;
 *   - readLastInboxCheckAt is null before the first sweep; writeLastInboxCheckAt
 *     upserts (a later write overwrites).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; the committed
 * migrations run against the throwaway DB. NEVER touches ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "../db.js";
import { listProfileMessageRows, listProfileThreadRows } from "./reads.js";
import { readLastInboxCheckAt, writeLastInboxCheckAt } from "./watermark.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = [
  "0000_military_red_skull.sql",
  "0001_redundant_ozymandias.sql",
  "0002_pale_thunderball.sql",
].map((f) => join(here, "..", "..", "..", "db", "drizzle", f));

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

const PROFILE_A = "prof-a";
const PROFILE_B = "prof-b";
const DEALER = "dealer-1";

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-inbox-reads-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
  const c = db.$client;
  c.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')").run(DEALER, "Example Hyundai");
  // One thread + message for profile A, one for profile B.
  for (const [p, t, m] of [
    [PROFILE_A, "t-a", "m-a"],
    [PROFILE_B, "t-b", "m-b"],
  ] as const) {
    c.prepare("INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id) VALUES (?, ?, ?, 'quoted', ?)").run(t, DEALER, `Subj ${p}`, p);
    c.prepare(
      "INSERT INTO messages (message_id, thread_id, direction, sender_email, subject, received_at, search_profile_id, quote_extraction_status) " +
        "VALUES (?, ?, 'inbound', ?, ?, ?, ?, 'pending')",
    ).run(m, t, `s@${p}.com`, `Subj ${p}`, "2026-06-13T10:00:00.000Z", p);
  }
});

afterEach(() => {
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

describe("listProfileThreadRows", () => {
  it("returns only the passed profile's threads, with the dealer name", () => {
    const rows = listProfileThreadRows(db, PROFILE_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["thread_id"]).toBe("t-a");
    expect(rows[0]!["dealer_name"]).toBe("Example Hyundai");
    expect(rows[0]!["search_profile_id"]).toBeUndefined(); // not selected — projection stays lean
  });
});

describe("listProfileMessageRows", () => {
  it("returns only the passed profile's inbound messages", () => {
    const rows = listProfileMessageRows(db, PROFILE_B);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["message_id"]).toBe("m-b");
    expect(rows[0]!["quote_extraction_status"]).toBe("pending");
  });
});

describe("inbox watermark — per profile", () => {
  it("is null before the first sweep, then reads back the written timestamp", () => {
    expect(readLastInboxCheckAt(db, PROFILE_A)).toBeNull();
    writeLastInboxCheckAt(db, PROFILE_A, "2026-06-13T12:00:00.000Z");
    expect(readLastInboxCheckAt(db, PROFILE_A)).toBe("2026-06-13T12:00:00.000Z");
    // A later write overwrites (one row per profile).
    writeLastInboxCheckAt(db, PROFILE_A, "2026-06-14T08:00:00.000Z");
    expect(readLastInboxCheckAt(db, PROFILE_A)).toBe("2026-06-14T08:00:00.000Z");
    // Profile B is independent.
    expect(readLastInboxCheckAt(db, PROFILE_B)).toBeNull();
  });
});
