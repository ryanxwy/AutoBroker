/**
 * L1 unit tests — persistMessageQuotes, the all-or-nothing per-message upsert +
 * mark-processed state machine. Freezes:
 *   - full success → rows upserted, message succeeded (intent NOT NULL,
 *     processed_at stamped) — CHECK-constraint-valid;
 *   - zero-row success → message succeeded with intent + 0 quote rows;
 *   - one bad row rolls back the WHOLE message → 0 quote rows + status failed +
 *     processed_at NULL (re-queued), intent NULL;
 *   - idempotent re-extract → UPDATE in place PRESERVING quote_id;
 *   - a finance + a lease row coexist under UNIQUE(source_gmail_message_id,
 *     financing_mode);
 *   - JSON-array fields are JSON-stringified into their TEXT columns.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; the committed
 * migrations run against the throwaway DB. NEVER touches ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DealerReplyQuoteRow } from "@autobroker/core";

import { closeDb, openDb, type Db } from "../db.js";
import { persistMessageQuotes, type MessageProvenance } from "./persist.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = [
  "0000_military_red_skull.sql",
  "0001_redundant_ozymandias.sql",
  "0002_pale_thunderball.sql",
].map((f) => join(here, "..", "..", "..", "db", "drizzle", f));

const PROFILE_ID = "prof-extract-1";
const DEALER_A = "dealer-aaaa";
const THREAD_ID = "t-1";
const MSG_ID = "m-1";
const GMAIL_MSG_ID = "g-m-1";

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-reply-persist-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
  // Seed the dealer + thread + the inbound message E1 would have written.
  db.$client.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')").run(
    DEALER_A,
    "Example Hyundai",
  );
  db.$client
    .prepare("INSERT INTO threads (thread_id, dealer_id, search_profile_id) VALUES (?, ?, ?)")
    .run(THREAD_ID, DEALER_A, PROFILE_ID);
  db.$client
    .prepare(
      "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, " +
        "search_profile_id, quote_extraction_status) VALUES (?, ?, ?, 'inbound', ?, 'pending')",
    )
    .run(MSG_ID, THREAD_ID, GMAIL_MSG_ID, PROFILE_ID);
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

function provenance(over: Partial<MessageProvenance> = {}): MessageProvenance {
  return {
    messageId: MSG_ID,
    sourceGmailMessageId: GMAIL_MSG_ID,
    searchProfileId: PROFILE_ID,
    dealerId: DEALER_A,
    extractorProvider: "deepseek",
    extractionMethod: "text",
    intent: "real_quote",
    ...over,
  };
}

/** A fully-null extractable row at the given mode (extend with overrides). */
function row(over: Partial<DealerReplyQuoteRow> = {}): DealerReplyQuoteRow {
  return {
    financing_mode: "cash",
    vin: null,
    inventory_status: null,
    source_listing_id: null,
    quote_format: null,
    intent: null,
    confidence: null,
    quote_received_at: null,
    quote_expires_at: null,
    msrp: null,
    selling_price: null,
    dealer_discount: null,
    doc_fee: null,
    dealer_fee: null,
    sales_tax: null,
    dmv_fees: null,
    title_fee: null,
    registration_fee: null,
    license_fee: null,
    otd_total: null,
    rebates_json: null,
    other_fees_json: null,
    add_ons_json: null,
    taxable_rebates_json: null,
    finance_apr: null,
    finance_term_months: null,
    finance_down_payment: null,
    finance_monthly_payment: null,
    finance_amount_financed: null,
    lease_term_months: null,
    lease_money_factor: null,
    lease_residual_pct: null,
    lease_residual_value: null,
    lease_due_at_signing: null,
    lease_monthly_payment: null,
    lease_miles_per_year: null,
    lease_acquisition_fee: null,
    lease_disposition_fee: null,
    lease_cap_cost_gross: null,
    lease_cap_cost_adjusted: null,
    lease_rent_charge: null,
    ...over,
  };
}

function quoteRows(): Array<Record<string, unknown>> {
  return db.$client
    .prepare("SELECT * FROM dealer_quotes ORDER BY financing_mode")
    .all() as Array<Record<string, unknown>>;
}

function messageRow(): Record<string, unknown> {
  return db.$client
    .prepare("SELECT * FROM messages WHERE message_id = ?")
    .get(MSG_ID) as Record<string, unknown>;
}

