/**
 * L1 unit tests — the INSERT-only lead-submission writer + the duplicate-skip /
 * force-retry precondition. Freezes:
 *   - each of the 3 terminal shapes inserts a CHECK-satisfying row that reads
 *     back correctly (web_form / email-fallback / failed);
 *   - a deliberately wrong column combination is rejected by the DB CHECK
 *     (proves ck_lead_submissions_xor is real, not just a TS narrowing);
 *   - the precondition: no prior row => proceed; prior row + force_retry off =>
 *     skip; force_retry on => proceed only after a failure / orphan-pending,
 *     refused after a success;
 *   - the ROUND-TRIP X1 anchor: a web_form row makes readFirstLeadSubmitAtMs
 *     return a finite parsed ms (the inbox window anchor contract).
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
import { readFirstLeadSubmitAtMs } from "../inbox/reads.js";
import {
  checkSubmissionPrecondition,
  ForceRetryRefusedError,
  recordSubmission,
} from "./recordSubmission.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = [
  "0000_military_red_skull.sql",
  "0001_redundant_ozymandias.sql",
  "0002_pale_thunderball.sql",
].map((f) => join(here, "..", "..", "..", "db", "drizzle", f));

const PROFILE = "prof-x";
const DEALER = "dealer-x";

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

/** Read a full lead_submissions row by id, snake_case as stored. */
function readRow(id: string): Record<string, unknown> | undefined {
  return db.$client
    .prepare("SELECT * FROM lead_submissions WHERE submission_id = ?")
    .get(id) as Record<string, unknown> | undefined;
}

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-lead-submissions-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
  db.$client.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')").run(DEALER, "Example Hyundai");
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

describe("recordSubmission — the 3 terminal shapes satisfy the XOR CHECK", () => {
  it("inserts a web_form row (submitted, channel web_form, no reasons, submitted_at stamped)", () => {
    const id = recordSubmission(
      { kind: "web_form", submissionId: "ls-web", dealerId: DEALER, searchProfileId: PROFILE },
      db,
    );
    expect(id).toBe("ls-web");
    const row = readRow("ls-web")!;
    expect(row["outcome"]).toBe("submitted");
    expect(row["submission_channel"]).toBe("web_form");
    expect(row["fail_reason"]).toBeNull();
    expect(row["email_fallback_reason"]).toBeNull();
    expect(typeof row["submitted_at"]).toBe("string");
    expect(Number.isFinite(Date.parse(row["submitted_at"] as string))).toBe(true);
  });

  it("inserts an email-fallback row (submitted, channel email, email_fallback_reason set)", () => {
    recordSubmission(
      {
        kind: "email",
        submissionId: "ls-email",
        dealerId: DEALER,
        searchProfileId: PROFILE,
        emailFallbackReason: "captcha_fallback",
        submittedEmail: "dealer@example.com",
      },
      db,
    );
    const row = readRow("ls-email")!;
    expect(row["outcome"]).toBe("submitted");
    expect(row["submission_channel"]).toBe("email");
    expect(row["email_fallback_reason"]).toBe("captcha_fallback");
    expect(row["fail_reason"]).toBeNull();
    expect(row["submitted_email"]).toBe("dealer@example.com");
    expect(Number.isFinite(Date.parse(row["submitted_at"] as string))).toBe(true);
  });

  it("inserts a failed row (failed, channel NULL, fail_reason set, no submitted_at)", () => {
    recordSubmission(
      {
        kind: "failed",
        submissionId: "ls-fail",
        dealerId: DEALER,
        searchProfileId: PROFILE,
        failReason: "site_unreachable",
      },
      db,
    );
    const row = readRow("ls-fail")!;
    expect(row["outcome"]).toBe("failed");
    expect(row["submission_channel"]).toBeNull();
    expect(row["fail_reason"]).toBe("site_unreachable");
    expect(row["email_fallback_reason"]).toBeNull();
    expect(row["submitted_at"]).toBeNull();
  });

  it("carries through the optional provenance columns", () => {
    recordSubmission(
      {
        kind: "web_form",
        submissionId: "ls-prov",
        dealerId: DEALER,
        searchProfileId: PROFILE,
        formUrl: "https://dealer.example.com/lead",
        sourceListingId: "listing-1",
        commentText: "Looking for an OTD quote.",
      },
      db,
    );
    const row = readRow("ls-prov")!;
    expect(row["form_url"]).toBe("https://dealer.example.com/lead");
    expect(row["source_listing_id"]).toBe("listing-1");
    expect(row["comment_text"]).toBe("Looking for an OTD quote.");
  });
});

