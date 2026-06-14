/**
 * L1 unit tests — commitHygiene: the single all-or-nothing commit. Freezes:
 * all three staged stages apply in one transaction with matching counts; a
 * thrown guard (a quote-owning contact slipped into the staged set) rolls back
 * the WHOLE transaction (the orphan delete + thread suppress are undone too);
 * the orphan red-line holds (the orphan's gmail_thread_id never lands in a
 * suppression row); a re-run is a no-op.
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
import { commitHygiene } from "./verify.js";
import { HygieneRejectedError } from "./writes.js";

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

const DEALER_A = "dealer-a";
const RUN = "run-1";

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-hyg-verify-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
  db.$client.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')").run(DEALER_A, "Dealer A");
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

function count(table: string): number {
  return (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Seed a true orphan (id gm-1), a CRM-noise thread (m-crm/nurture), and a
 *  clean CRM contact (c-crm). Returns the staged ids. */
function seedCleanCandidates() {
  const c = db.$client;
  // orphan: zero messages, gmail_thread_id is a real message-id
  c.prepare("INSERT INTO threads (thread_id, dealer_id, gmail_thread_id) VALUES ('t-real', ?, 'gm-x')").run(DEALER_A);
  c.prepare("INSERT INTO messages (message_id, thread_id, gmail_message_id, direction) VALUES ('m-real', 't-real', 'gm-1', 'inbound')").run();
  c.prepare("INSERT INTO threads (thread_id, dealer_id, gmail_thread_id) VALUES ('t-orphan', ?, 'gm-1')").run(DEALER_A);
  // crm thread: inbound nurture, no offer
  c.prepare("INSERT INTO threads (thread_id, dealer_id, gmail_thread_id) VALUES ('t-crm', ?, 'real-thread')").run(DEALER_A);
  c.prepare("INSERT INTO messages (message_id, thread_id, direction) VALUES ('m-crm', 't-crm', 'inbound')").run();
  c.prepare("INSERT INTO message_analysis (analysis_id, message_id, analysis_version, is_current, intent) VALUES ('a-crm', 'm-crm', 1, 1, 'nurture')").run();
  // crm contact
  c.prepare(
    "INSERT INTO dealer_contacts (contact_id, dealer_id, normalized_email, is_crm_platform_sender) VALUES ('c-crm', ?, 'x@podium.email', 1)",
  ).run(DEALER_A);
  return {
    stagedOrphans: [{ thread_id: "t-orphan", gmail_thread_id: "gm-1" }],
    stagedThreads: ["t-crm"],
    stagedContacts: ["c-crm"],
  };
}

describe("commitHygiene — all three stages atomic", () => {
  it("applies the staged orphan delete + thread suppress + contact demote with matching counts", () => {
    const staged = seedCleanCandidates();
    const res = commitHygiene(db, { runId: RUN, ...staged });
    expect(res).toEqual({ orphans_deleted: 1, crm_threads_suppressed: 1, crm_contacts_suppressed: 1 });

    // orphan gone; t-crm suppressed (not deleted); contact flag set
    expect(db.$client.prepare("SELECT 1 FROM threads WHERE thread_id = 't-orphan'").get()).toBeUndefined();
    const crmState = db.$client.prepare("SELECT state FROM threads WHERE thread_id = 't-crm'").get() as { state: string };
    expect(crmState.state).toBe("suppressed");
    // the orphan's gmail_thread_id never landed in a suppression row (red-line)
    const leaked = db.$client
      .prepare("SELECT COUNT(*) AS n FROM thread_suppression WHERE gmail_thread_id = 'gm-1'")
      .get() as { n: number };
    expect(leaked.n).toBe(0);
  });

  it("a re-run is a no-op (idempotent): every writer no-ops, counts are zero", () => {
    const staged = seedCleanCandidates();
    commitHygiene(db, { runId: RUN, ...staged });
    // re-stage the same ids (the orphan is gone; the thread/contact already cleaned)
    const res = commitHygiene(db, { runId: RUN, stagedOrphans: staged.stagedOrphans, stagedThreads: staged.stagedThreads, stagedContacts: staged.stagedContacts });
    expect(res).toEqual({ orphans_deleted: 0, crm_threads_suppressed: 0, crm_contacts_suppressed: 0 });
  });
});

describe("commitHygiene — a guard throw rolls back the WHOLE transaction", () => {
  it("a quote-owning contact in the staged set aborts ALL writes (orphan + thread untouched)", () => {
    const staged = seedCleanCandidates();
    // make c-crm own a quote so the demote guard throws
    const c = db.$client;
    c.prepare("INSERT INTO messages (message_id, thread_id, direction, contact_id) VALUES ('m-own', 't-crm', 'inbound', 'c-crm')").run();
    c.prepare(
      "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, financing_mode) VALUES ('q1', ?, 'm-own', 'g-own', 'p', 'finance')",
    ).run(DEALER_A);

    const threadsBefore = count("threads");
    expect(() => commitHygiene(db, { runId: RUN, ...staged })).toThrow(HygieneRejectedError);

    // ALL rolled back: orphan still present, t-crm not suppressed, contact not demoted-recorded
    expect(count("threads")).toBe(threadsBefore); // orphan delete undone
    const crmState = db.$client.prepare("SELECT state FROM threads WHERE thread_id = 't-crm'").get() as { state: string };
    expect(crmState.state).not.toBe("suppressed"); // thread suppress undone
    expect(count("thread_suppression")).toBe(0); // nothing committed
  });
});
