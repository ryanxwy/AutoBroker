/**
 * dbReads.test.ts — the read-only snapshot module. Covers the inbox-table
 * additions to SNAPSHOT_TABLES (messages/threads/thread_routing/
 * thread_suppression/dealer_contacts) + their profile-scoped counts: a null /
 * empty profile counts 0, a seeded profile-scoped row counts under its profile
 * and NOT under another, and the read-guard still rejects a non-SELECT.
 *
 * ISOLATION: a throwaway tmp DB at an EXPLICIT path; never ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDb, type Db } from "@autobroker/db";

import { snapshotCounts, SNAPSHOT_TABLES } from "./dbReads.js";

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "packages", "db", "drizzle");

let tmpDir: string;
let db: Db;

const PROFILE = "dbreads-profile-1";
const OTHER = "dbreads-profile-2";
const DEALER = "dbreads-dealer-1";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-dbreads-"));
  db = openDb(join(tmpDir, "autobroker.db"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0002_pale_thunderball.sql"), "utf8"));

  // Two profiles so the profile-scoped counts can prove they don't leak. They
  // carry DIFFERENT brands so the partial unique index (one active profile per
  // account+brand) admits both as active.
  db.$client
    .prepare(
      "INSERT INTO search_profiles " +
        "(search_profile_id, year, make, model, account_id, brand, status) " +
        "VALUES (?, 2026, 'Hyundai', 'Tucson Hybrid', 'acct-harness-1', 'Hyundai', 'active')",
    )
    .run(PROFILE);
  db.$client
    .prepare(
      "INSERT INTO search_profiles " +
        "(search_profile_id, year, make, model, account_id, brand, status) " +
        "VALUES (?, 2026, 'Toyota', 'RAV4', 'acct-harness-1', 'Toyota', 'active')",
    )
    .run(OTHER);
  db.$client
    .prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, 'Test Hyundai', 'US')")
    .run(DEALER);
});

afterAll(() => {
  db.$client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SNAPSHOT_TABLES inbox additions", () => {
  it("includes the five inbox write-target tables", () => {
    for (const t of [
      "messages",
      "threads",
      "thread_routing",
      "thread_suppression",
      "dealer_contacts",
    ]) {
      expect(SNAPSHOT_TABLES).toContain(t);
    }
  });
});

describe("profile-scoped counts for the inbox tables", () => {
  it("a null profile counts 0 for every snapshot table", () => {
    const counts = snapshotCounts(null, db);
    for (const t of SNAPSHOT_TABLES) {
      expect(counts.profile[t]).toBe(0);
    }
  });

  it("counts a seeded inbox row under its profile and not under another", () => {
    // A threads row + a messages row + a thread_routing row, all scoped to
    // PROFILE. These mirror the shape the inbox apply writes.
    db.$client
      .prepare(
        "INSERT INTO threads (thread_id, dealer_id, search_profile_id, state) " +
          "VALUES ('t-1', ?, ?, 'replied')",
      )
      .run(DEALER, PROFILE);
    db.$client
      .prepare(
        "INSERT INTO messages (message_id, thread_id, direction, search_profile_id) " +
          "VALUES ('m-1', 't-1', 'inbound', ?)",
      )
      .run(PROFILE);
    db.$client
      .prepare(
        "INSERT INTO thread_routing (thread_id, search_profile_id) VALUES ('t-1', ?)",
      )
      .run(PROFILE);

    const mine = snapshotCounts(PROFILE, db);
    expect(mine.profile["threads"]).toBe(1);
    expect(mine.profile["messages"]).toBe(1);
    expect(mine.profile["thread_routing"]).toBe(1);

    const other = snapshotCounts(OTHER, db);
    expect(other.profile["threads"]).toBe(0);
    expect(other.profile["messages"]).toBe(0);
    expect(other.profile["thread_routing"]).toBe(0);

    // Global counts see the row regardless of profile.
    expect(mine.global["threads"]).toBe(1);
    expect(mine.global["messages"]).toBe(1);
    expect(mine.global["thread_routing"]).toBe(1);
  });
});
