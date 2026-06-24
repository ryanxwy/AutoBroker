/**
 * dbReads.byProfile.test.ts — per-profile mutation accounting + the portfolio
 * aggregate keystone. The headline invariant: the portfolio total (Σ perProfile +
 * the NULL bucket) is EXACTLY the global keystone scan — so `portfolioTotal === 0`
 * in test mode is equivalent to the existing global `total === 0`, and a
 * NULL-profile (orphan) send is never silently dropped from the portfolio sum.
 *
 * ISOLATION: a throwaway tmp DB at an EXPLICIT path; never ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDb, type Db } from "@autobroker/db";

import { externalMutationByProfile, externalMutationDbCount } from "./dbReads.js";

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "packages", "db", "drizzle");

let tmpDir: string;
let db: Db;

const A = "byprofile-A";
const B = "byprofile-B";
const DEALER = "byprofile-dealer-1";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-byprofile-"));
  db = openDb(join(tmpDir, "autobroker.db"));
  for (const f of [
    "0000_military_red_skull.sql",
    "0001_redundant_ozymandias.sql",
    "0002_pale_thunderball.sql",
  ]) {
    db.$client.exec(readFileSync(join(DRIZZLE_DIR, f), "utf8"));
  }
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, account_id, brand, status) " +
        "VALUES (?, 2026, 'Honda', 'Accord', 'acct-1', 'Honda', 'active')",
    )
    .run(A);
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, account_id, brand, status) " +
        "VALUES (?, 2026, 'Toyota', 'Camry', 'acct-1', 'Toyota', 'active')",
    )
    .run(B);
  db.$client
    .prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, 'Test Dealer', 'US')")
    .run(DEALER);
});

afterAll(() => {
  db.$client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("externalMutationByProfile", () => {
  it("a clean DB has zero portfolio total, equal to the global scan", () => {
    const byProfile = externalMutationByProfile(db);
    expect(byProfile.portfolioTotal).toBe(0);
    expect(byProfile.portfolioTotal).toBe(externalMutationDbCount(db).total);
    expect(byProfile.nullBucket.total).toBe(0);
  });

  it("partitions submitted leads, send audits, and a NULL-profile outbound across the right buckets; the portfolio total equals the global scan", () => {
    // A submitted lead attributed to profile A.
    db.$client
      .prepare(
        "INSERT INTO lead_submissions (submission_id, dealer_id, search_profile_id, outcome, submission_channel) " +
          "VALUES ('sub-A-1', ?, ?, 'submitted', 'web_form')",
      )
      .run(DEALER, A);
    // A send-shaped audit row attributed to profile B.
    db.$client
      .prepare(
        "INSERT INTO audit_log (audit_id, action, search_profile_id) VALUES ('aud-B-1', 'gmail_send', ?)",
      )
      .run(B);
    // A real (non-sandbox) outbound message with NO profile — the orphan that a
    // naive per-profile scan would silently drop. It MUST land in the NULL bucket.
    db.$client
      .prepare(
        "INSERT INTO messages (message_id, direction, gmail_message_id, search_profile_id) " +
          "VALUES ('msg-null-1', 'outbound', 'real-xyz-1', NULL)",
      )
      .run();

    const byProfile = externalMutationByProfile(db);

    expect(byProfile.perProfile[A]?.total).toBe(1);
    expect(byProfile.perProfile[A]?.breakdown["lead_submissions.submitted"]).toBe(1);
    expect(byProfile.perProfile[B]?.total).toBe(1);
    expect(byProfile.perProfile[B]?.breakdown["audit_log.send_submit"]).toBe(1);
    expect(byProfile.nullBucket.total).toBe(1);
    expect(byProfile.nullBucket.breakdown["messages.real_outbound"]).toBe(1);

    // The keystone equivalence: the partition is EXACTLY the global scan.
    expect(byProfile.portfolioTotal).toBe(3);
    expect(byProfile.portfolioTotal).toBe(externalMutationDbCount(db).total);
  });

  it("allowFakeOutbound suppresses the submitted-lead leg per profile, exactly like the global scan", () => {
    const byProfile = externalMutationByProfile(db, { allowFakeOutbound: true });
    // profile A's only mutation was a submitted lead → now suppressed.
    expect(byProfile.perProfile[A]?.total ?? 0).toBe(0);
    // B's send audit + the NULL outbound are never relaxed by the flag.
    expect(byProfile.perProfile[B]?.total).toBe(1);
    expect(byProfile.nullBucket.total).toBe(1);
    expect(byProfile.portfolioTotal).toBe(
      externalMutationDbCount(db, { allowFakeOutbound: true }).total,
    );
  });
});
