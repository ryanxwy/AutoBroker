/** T1 fixed-clock tests for bounded automatic pipeline admission. */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/db";

import {
  PIPELINE_AUTO_ADMISSION_FLOOR_MS,
  evaluatePipelineAdmission,
  lastComparedQuotesKey,
  pipelineAdmissionKey,
  readLastComparedQuoteInput,
  readPipelineInputWatermark,
  readQuoteInputWatermark,
  writeLastComparedQuoteInput,
  writePipelineAdmission,
} from "./admissionWatermark.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];
const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");
const PROFILE = "admission-profile";
const NOW = Date.UTC(2026, 6, 9, 12);

let tmpDir: string;
let db: Db;

function seedBase(): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, postal_code, status) " +
        "VALUES (?, 2026, 'Hyundai', 'Tucson', '92614', 'active')",
    )
    .run(PROFILE);
  db.$client.prepare("INSERT INTO dealers (dealer_id, name) VALUES ('d1', 'Dealer')").run();
}

function seedInbound(id: string): void {
  db.$client
    .prepare(
      "INSERT INTO messages (message_id, direction, search_profile_id, quote_extraction_status, received_at) " +
        "VALUES (?, 'inbound', ?, 'pending', ?)",
    )
    .run(id, PROFILE, NOW);
}

function seedQuote(id: string): void {
  db.$client
    .prepare(
      "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, " +
        "search_profile_id, financing_mode) VALUES (?, 'd1', ?, ?, ?, 'cash')",
    )
    .run(id, `m-${id}`, `g-${id}`, PROFILE);
}

function persist(decision: ReturnType<typeof evaluatePipelineAdmission>): void {
  writePipelineAdmission({
    db,
    profileId: PROFILE,
    admittedAtMs: decision.evaluatedAtMs,
    observedInput: decision.observedInput,
  });
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-admission-wm-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
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

beforeEach(() => {
  for (const table of ["dealer_quotes", "messages", "dealers", "search_profiles", "pipeline_state"]) {
    db.$client.prepare(`DELETE FROM ${table}`).run();
  }
  seedBase();
});

describe("automatic pipeline admission", () => {
  it("admits the first run, then N identical ticks are no-ops until the six-hour floor", () => {
    const first = evaluatePipelineAdmission({ db, profileId: PROFILE, nowMs: NOW });
    expect(first).toMatchObject({ shouldAdmit: true, reason: "first_admission" });
    persist(first);

    for (let n = 1; n <= 5; n += 1) {
      expect(
        evaluatePipelineAdmission({ db, profileId: PROFILE, nowMs: NOW + n * 1_000 }),
      ).toMatchObject({ shouldAdmit: false, reason: "same_input_floor" });
    }

    expect(
      evaluatePipelineAdmission({
        db,
        profileId: PROFILE,
        nowMs: NOW + PIPELINE_AUTO_ADMISSION_FLOOR_MS,
      }),
    ).toMatchObject({ shouldAdmit: true, reason: "floor_elapsed" });
  });

  it("new inbox input bypasses the floor exactly once", () => {
    const first = evaluatePipelineAdmission({ db, profileId: PROFILE, nowMs: NOW });
    persist(first);
    seedInbound("in-1");

    const changed = evaluatePipelineAdmission({ db, profileId: PROFILE, nowMs: NOW + 1_000 });
    expect(changed).toMatchObject({ shouldAdmit: true, reason: "new_input" });
    persist(changed);
    expect(
      evaluatePipelineAdmission({ db, profileId: PROFILE, nowMs: NOW + 2_000 }),
    ).toMatchObject({ shouldAdmit: false, reason: "same_input_floor" });
  });

  it("a changed quote set bypasses the floor exactly once", () => {
    seedQuote("q1");
    const first = evaluatePipelineAdmission({ db, profileId: PROFILE, nowMs: NOW });
    persist(first);
    seedQuote("q2");

    const changed = evaluatePipelineAdmission({ db, profileId: PROFILE, nowMs: NOW + 1_000 });
    expect(changed).toMatchObject({ shouldAdmit: true, reason: "new_input" });
    expect(changed.observedInput.quoteCount).toBe(2);
    persist(changed);
    expect(
      evaluatePipelineAdmission({ db, profileId: PROFILE, nowMs: NOW + 2_000 }),
    ).toMatchObject({ shouldAdmit: false, reason: "same_input_floor" });
  });

  it("detects quote replacement even when SQLite reuses the same max rowid", () => {
    seedQuote("q1");
    seedQuote("q2");
    const first = evaluatePipelineAdmission({ db, profileId: PROFILE, nowMs: NOW });
    persist(first);
    const before = first.observedInput;

    db.$client.prepare("DELETE FROM dealer_quotes WHERE quote_id = 'q2'").run();
    seedQuote("q3");
    const after = evaluatePipelineAdmission({ db, profileId: PROFILE, nowMs: NOW + 1_000 });

    expect(after.observedInput.quoteCount).toBe(before.quoteCount);
    expect(after.observedInput.maxQuoteRowid).toBe(before.maxQuoteRowid);
    expect(after.observedInput.quoteSetHash).not.toBe(before.quoteSetHash);
    expect(after).toMatchObject({ shouldAdmit: true, reason: "new_input" });
  });

  it("stores admission and compare progress in separate keyspaces", () => {
    seedQuote("q1");
    seedQuote("q2");
    const decision = evaluatePipelineAdmission({ db, profileId: PROFILE, nowMs: NOW });
    persist(decision);
    const quoteInput = readQuoteInputWatermark(db, PROFILE);
    writeLastComparedQuoteInput(db, PROFILE, quoteInput);

    expect(readLastComparedQuoteInput(db, PROFILE)).toEqual(quoteInput);
    expect(readPipelineInputWatermark(db, PROFILE)).toMatchObject(quoteInput);
    expect(pipelineAdmissionKey(PROFILE)).not.toBe(lastComparedQuotesKey(PROFILE));
    const keys = db.$client
      .prepare("SELECT key FROM pipeline_state WHERE search_profile_id = ? ORDER BY key")
      .all(PROFILE) as Array<{ key: string }>;
    expect(keys.map((row) => row.key)).toEqual(
      [pipelineAdmissionKey(PROFILE), lastComparedQuotesKey(PROFILE)].sort(),
    );
  });
});