describe("ck_lead_submissions_xor is a real DB constraint (not just TS narrowing)", () => {
  it("rejects a wrong column combination (submitted + channel web_form + a fail_reason)", () => {
    // A raw INSERT bypassing the typed writer — proves the CHECK fires.
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO lead_submissions (submission_id, dealer_id, search_profile_id, outcome, submission_channel, fail_reason) " +
            "VALUES (?, ?, ?, 'submitted', 'web_form', 'site_unreachable')",
        )
        .run("ls-bad", DEALER, PROFILE),
    ).toThrow();
  });

  it("rejects a submitted+email row missing the email_fallback_reason", () => {
    expect(() =>
      db.$client
        .prepare(
          "INSERT INTO lead_submissions (submission_id, dealer_id, search_profile_id, outcome, submission_channel) " +
            "VALUES (?, ?, ?, 'submitted', 'email')",
        )
        .run("ls-bad2", DEALER, PROFILE),
    ).toThrow();
  });
});

describe("checkSubmissionPrecondition — duplicate-skip / force-retry", () => {
  it("proceeds when no prior row exists for the (profile, dealer) pair", () => {
    const v = checkSubmissionPrecondition({ searchProfileId: PROFILE, dealerId: DEALER, db });
    expect(v).toEqual({ kind: "proceed" });
  });

  it("skips when a prior row exists and force_retry is off (idempotent no-op)", () => {
    recordSubmission(
      { kind: "web_form", submissionId: "ls-prior", dealerId: DEALER, searchProfileId: PROFILE },
      db,
    );
    const v = checkSubmissionPrecondition({ searchProfileId: PROFILE, dealerId: DEALER, db });
    expect(v).toEqual({ kind: "skip", existingSubmissionId: "ls-prior" });
  });

  it("proceeds on force_retry when the latest terminal row failed", () => {
    recordSubmission(
      {
        kind: "failed",
        submissionId: "ls-prior-fail",
        dealerId: DEALER,
        searchProfileId: PROFILE,
        failReason: "captcha_blocked",
      },
      db,
    );
    const v = checkSubmissionPrecondition({
      searchProfileId: PROFILE,
      dealerId: DEALER,
      forceRetry: true,
      db,
    });
    expect(v).toEqual({ kind: "proceed" });
  });

  it("proceeds on force_retry for an orphan-pending recovery (no terminal row yet)", () => {
    db.$client
      .prepare(
        "INSERT INTO lead_submissions (submission_id, dealer_id, search_profile_id, outcome) VALUES (?, ?, ?, 'pending')",
      )
      .run("ls-pending", DEALER, PROFILE);
    const v = checkSubmissionPrecondition({
      searchProfileId: PROFILE,
      dealerId: DEALER,
      forceRetry: true,
      db,
    });
    expect(v).toEqual({ kind: "proceed" });
  });

  it("refuses force_retry when the latest terminal row succeeded", () => {
    recordSubmission(
      { kind: "web_form", submissionId: "ls-success", dealerId: DEALER, searchProfileId: PROFILE },
      db,
    );
    expect(() =>
      checkSubmissionPrecondition({
        searchProfileId: PROFILE,
        dealerId: DEALER,
        forceRetry: true,
        db,
      }),
    ).toThrow(ForceRetryRefusedError);
  });

  it("uses the LATEST terminal outcome — a later failure after a success re-opens force_retry", () => {
    recordSubmission(
      { kind: "web_form", submissionId: "ls-1", dealerId: DEALER, searchProfileId: PROFILE },
      db,
    );
    recordSubmission(
      {
        kind: "failed",
        submissionId: "ls-2",
        dealerId: DEALER,
        searchProfileId: PROFILE,
        failReason: "form_rejected",
      },
      db,
    );
    const v = checkSubmissionPrecondition({
      searchProfileId: PROFILE,
      dealerId: DEALER,
      forceRetry: true,
      db,
    });
    expect(v).toEqual({ kind: "proceed" });
  });
});

describe("X1 anchor round-trip — a web_form row feeds readFirstLeadSubmitAtMs", () => {
  it("returns a finite parsed ms after a web_form submission is recorded", () => {
    expect(readFirstLeadSubmitAtMs(db, PROFILE)).toBeNull(); // no submit yet
    recordSubmission(
      { kind: "web_form", submissionId: "ls-anchor", dealerId: DEALER, searchProfileId: PROFILE },
      db,
    );
    const ms = readFirstLeadSubmitAtMs(db, PROFILE);
    expect(ms).not.toBeNull();
    expect(Number.isFinite(ms!)).toBe(true);
  });
});
