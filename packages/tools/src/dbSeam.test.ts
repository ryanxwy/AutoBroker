/**
 * Unit tests for the tools-layer DB-seam helpers that moved the four workflows'
 * raw `db.$client` SQL down into packages/tools (the "only tools touches the
 * product DB" invariant). Each is a read/write round-trip on a throwaway,
 * fully-migrated DB.
 *
 * The load-bearing distinction under test: closeProfileStatusPlain writes ONLY
 * the status column — it does NOT bump updated_at (unlike profileService's
 * SET_STATUS close lifecycle).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved /
 * restored); migrate() runs every committed migration against the throwaway DB.
 * NEVER touches ~/.autobroker-ts or ~/.autobroker.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, migrate, openDb, type Db } from "@autobroker/db";

import { upsertDealerContactEmail } from "./geosearch/upsertDealers.js";
import { setThreadState } from "./inbox/threadWrites.js";
import { readListingRowById } from "./inventory/read.js";
import { closeProfileStatusPlain } from "./profile/profileService.js";
import { readDealerDisplayName } from "./quotes/quotesRead.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

let tmpDir: string;
let db: Db;

function insertDealer(id: string, name: string): void {
  db.$client.prepare("INSERT INTO dealers (dealer_id, name) VALUES (?, ?)").run(id, name);
}

function insertProfile(id: string, status: string, updatedAt: string): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, status, updated_at) " +
        "VALUES (?, 2024, 'Honda', 'Accord', ?, ?)",
    )
    .run(id, status, updatedAt);
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-dbseam-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  migrate(db);
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
  db.$client.exec(
    "DELETE FROM inventory_listings; DELETE FROM dealer_quotes; " +
      "DELETE FROM threads; DELETE FROM dealers; DELETE FROM search_profiles;",
  );
});

describe("upsertDealerContactEmail", () => {
  it("sets and overwrites dealers.contact_email for the named dealer", () => {
    insertDealer("D1", "Alpha Honda");
    upsertDealerContactEmail(db, "D1", "sales@alpha.example");
    expect(
      db.$client.prepare("SELECT contact_email FROM dealers WHERE dealer_id = ?").get("D1"),
    ).toEqual({ contact_email: "sales@alpha.example" });

    upsertDealerContactEmail(db, "D1", "internet@alpha.example");
    expect(
      db.$client.prepare("SELECT contact_email FROM dealers WHERE dealer_id = ?").get("D1"),
    ).toEqual({ contact_email: "internet@alpha.example" });
  });
});

describe("setThreadState", () => {
  it("writes only the threads.state column for the named thread", () => {
    insertDealer("D1", "Alpha Honda");
    db.$client
      .prepare("INSERT INTO threads (thread_id, dealer_id) VALUES (?, ?)")
      .run("T1", "D1");

    setThreadState(db, "T1", "negotiating");
    expect(
      db.$client.prepare("SELECT state FROM threads WHERE thread_id = ?").get("T1"),
    ).toEqual({ state: "negotiating" });
  });
});

describe("closeProfileStatusPlain", () => {
  it("flips status to 'closed' WITHOUT bumping updated_at (plain write)", () => {
    insertProfile("P1", "active", "2020-01-01 00:00:00");
    closeProfileStatusPlain(db, "P1");
    const row = db.$client
      .prepare("SELECT status, updated_at FROM search_profiles WHERE search_profile_id = ?")
      .get("P1");
    expect(row).toEqual({ status: "closed", updated_at: "2020-01-01 00:00:00" });
  });
});

describe("readListingRowById", () => {
  it("reads the listing row back, and returns null when absent", () => {
    db.$client
      .prepare(
        "INSERT INTO inventory_listings (listing_id, search_profile_id, dealer_id, " +
          "inventory_status, match_status, raw_listing_json, first_seen_at, last_seen_at, observed_at) " +
          "VALUES ('L1', 'P1', 'D1', 'in_stock', 'matched', '{}', 1, 1, 1)",
      )
      .run();
    const row = readListingRowById(db, "L1");
    expect(row?.["listing_id"]).toBe("L1");
    expect(row?.["dealer_id"]).toBe("D1");
    expect(readListingRowById(db, "missing")).toBeNull();
  });
});

describe("readDealerDisplayName", () => {
  function insertQuote(quoteId: string, dealerId: string): void {
    db.$client
      .prepare(
        "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, " +
          "search_profile_id, financing_mode) VALUES (?, ?, ?, ?, 'P1', 'cash')",
      )
      .run(quoteId, dealerId, `m-${quoteId}`, `g-${quoteId}`);
  }

  it("returns the dealer name, the dealer_id when the dealer has no row, and null for a missing quote", () => {
    insertDealer("D1", "Alpha Honda");
    insertQuote("Q1", "D1"); // dealer row present → COALESCE picks the name
    insertQuote("Q2", "D-unknown"); // no dealer row → COALESCE falls to dealer_id

    expect(readDealerDisplayName(db, "Q1")).toBe("Alpha Honda");
    expect(readDealerDisplayName(db, "Q2")).toBe("D-unknown");
    expect(readDealerDisplayName(db, "missing")).toBeNull();
  });
});
