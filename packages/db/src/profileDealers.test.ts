/**
 * L1 unit tests — the dealership-exclusivity DB backstop on `profile_dealers`.
 *
 * Two constraints are proven against a real (in-memory) better-sqlite3 table
 * built from the SAME DDL the 0003 migration emits:
 *
 *   (a) uq_profile_dealers_bound_dealer — a PARTIAL UNIQUE INDEX on dealer_id
 *       WHERE status = 'bound'. At most ONE row per dealer_id may be 'bound'
 *       across all search profiles (the exclusivity backstop). A second profile
 *       trying to bind the same dealer fails with a UNIQUE constraint error.
 *       Because the index is PARTIAL, multiple non-'bound' rows (candidate /
 *       closed_out) for the same dealer are still allowed.
 *
 *   (b) ck_profile_dealers_status — a CHECK enum. status must be one of
 *       candidate / bound / excluded_conflict / closed_out; anything else
 *       (e.g. 'garbage') fails the CHECK on insert.
 *
 * ISOLATION: a fresh in-memory DB per test (":memory:"); nothing on disk, never
 * touches ~/.autobroker-ts or ~/.autobroker.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Mirrors drizzle/0003_salty_jocasta.sql's recreated table shape: composite PK,
// the status CHECK enum, the dealer index, and the partial-unique bound index.
const CREATE_PROFILE_DEALERS = `
  CREATE TABLE profile_dealers (
    search_profile_id text NOT NULL,
    dealer_id text NOT NULL,
    status text DEFAULT 'candidate' NOT NULL,
    bound_at numeric DEFAULT (CURRENT_TIMESTAMP),
    exclusion_reason text,
    PRIMARY KEY (search_profile_id, dealer_id),
    CONSTRAINT "ck_profile_dealers_status" CHECK(status IN ('candidate', 'bound', 'excluded_conflict', 'closed_out'))
  );
  CREATE INDEX idx_profile_dealers_dealer ON profile_dealers (dealer_id);
  CREATE UNIQUE INDEX uq_profile_dealers_bound_dealer ON profile_dealers (dealer_id) WHERE status = 'bound';
`;

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(CREATE_PROFILE_DEALERS);
});

afterEach(() => {
  db.close();
});

const insert = (db_: Database.Database) =>
  db_.prepare(
    "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, ?)",
  );

describe("uq_profile_dealers_bound_dealer — at most one 'bound' row per dealer", () => {
  it("rejects a SECOND profile binding the same dealer (UNIQUE constraint)", () => {
    insert(db).run("profile-A", "dealer-1", "bound");
    expect(() => insert(db).run("profile-B", "dealer-1", "bound")).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it("rejects UPDATE-ing a second dealer row to 'bound' when one is already bound", () => {
    insert(db).run("profile-A", "dealer-1", "bound");
    insert(db).run("profile-B", "dealer-1", "candidate"); // allowed: not 'bound'
    expect(() =>
      db
        .prepare(
          "UPDATE profile_dealers SET status = 'bound' WHERE search_profile_id = ? AND dealer_id = ?",
        )
        .run("profile-B", "dealer-1"),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("allows multiple NON-bound rows for the same dealer (partial index)", () => {
    insert(db).run("profile-A", "dealer-1", "candidate");
    insert(db).run("profile-B", "dealer-1", "candidate");
    insert(db).run("profile-C", "dealer-1", "closed_out");
    const n = db
      .prepare("SELECT COUNT(*) AS c FROM profile_dealers WHERE dealer_id = ?")
      .get("dealer-1") as { c: number };
    expect(n.c).toBe(3);
  });
});

describe("ck_profile_dealers_status — status enum CHECK", () => {
  it("rejects an out-of-enum status ('garbage') with a CHECK constraint error", () => {
    expect(() => insert(db).run("profile-A", "dealer-1", "garbage")).toThrow(
      /CHECK constraint failed/,
    );
  });

  it("accepts every legal enum value", () => {
    for (const status of ["candidate", "bound", "excluded_conflict", "closed_out"]) {
      // distinct dealer per status so the partial-unique 'bound' index never trips here
      expect(() => insert(db).run("profile-A", `dealer-${status}`, status)).not.toThrow();
    }
  });
});
