/**
 * L1 unit tests — the inbox routing ladder. Freezes:
 *   - lookupDealerBySender is PROFILE-SCOPED: a sender bound to a dealer of a
 *     DIFFERENT profile returns null (a reply never leaks across searches);
 *   - routeThread rungs: explicit thread_routing binding → known-contact →
 *     unrouted.
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
import { lookupDealerBySender, routeThread } from "./routing.js";

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
const DEALER_A = "dealer-a";
const DEALER_B = "dealer-b";

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-inbox-route-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));

  const c = db.$client;
  c.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')").run(DEALER_A, "Dealer A");
  c.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')").run(DEALER_B, "Dealer B");
  // Dealer A is bound to profile A; dealer B to profile B.
  c.prepare("INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'candidate')").run(PROFILE_A, DEALER_A);
  c.prepare("INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'candidate')").run(PROFILE_B, DEALER_B);
  // A contact at dealer A.
  c.prepare(
    "INSERT INTO dealer_contacts (contact_id, dealer_id, normalized_email, display_name) VALUES (?, ?, ?, ?)",
  ).run("c-a", DEALER_A, "sam@dealer-a.com", "Sam");
  // A contact at dealer B (bound to profile B only).
  c.prepare(
    "INSERT INTO dealer_contacts (contact_id, dealer_id, normalized_email, display_name) VALUES (?, ?, ?, ?)",
  ).run("c-b", DEALER_B, "pat@dealer-b.com", "Pat");
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

describe("lookupDealerBySender — profile scoping", () => {
  it("matches a sender whose dealer is bound to THIS profile", () => {
    expect(lookupDealerBySender(db, "sam@dealer-a.com", PROFILE_A)).toEqual({ dealerId: DEALER_A });
  });

  it("returns null for a sender whose dealer is bound to a DIFFERENT profile", () => {
    // pat@dealer-b is a real contact, but dealer B is bound to profile B only —
    // routed under profile A it must NOT match (cross-profile leak guard).
    expect(lookupDealerBySender(db, "pat@dealer-b.com", PROFILE_A)).toBeNull();
  });

  it("returns null for an unknown sender", () => {
    expect(lookupDealerBySender(db, "stranger@nowhere.com", PROFILE_A)).toBeNull();
  });

  it("normalizes case on the lookup", () => {
    expect(lookupDealerBySender(db, "SAM@DEALER-A.COM", PROFILE_A)).toEqual({ dealerId: DEALER_A });
  });
});

describe("routeThread — the ladder", () => {
  it("rung 2: routes an unbound thread to the known-contact's dealer", () => {
    expect(
      routeThread(db, { threadId: "t-new", senderEmail: "sam@dealer-a.com", profileId: PROFILE_A }),
    ).toEqual({ dealerId: DEALER_A, reason: "known_contact" });
  });

  it("rung 1: an explicit thread_routing binding wins (surfaces the bound thread's dealer)", () => {
    const c = db.$client;
    c.prepare("INSERT INTO threads (thread_id, dealer_id, search_profile_id) VALUES (?, ?, ?)").run("t-bound", DEALER_A, PROFILE_A);
    c.prepare("INSERT INTO thread_routing (thread_id, search_profile_id, bound_by) VALUES (?, ?, 'user')").run("t-bound", PROFILE_A);
    expect(
      routeThread(db, { threadId: "t-bound", senderEmail: "stranger@nowhere.com", profileId: PROFILE_A }),
    ).toEqual({ dealerId: DEALER_A, reason: "existing_binding" });
  });

  it("rung 3: an unknown sender with no binding is unrouted", () => {
    expect(
      routeThread(db, { threadId: "t-x", senderEmail: "stranger@nowhere.com", profileId: PROFILE_A }),
    ).toEqual({ unrouted: "unknown_sender" });
  });
});
