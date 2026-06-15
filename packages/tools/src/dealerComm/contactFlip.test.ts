/**
 * L1 unit tests — setPrimaryReplyTarget (the irreversible contact flip).
 * Freezes:
 *   - the happy path clears every contact of the dealer and sets exactly the
 *     named one, in one transaction;
 *   - a contactId that is not a contact of the dealer THROWS and rolls the
 *     whole transaction back (the prior primary flags are untouched — never a
 *     dealer left with zero primaries);
 *   - the flip is dealer-scoped (a same-id contact of a different dealer is not
 *     touched, and a foreign contactId does not match).
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
import { setPrimaryReplyTarget } from "./contactFlip.js";

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

const DEALER = "dealer-1";
const OTHER_DEALER = "dealer-2";

/** Insert a dealer contact with a known primary flag. */
function insertContact(
  c: Db["$client"],
  contactId: string,
  dealerId: string,
  primary: 0 | 1,
): void {
  c.prepare(
    "INSERT INTO dealer_contacts (contact_id, dealer_id, normalized_email, is_primary_reply_target) " +
      "VALUES (?, ?, ?, ?)",
  ).run(contactId, dealerId, `${contactId}@example.com`, primary);
}

/** Read a contact's primary flag back. */
function primaryFlag(c: Db["$client"], contactId: string): number {
  const row = c
    .prepare("SELECT is_primary_reply_target AS p FROM dealer_contacts WHERE contact_id = ?")
    .get(contactId) as { p: number } | undefined;
  return row?.p ?? -1;
}

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-contact-flip-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
  const c = db.$client;
  c.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')").run(
    DEALER,
    "Jim Click Hyundai",
  );
  c.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')").run(
    OTHER_DEALER,
    "Larry Miller Hyundai",
  );
  // Dealer 1: c-1 is currently the primary; c-2 is not.
  insertContact(c, "c-1", DEALER, 1);
  insertContact(c, "c-2", DEALER, 0);
  // A same-shaped contact on another dealer, currently primary there.
  insertContact(c, "c-3", OTHER_DEALER, 1);
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

describe("setPrimaryReplyTarget", () => {
  it("clears every contact of the dealer and sets exactly the named one", () => {
    setPrimaryReplyTarget(db, { dealerId: DEALER, contactId: "c-2" });
    const c = db.$client;
    expect(primaryFlag(c, "c-1")).toBe(0); // the old primary is cleared
    expect(primaryFlag(c, "c-2")).toBe(1); // the named contact is now primary
  });

  it("does not touch a same-state contact of a different dealer", () => {
    setPrimaryReplyTarget(db, { dealerId: DEALER, contactId: "c-2" });
    // c-3 belongs to OTHER_DEALER and must stay primary.
    expect(primaryFlag(db.$client, "c-3")).toBe(1);
  });

  it("is idempotent when re-pinning the already-primary contact", () => {
    setPrimaryReplyTarget(db, { dealerId: DEALER, contactId: "c-1" });
    const c = db.$client;
    expect(primaryFlag(c, "c-1")).toBe(1);
    expect(primaryFlag(c, "c-2")).toBe(0);
  });

  it("throws and rolls back when the contact is not a contact of the dealer", () => {
    expect(() => setPrimaryReplyTarget(db, { dealerId: DEALER, contactId: "nope" })).toThrow(
      /not a contact of dealer/,
    );
    // Rollback: the prior primary (c-1) is untouched, so the dealer still has a
    // primary — never zero.
    expect(primaryFlag(db.$client, "c-1")).toBe(1);
    expect(primaryFlag(db.$client, "c-2")).toBe(0);
  });

  it("throws and rolls back when the contactId belongs to another dealer", () => {
    // c-3 exists, but not under DEALER — the set matches 0 rows → guard throws,
    // and the clear-all for DEALER is rolled back.
    expect(() => setPrimaryReplyTarget(db, { dealerId: DEALER, contactId: "c-3" })).toThrow(
      /not a contact of dealer/,
    );
    expect(primaryFlag(db.$client, "c-1")).toBe(1);
    expect(primaryFlag(db.$client, "c-3")).toBe(1); // the other dealer's primary is untouched
  });
});
