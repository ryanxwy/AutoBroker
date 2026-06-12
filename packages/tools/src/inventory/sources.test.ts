/**
 * L1 unit tests — the dealer_inventory_sources loader + seeder. Freezes:
 *   - seedInventorySource mints the FROZEN parity id (computeSourceId over
 *     urlNormalize) and is idempotent — a re-seed (even via a differently-
 *     cased / differently-ordered-query variant of the same URL) never
 *     duplicates and never resets the existing row;
 *   - listPendingSources returns ONLY last_status='pending' rows, joined with
 *     the dealer fields the US gate + the review card need, oldest first;
 *   - the persist writer's status mark on the SAME id takes a seeded row out
 *     of the pending set (the loader/writer converge on one id space).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved /
 * restored); committed migrations applied. NEVER ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, openDb, type Db } from "@autobroker/db";

import { persistScanResults } from "./persist.js";
import { computeSourceId, urlNormalize } from "./pure.js";
import { listPendingSources, seedInventorySource } from "./sources.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

const PROFILE_ID = "profile-link-1";
const DEALER_A = "aaaa111122223333";
const DEALER_B = "bbbb444455556666";
const URL_A = "https://www.tustinhyundai.com/new-inventory/index.htm?model=Tucson&make=Hyundai";
/** The same URL as URL_A under urlNormalize (case + query order). */
const URL_A_VARIANT = "https://WWW.TustinHyundai.com/new-inventory/index.htm?make=Hyundai&model=Tucson";
const URL_B = "https://www.beta-hyundai.example/new/";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-linksrc-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  db.$client
    .prepare(
      "INSERT INTO dealers (dealer_id, name, website, country, state, postal_code, city) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(DEALER_A, "Tustin Hyundai", "https://www.tustinhyundai.com", "US", "CA", "92782", "Tustin");
  db.$client
    .prepare("INSERT INTO dealers (dealer_id, name, website, country) VALUES (?, ?, ?, ?)")
    .run(DEALER_B, "Beta Hyundai", "https://www.beta-hyundai.example", "US");
});

afterAll(() => {
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

describe("seedInventorySource + listPendingSources", () => {
  it("mints the frozen parity id and defaults type/method to manual", () => {
    const seeded = seedInventorySource({
      searchProfileId: PROFILE_ID,
      dealerId: DEALER_A,
      sourceUrl: URL_A,
      db,
      now: "2026-06-12T01:00:00.000Z",
    });
    expect(seeded.inserted).toBe(true);
    expect(seeded.normalizedUrl).toBe(urlNormalize(URL_A));
    expect(seeded.sourceId).toBe(computeSourceId(PROFILE_ID, DEALER_A, urlNormalize(URL_A)));
    expect(seeded.sourceId.startsWith("src_")).toBe(true);

    const pending = listPendingSources(db, PROFILE_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      sourceId: seeded.sourceId,
      dealerId: DEALER_A,
      dealerName: "Tustin Hyundai",
      sourceUrl: URL_A,
      normalizedUrl: urlNormalize(URL_A),
      sourceType: "manual",
      website: "https://www.tustinhyundai.com",
      country: "US",
      state: "CA",
      postalCode: "92782",
      city: "Tustin",
    });
  });

  it("re-seeding the same URL (even a normalize-equal variant) is a no-op", () => {
    const again = seedInventorySource({
      searchProfileId: PROFILE_ID,
      dealerId: DEALER_A,
      sourceUrl: URL_A_VARIANT,
      db,
    });
    expect(again.inserted).toBe(false);
    expect(again.sourceId).toBe(computeSourceId(PROFILE_ID, DEALER_A, urlNormalize(URL_A)));
    expect(listPendingSources(db, PROFILE_ID)).toHaveLength(1);
    // The original row survives untouched (source_url stays the FIRST seed's).
    expect(listPendingSources(db, PROFILE_ID)[0]!.sourceUrl).toBe(URL_A);
  });

  it("orders oldest-seeded first and scopes to the profile + pending status", () => {
    seedInventorySource({
      searchProfileId: PROFILE_ID,
      dealerId: DEALER_B,
      sourceUrl: URL_B,
      sourceType: "reply_link",
      discoveryMethod: "reply_extract",
      db,
    });
    // another profile's row is invisible to this profile's read.
    seedInventorySource({
      searchProfileId: "profile-other",
      dealerId: DEALER_B,
      sourceUrl: "https://www.beta-hyundai.example/other",
      db,
    });
    const pending = listPendingSources(db, PROFILE_ID);
    expect(pending.map((p) => p.dealerId)).toEqual([DEALER_A, DEALER_B]);
    expect(pending[1]).toMatchObject({ sourceType: "reply_link", dealerName: "Beta Hyundai" });
    expect(listPendingSources(db, "profile-other")).toHaveLength(1);
  });

  it("the persist writer's status mark on the SAME id removes the row from pending", () => {
    // Mark the URL_A source scanned through the shared writer — the loader and
    // the writer must converge on one id for the same (profile, dealer, url).
    persistScanResults({
      searchProfileId: PROFILE_ID,
      runStartedAt: "2026-06-12T02:00:00.000Z",
      outcomes: [{ dealerId: DEALER_A, sourceUrl: URL_A, status: "scanned", rows: [] }],
      db,
    });
    const pending = listPendingSources(db, PROFILE_ID);
    expect(pending.map((p) => p.dealerId)).toEqual([DEALER_B]);

    const row = db.$client
      .prepare("SELECT last_status FROM dealer_inventory_sources WHERE source_id = ?")
      .get(computeSourceId(PROFILE_ID, DEALER_A, urlNormalize(URL_A))) as {
      last_status: string;
    };
    expect(row.last_status).toBe("scanned");
  });
});
