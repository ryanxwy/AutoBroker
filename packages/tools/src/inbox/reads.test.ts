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
import {
  listProfileDealerDomains,
  listProfileMessageRows,
  listProfileThreadRows,
  readFirstLeadSubmitAtMs,
} from "./reads.js";
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

describe("listProfileDealerDomains", () => {
  it("returns this profile's bound dealers' website host stems, deduped, profile-scoped, with null/empty dropped", () => {
    const c = db.$client;
    // Two dealers with websites bound to profile A (one shares a host stem to
    // prove dedupe), one with a NULL website (dropped), one with empty (dropped).
    c.prepare("INSERT INTO dealers (dealer_id, name, website, country) VALUES (?, ?, ?, 'US')").run(
      "d-hy",
      "Bob Smith Hyundai",
      "https://www.bob-smith-hyundai.com/",
    );
    c.prepare("INSERT INTO dealers (dealer_id, name, website, country) VALUES (?, ?, ?, 'US')").run(
      "d-hy-2",
      "Bob Smith Hyundai (Service)",
      "https://bob-smith-hyundai.com/service",
    );
    c.prepare("INSERT INTO dealers (dealer_id, name, website, country) VALUES (?, ?, ?, 'US')").run(
      "d-ki",
      "City Kia",
      "https://city-kia.com",
    );
    c.prepare("INSERT INTO dealers (dealer_id, name, website, country) VALUES (?, ?, NULL, 'US')").run(
      "d-nullsite",
      "No Site Motors",
    );
    c.prepare("INSERT INTO dealers (dealer_id, name, website, country) VALUES (?, ?, '', 'US')").run(
      "d-emptysite",
      "Empty Site Motors",
    );
    // Bind the first four to profile A; bind a fifth dealer to profile B only.
    for (const d of ["d-hy", "d-hy-2", "d-ki", "d-nullsite", "d-emptysite"]) {
      c.prepare(
        "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'candidate')",
      ).run(PROFILE_A, d);
    }
    c.prepare("INSERT INTO dealers (dealer_id, name, website, country) VALUES (?, ?, ?, 'US')").run(
      "d-other",
      "Other Profile Ford",
      "https://other-ford.com",
    );
    c.prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'candidate')",
    ).run(PROFILE_B, "d-other");

    const domains = listProfileDealerDomains(db, PROFILE_A);
    // "bob-smith-hyundai" appears once (dedupe), "city-kia" present, null/empty
    // dropped, and "other-ford" (profile B) absent (profile scoping).
    expect(domains).toContain("bob-smith-hyundai");
    expect(domains).toContain("city-kia");
    expect(domains).not.toContain("other-ford");
    expect(domains.filter((s) => s === "bob-smith-hyundai")).toHaveLength(1);
    expect(domains).toHaveLength(2);
  });
});

describe("readFirstLeadSubmitAtMs", () => {
  /** Insert a lead_submissions row honoring the XOR check. */
  function insertSubmission(
    id: string,
    profile: string,
    outcome: "submitted" | "pending" | "failed",
    submittedAt: string | null,
  ): void {
    const c = db.$client;
    if (outcome === "submitted") {
      c.prepare(
        "INSERT INTO lead_submissions (submission_id, dealer_id, search_profile_id, submitted_at, outcome, submission_channel) " +
          "VALUES (?, ?, ?, ?, 'submitted', 'web_form')",
      ).run(id, DEALER, profile, submittedAt);
    } else if (outcome === "failed") {
      c.prepare(
        "INSERT INTO lead_submissions (submission_id, dealer_id, search_profile_id, submitted_at, outcome, fail_reason) " +
          "VALUES (?, ?, ?, ?, 'failed', 'site_unreachable')",
      ).run(id, DEALER, profile, submittedAt);
    } else {
      c.prepare(
        "INSERT INTO lead_submissions (submission_id, dealer_id, search_profile_id, submitted_at, outcome) " +
          "VALUES (?, ?, ?, ?, 'pending')",
      ).run(id, DEALER, profile, submittedAt);
    }
  }

  it("returns the MIN submitted_at (parsed from the ISO string) across submitted rows", () => {
    insertSubmission("ls-1", PROFILE_A, "submitted", "2026-06-10T09:00:00.000Z");
    insertSubmission("ls-2", PROFILE_A, "submitted", "2026-06-08T15:30:00.000Z"); // earliest
    insertSubmission("ls-3", PROFILE_A, "submitted", "2026-06-12T20:00:00.000Z");
    expect(readFirstLeadSubmitAtMs(db, PROFILE_A)).toBe(Date.parse("2026-06-08T15:30:00.000Z"));
  });

  it("ignores pending and failed outcomes", () => {
    insertSubmission("ls-p", PROFILE_A, "pending", "2026-06-01T00:00:00.000Z");
    insertSubmission("ls-f", PROFILE_A, "failed", "2026-06-02T00:00:00.000Z");
    insertSubmission("ls-s", PROFILE_A, "submitted", "2026-06-09T00:00:00.000Z");
    // The earlier pending/failed rows must not lower the floor.
    expect(readFirstLeadSubmitAtMs(db, PROFILE_A)).toBe(Date.parse("2026-06-09T00:00:00.000Z"));
  });

  it("returns null when the profile has no submitted lead", () => {
    insertSubmission("ls-p", PROFILE_A, "pending", "2026-06-01T00:00:00.000Z");
    expect(readFirstLeadSubmitAtMs(db, PROFILE_A)).toBeNull();
    // A submitted row for a DIFFERENT profile does not count.
    insertSubmission("ls-b", PROFILE_B, "submitted", "2026-06-05T00:00:00.000Z");
    expect(readFirstLeadSubmitAtMs(db, PROFILE_A)).toBeNull();
    expect(readFirstLeadSubmitAtMs(db, PROFILE_B)).toBe(Date.parse("2026-06-05T00:00:00.000Z"));
  });

  it("returns null when the submitted row's submitted_at is NULL", () => {
    insertSubmission("ls-null", PROFILE_A, "submitted", null);
    expect(readFirstLeadSubmitAtMs(db, PROFILE_A)).toBeNull();
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
