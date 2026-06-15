/**
 * L1 DB tests — the idempotent audit writer. Freezes:
 *   - first write inserts a row; flags_json holds the serialized findings;
 *   - re-running the same (quote, pass) UPDATEs in place (Δ row count = 0)
 *     and overwrites flags_json + audited_at;
 *   - a different pass version writes a SECOND row alongside the first.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; the committed
 * migration SQL runs against the throwaway DB. Never touches a real data dir.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/db";
import type { AuditFinding } from "@autobroker/core";

import { upsertAudit } from "./auditPersist.js";
import { flagCodesFromJson } from "./flags.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

const PROFILE = "p-1";
const QUOTE = "q-1";

function seedQuote(): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, brand, status) VALUES (?, 2026, 'Hyundai', 'Tucson', 'Hyundai', 'active')",
    )
    .run(PROFILE);
  db.$client
    .prepare("INSERT INTO messages (message_id, direction) VALUES ('m-1', 'inbound')")
    .run();
  db.$client
    .prepare(
      "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, financing_mode) VALUES (?, 'd-1', 'm-1', 'm-1', ?, 'finance')",
    )
    .run(QUOTE, PROFILE);
}

function countAudits(): number {
  return (db.$client.prepare("SELECT COUNT(*) AS n FROM quote_audits").get() as { n: number }).n;
}

function flagsJsonFor(quoteId: string, passVersion: string): string {
  return (
    db.$client
      .prepare("SELECT flags_json FROM quote_audits WHERE dealer_quote_id = ? AND audit_pass_version = ?")
      .get(quoteId, passVersion) as { flags_json: string }
  ).flags_json;
}

const FINDING_A: AuditFinding = { code: "APR_MARKUP", severity: "warn", text: "t", suggestion: "s" };
const FINDING_B: AuditFinding = { code: "MISSING_BREAKDOWN", severity: "info", text: "t2", suggestion: "s2" };

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-auditpersist-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
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
  db.$client.prepare("DELETE FROM quote_audits").run();
  db.$client.prepare("DELETE FROM dealer_quotes").run();
  db.$client.prepare("DELETE FROM messages").run();
  db.$client.prepare("DELETE FROM search_profiles").run();
  seedQuote();
});

describe("upsertAudit", () => {
  it("inserts a new row and serializes flags into flags_json", () => {
    const outcome = upsertAudit(db, {
      dealer_quote_id: QUOTE,
      search_profile_id: PROFILE,
      flags: [FINDING_A, FINDING_B],
      audited_at: "2026-06-14 00:00:00",
    });
    expect(outcome).toBe("inserted");
    expect(countAudits()).toBe(1);
    expect(flagCodesFromJson(flagsJsonFor(QUOTE, "v1"))).toEqual(["APR_MARKUP", "MISSING_BREAKDOWN"]);
  });

  it("is idempotent — re-running the same pass UPDATEs in place (row count unchanged, Δ=0)", () => {
    upsertAudit(db, { dealer_quote_id: QUOTE, search_profile_id: PROFILE, flags: [FINDING_A], audited_at: "2026-06-14 00:00:00" });
    const before = countAudits();
    const outcome = upsertAudit(db, {
      dealer_quote_id: QUOTE,
      search_profile_id: PROFILE,
      flags: [FINDING_A, FINDING_B],
      audited_at: "2026-06-15 00:00:00",
    });
    expect(outcome).toBe("updated");
    expect(countAudits()).toBe(before); // Δ = 0
    // flags_json + audited_at overwritten with the new pass result
    expect(flagCodesFromJson(flagsJsonFor(QUOTE, "v1"))).toEqual(["APR_MARKUP", "MISSING_BREAKDOWN"]);
    const auditedAt = (
      db.$client.prepare("SELECT audited_at FROM quote_audits WHERE dealer_quote_id = ?").get(QUOTE) as {
        audited_at: string;
      }
    ).audited_at;
    expect(auditedAt).toBe("2026-06-15 00:00:00");
  });

  it("writes a SECOND row for a different pass version", () => {
    upsertAudit(db, { dealer_quote_id: QUOTE, search_profile_id: PROFILE, flags: [FINDING_A], audited_at: "2026-06-14 00:00:00", audit_pass_version: "v1" });
    upsertAudit(db, { dealer_quote_id: QUOTE, search_profile_id: PROFILE, flags: [FINDING_B], audited_at: "2026-06-14 00:00:00", audit_pass_version: "v2" });
    expect(countAudits()).toBe(2);
  });
});
