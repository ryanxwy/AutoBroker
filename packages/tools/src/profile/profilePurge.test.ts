/**
 * profilePurge.test.ts — the HARD-DELETE (irreversible) cascade.
 *
 * purge() must erase EVERY local row scoped to one profile and the profile row
 * itself, unbind any session pinned to it, write ONE 'profile_purge' tombstone
 * audit row, and leave OTHER profiles (and the shared dealer catalog) untouched.
 *
 * Unlike profileService.test.ts (migration 0000 only), this applies the FULL
 * committed migration set so the fake_mailbox_* tables (0002) the cascade also
 * erases exist. Throwaway DB under AUTOBROKER_DATA_DIR; never touches ~/.autobroker*.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "@autobroker/db";

import { create, purge, type ResolvedCoordinates } from "./profileService.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE = join(here, "..", "..", "..", "db", "drizzle");
const MIGRATIONS = [
  "0000_military_red_skull.sql",
  "0001_redundant_ozymandias.sql",
  "0002_pale_thunderball.sql",
].map((f) => join(DRIZZLE, f));

const COORDS: ResolvedCoordinates = {
  latitude: 33.6695,
  longitude: -117.8231,
  resolvedAddress: "Irvine, CA 92614",
};
const THIS_YEAR = new Date().getFullYear();

let tmpDir: string;
let db: Db;

function count(sql: string, ...args: unknown[]): number {
  return (db.$client.prepare(sql).get(...args) as { n: number }).n;
}

/** Seed the child rows scoped to `profileId` across several families: a bound
 *  dealer, a thread, a skill_run, a lead, a fake-mailbox thread, and a session
 *  pinned to it. Returns the dealer id (shared catalog entry). */
function seedChildren(profileId: string, tag: string): string {
  const dealerId = `dealer-${tag}`;
  db.$client.prepare("INSERT INTO dealers (dealer_id, name) VALUES (?, ?)").run(dealerId, `Dealer ${tag}`);
  db.$client
    .prepare("INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')")
    .run(profileId, dealerId);
  db.$client
    .prepare("INSERT INTO threads (thread_id, dealer_id, search_profile_id) VALUES (?, ?, ?)")
    .run(`thread-${tag}`, dealerId, profileId);
  db.$client
    .prepare(
      "INSERT INTO skill_runs (run_id, skill_name, search_profile_id, started_at, status) VALUES (?, 'x', ?, 0, 'done')",
    )
    .run(`run-${tag}`, profileId);
  db.$client
    .prepare(
      "INSERT INTO lead_submissions (submission_id, dealer_id, search_profile_id, outcome) VALUES (?, ?, ?, 'pending')",
    )
    .run(`lead-${tag}`, dealerId, profileId);
  db.$client
    .prepare("INSERT INTO fake_mailbox_threads (thread_id, subject, search_profile_id) VALUES (?, 'Re: quote', ?)")
    .run(`fmt-${tag}`, profileId);
  // A message + a PDF attachment (the attachment has NO search_profile_id — it
  // hangs off the message FK; the purge must delete it via its parent's scope or
  // the parent-message delete orphans it → commit-time FK violation → rollback).
  db.$client
    .prepare(
      "INSERT INTO messages (message_id, direction, search_profile_id, quote_extraction_status) VALUES (?, 'inbound', ?, 'pending')",
    )
    .run(`msg-${tag}`, profileId);
  db.$client
    .prepare(
      "INSERT INTO message_attachments (attachment_id, message_id, filename, mime_type, size, storage_path, is_orphaned) " +
        "VALUES (?, ?, 'quote.pdf', 'application/pdf', 1024, '/tmp/q.pdf', 0)",
    )
    .run(`att-${tag}`, `msg-${tag}`);
  db.$client
    .prepare(
      "INSERT INTO sessions (id, title, created_at, last_activity_at, pinned_profile_id) VALUES (?, ?, '0', '0', ?)",
    )
    .run(`sess-${tag}`, `Session ${tag}`, profileId);
  return dealerId;
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-purge-"));
  mkdirSync(tmpDir, { recursive: true });
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const m of MIGRATIONS) db.$client.exec(readFileSync(m, "utf8"));
});