describe("persistMessageQuotes — success", () => {
  it("upserts a row and marks the message succeeded (intent + processed_at)", () => {
    const res = persistMessageQuotes({
      provenance: provenance(),
      rows: [row({ financing_mode: "cash", selling_price: 33995, otd_total: 38120 })],
      db,
      now: "2026-06-14T00:00:00.000Z",
    });
    expect(res).toEqual({ ok: true, status: "succeeded", rowsUpserted: 1 });

    const quotes = quoteRows();
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.selling_price).toBe(33995);
    expect(quotes[0]!.otd_total).toBe(38120);
    expect(quotes[0]!.financing_mode).toBe("cash");
    expect(quotes[0]!.dealer_id).toBe(DEALER_A);
    expect(quotes[0]!.search_profile_id).toBe(PROFILE_ID);
    expect(quotes[0]!.extractor_provider).toBe("deepseek");
    expect(quotes[0]!.extraction_method).toBe("text");

    const msg = messageRow();
    expect(msg.quote_extraction_status).toBe("succeeded");
    expect(msg.quote_extraction_intent).toBe("real_quote");
    expect(msg.processed_at).toBe("2026-06-14T00:00:00.000Z");
  });

  it("a zero-row message still succeeds with an intent (no_quote → 0 rows)", () => {
    const res = persistMessageQuotes({
      provenance: provenance({ intent: "auto_reply" }),
      rows: [],
      db,
    });
    expect(res).toEqual({ ok: true, status: "succeeded", rowsUpserted: 0 });
    expect(quoteRows()).toHaveLength(0);
    const msg = messageRow();
    expect(msg.quote_extraction_status).toBe("succeeded");
    expect(msg.quote_extraction_intent).toBe("auto_reply");
    expect(msg.processed_at).not.toBeNull();
  });

  it("JSON-array fields are stringified into their TEXT columns", () => {
    persistMessageQuotes({
      provenance: provenance(),
      rows: [
        row({
          financing_mode: "cash",
          rebates_json: [{ label: "loyalty", amount: 500 }],
        }),
      ],
      db,
    });
    const stored = quoteRows()[0]!.rebates_json as string;
    expect(JSON.parse(stored)).toEqual([{ label: "loyalty", amount: 500 }]);
  });

  it("a finance + a lease row coexist under the UNIQUE key", () => {
    const res = persistMessageQuotes({
      provenance: provenance(),
      rows: [
        row({ financing_mode: "finance", finance_apr: 3.9, finance_term_months: 60 }),
        row({ financing_mode: "lease", lease_term_months: 36, lease_money_factor: 0.0015 }),
      ],
      db,
    });
    expect(res.ok).toBe(true);
    const quotes = quoteRows();
    expect(quotes).toHaveLength(2);
    expect(quotes.map((q) => q.financing_mode)).toEqual(["finance", "lease"]);
  });
});

describe("persistMessageQuotes — all-or-nothing failure", () => {
  it("one bad row rolls back the WHOLE message → 0 rows + status failed (re-queued)", () => {
    const res = persistMessageQuotes({
      provenance: provenance(),
      rows: [
        row({ financing_mode: "cash", otd_total: 38120 }),
        // Rule 1 bleed: cash carrying a finance field → invalid → whole batch fails.
        row({ financing_mode: "cash", finance_apr: 3.9 }),
      ],
      db,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe("failed");

    expect(quoteRows()).toHaveLength(0); // nothing written

    const msg = messageRow();
    expect(msg.quote_extraction_status).toBe("failed");
    expect(msg.quote_extraction_intent).toBeNull();
    expect(msg.processed_at).toBeNull(); // re-queued
  });
});

describe("persistMessageQuotes — idempotent re-extract", () => {
  it("re-run UPDATEs in place preserving quote_id", () => {
    const first = persistMessageQuotes({
      provenance: provenance(),
      rows: [row({ financing_mode: "cash", otd_total: 38120 })],
      db,
      now: "2026-06-14T00:00:00.000Z",
    });
    expect(first.ok).toBe(true);
    const firstQuoteId = quoteRows()[0]!.quote_id as string;

    // Re-extract the same (gmail message, financing mode) with a refined number.
    const second = persistMessageQuotes({
      provenance: provenance(),
      rows: [row({ financing_mode: "cash", otd_total: 37999, selling_price: 33500 })],
      db,
      now: "2026-06-14T01:00:00.000Z",
    });
    expect(second).toEqual({ ok: true, status: "succeeded", rowsUpserted: 1 });

    const quotes = quoteRows();
    expect(quotes).toHaveLength(1); // UPDATE, not a second row
    expect(quotes[0]!.quote_id).toBe(firstQuoteId); // preserved
    expect(quotes[0]!.otd_total).toBe(37999); // refreshed
    expect(quotes[0]!.selling_price).toBe(33500);
  });
});
