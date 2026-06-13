/**
 * seedDemo unit — freezes the demo seed's contract:
 *   - seeds a renderable world (2 active profiles on distinct brands, the first
 *     with 2 bound dealers) into a fresh DB;
 *   - is IDEMPOTENT: a second call on a non-empty DB writes nothing and reports
 *     the skip;
 *   - creates a local account when the DB has none, and reuses an existing one.
 *
 * ISOLATION: a throwaway os.tmpdir() DB with the committed migrations applied —
 * never the real data dir.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "@autobroker/db";

import { seedDemoData } from "./seedDemo.js";

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE = join(here, "..", "..", "..", "db", "drizzle");

/** Apply the committed migration set in journal order to the throwaway DB. */
function migrate(db: Db): void {
  const journal = JSON.parse(
    readFileSync(join(DRIZZLE, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  for (const e of journal.entries) {
    db.$client.exec(readFileSync(join(DRIZZLE, `${e.tag}.sql`), "utf8"));
  }
}

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-demo-seed-"));
  db = openDb(join(tmpDir, "autobroker.db"));
  migrate(db);
});

afterEach(() => {
  db.$client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function count(table: string): number {
  return (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("seedDemoData", () => {
  it("seeds 2 active profiles on distinct brands + 2 bound dealers + an account", () => {
    const wrote = seedDemoData(db);
    expect(wrote).toBe(true);

    const profiles = db.$client
      .prepare("SELECT brand, status FROM search_profiles ORDER BY brand")
      .all() as Array<{ brand: string; status: string }>;
    expect(profiles).toHaveLength(2);
    expect(profiles.every((p) => p.status === "active")).toBe(true);
    expect(new Set(profiles.map((p) => p.brand))).toEqual(new Set(["Hyundai", "Toyota"]));

    expect(count("dealers")).toBe(2);
    expect(count("profile_dealers")).toBe(2);
    expect(count("accounts")).toBe(1);
    // both active profiles share the one account namespace (the active-slot key).
    const accounts = db.$client
      .prepare("SELECT DISTINCT account_id FROM search_profiles")
      .all() as Array<{ account_id: string }>;
    expect(accounts).toHaveLength(1);
  });

  it("is idempotent: a second call on a non-empty DB writes nothing", () => {
    expect(seedDemoData(db)).toBe(true);
    const before = count("search_profiles");
    expect(seedDemoData(db)).toBe(false); // skip
    expect(count("search_profiles")).toBe(before);
    expect(count("dealers")).toBe(2); // unchanged
  });

  it("reuses an existing account instead of creating a second one", () => {
    db.$client.prepare("INSERT INTO accounts (account_id, email) VALUES (?, ?)").run("acct-local-1", "owner@localhost");
    seedDemoData(db);
    expect(count("accounts")).toBe(1); // not a second row
    const acct = (db.$client.prepare("SELECT DISTINCT account_id FROM search_profiles").get() as { account_id: string })
      .account_id;
    expect(acct).toBe("acct-local-1");
  });
});