afterAll(() => {
  db.$client.close();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

beforeEach(() => {
  db.$client.exec(
    "DELETE FROM message_attachments; DELETE FROM messages; DELETE FROM sessions; " +
      "DELETE FROM fake_mailbox_threads; DELETE FROM lead_submissions; " +
      "DELETE FROM skill_runs; DELETE FROM threads; DELETE FROM profile_dealers; " +
      "DELETE FROM audit_log; DELETE FROM search_profiles; DELETE FROM dealers; DELETE FROM accounts;",
  );
  db.$client.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run("acct-1", "a@e.com");
});

describe("purge — irreversible cascade, isolation, tombstone", () => {
  it("erases the profile + all its scoped rows, unpins its session, writes ONE tombstone", () => {
    const { profile } = create(db, baseInput("RAV4"), { coordinates: COORDS, actor: "test" });
    const dealerId = seedChildren(profile.id, "A");

    const res = purge(db, profile.id, { actor: "dashboard" });

    expect(res.deleted).toBe(true);
    // The profile row + every scoped family is gone.
    expect(count("SELECT COUNT(*) AS n FROM search_profiles WHERE search_profile_id = ?", profile.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM profile_dealers WHERE search_profile_id = ?", profile.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM threads WHERE search_profile_id = ?", profile.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM skill_runs WHERE search_profile_id = ?", profile.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM lead_submissions WHERE search_profile_id = ?", profile.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM fake_mailbox_threads WHERE search_profile_id = ?", profile.id)).toBe(0);
    // The message AND its attachment (which has no search_profile_id of its own)
    // are both gone — proving the cascade didn't roll back on the orphaned-child FK.
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE search_profile_id = ?", profile.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM message_attachments WHERE attachment_id = 'att-A'")).toBe(0);
    expect(res.counts["message_attachments"]).toBe(1);
    // The shared dealer catalog entry SURVIVES (only the per-profile binding went).
    expect(count("SELECT COUNT(*) AS n FROM dealers WHERE dealer_id = ?", dealerId)).toBe(1);
    // The session is unbound, not deleted.
    expect(count("SELECT COUNT(*) AS n FROM sessions WHERE id = 'sess-A'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM sessions WHERE pinned_profile_id = ?", profile.id)).toBe(0);
    // Exactly ONE audit row for this id now — the tombstone (the prior
    // 'search_profile_intake' row was erased by the cascade).
    expect(count("SELECT COUNT(*) AS n FROM audit_log WHERE search_profile_id = ?", profile.id)).toBe(1);
    expect(
      count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'profile_purge' AND search_profile_id = ?", profile.id),
    ).toBe(1);
    // The tombstone carries the per-table counts.
    expect(res.counts["profile_dealers"]).toBe(1);
    expect(res.counts["sessions_unpinned"]).toBe(1);
  });

  it("leaves OTHER profiles and their rows untouched", () => {
    const a = create(db, baseInput("RAV4"), { coordinates: COORDS }).profile;
    const b = create(db, baseInput("Accord", "Honda"), { coordinates: COORDS }).profile;
    seedChildren(a.id, "A");
    seedChildren(b.id, "B");

    purge(db, a.id);

    expect(count("SELECT COUNT(*) AS n FROM search_profiles WHERE search_profile_id = ?", b.id)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM profile_dealers WHERE search_profile_id = ?", b.id)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM threads WHERE search_profile_id = ?", b.id)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM sessions WHERE pinned_profile_id = ?", b.id)).toBe(1);
    // B's intake audit row survives.
    expect(count("SELECT COUNT(*) AS n FROM audit_log WHERE search_profile_id = ?", b.id)).toBe(1);
  });

  it("returns deleted=false for an unknown profile id (→ 404 at the route)", () => {
    expect(purge(db, "does-not-exist").deleted).toBe(false);
  });
});

/** A complete, form-valid intake input (the create() contract). */
function baseInput(model: string, make = "Toyota"): import("@autobroker/core").SearchProfileIntakeInput {
  return {
    make,
    model,
    year: THIS_YEAR,
    location_query: "Irvine, CA 92614",
    follow_up_email: "buyer@example.com",
    financing_preference: "finance",
    trim: "XLE",
    search_radius_miles: null,
    budget_max: null,
    follow_up_phone: null,
    phone_policy: null,
    preferred_exterior_colors_json: null,
    preferred_interior_colors_json: null,
    acceptable_trims_json: null,
    feature_preferences_json: null,
    trade_in_description: null,
    military_first_responder: null,
    current_brand_owner: null,
  };
}
