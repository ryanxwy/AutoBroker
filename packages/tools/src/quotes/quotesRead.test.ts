/**
 * L1 DB tests — the quote read helpers. Freezes:
 *   - the four-predicate --recent filter (succeeded extraction + unaudited at
 *     pass + last-7-days/undated) vs the unfiltered all-quotes mode;
 *   - peer read returns the full profile slice (not recent-filtered);
 *   - incentive slice is (make,model,zip)-exact;
 *   - *_json columns parse defensively into arrays; money maps to float dollars.
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

import {
  getQuote,
  listIncentivesSlice,
  listPeerQuotes,
  listQuotesForProfile,
} from "./quotesRead.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

const PROFILE = "p-1";

function insertProfile(id: string): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, brand, status) VALUES (?, 2026, 'Hyundai', 'Tucson', 'Hyundai', 'active')",
    )
    .run(id);
}

function insertMessage(messageId: string, extractionStatus: "pending" | "succeeded" | "failed"): void {
  // The status↔intent CHECK requires intent NON-NULL only for 'succeeded'.
  const intent = extractionStatus === "succeeded" ? "quote" : null;
  db.$client
    .prepare(
      "INSERT INTO messages (message_id, direction, quote_extraction_status, quote_extraction_intent) VALUES (?, 'inbound', ?, ?)",
    )
    .run(messageId, extractionStatus, intent);
}

interface QuoteSeed {
  quoteId: string;
  messageId: string;
  profileId?: string;
  financingMode?: string;
  receivedAt?: string | null;
  sellingPrice?: number | null;
  docFee?: number | null;
  salesTax?: number | null;
  otdTotal?: number | null;
  financeApr?: number | null;
  otherFeesJson?: string | null;
}

function insertQuote(s: QuoteSeed): void {
  db.$client
    .prepare(
      "INSERT INTO dealer_quotes " +
        "(quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, " +
        " financing_mode, selling_price, doc_fee, sales_tax, otd_total, finance_apr, " +
        " other_fees_json, quote_received_at) " +
        "VALUES (?, 'd-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      s.quoteId,
      s.messageId,
      s.messageId,
      s.profileId ?? PROFILE,
      s.financingMode ?? "finance",
      s.sellingPrice ?? null,
      s.docFee ?? null,
      s.salesTax ?? null,
      s.otdTotal ?? null,
      s.financeApr ?? null,
      s.otherFeesJson ?? null,
      s.receivedAt === undefined ? null : s.receivedAt,
    );
}

function insertAudit(quoteId: string, passVersion: string): void {
  db.$client
    .prepare(
      "INSERT INTO quote_audits (dealer_quote_id, search_profile_id, flags_json, audited_at, audit_pass_version) VALUES (?, ?, '[]', '2026-06-14 00:00:00', ?)",
    )
    .run(quoteId, PROFILE, passVersion);
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-quotesread-"));
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
  db.$client.prepare("DELETE FROM manufacturer_incentives").run();
  db.$client.prepare("DELETE FROM search_profiles").run();
  insertProfile(PROFILE);
});

describe("listQuotesForProfile (no recent)", () => {
  it("returns every quote on the profile regardless of extraction/recency", () => {
    insertMessage("m-1", "pending");
    insertMessage("m-2", "succeeded");
    insertQuote({ quoteId: "q-1", messageId: "m-1", receivedAt: "2000-01-01 00:00:00" });
    insertQuote({ quoteId: "q-2", messageId: "m-2" });
    const rows = listQuotesForProfile(db, PROFILE);
    expect(rows.map((r) => r.quote_id).sort()).toEqual(["q-1", "q-2"]);
  });

  it("maps money to float dollars and parses *_json into arrays", () => {
    insertMessage("m-1", "succeeded");
    insertQuote({
      quoteId: "q-1",
      messageId: "m-1",
      sellingPrice: 40000,
      docFee: 85,
      salesTax: 3000,
      otdTotal: 43085,
      otherFeesJson: JSON.stringify([{ name: "Etch", amount: 299 }]),
    });
    const [row] = listQuotesForProfile(db, PROFILE);
    expect(row!.selling_price).toBe(40000);
    expect(row!.otd_total).toBe(43085);
    expect(row!.other_fees_json).toEqual([{ name: "Etch", amount: 299 }]);
    expect(row!.add_ons_json).toEqual([]); // null column → []
  });
});

describe("listQuotesForProfile (recent: 4-predicate filter)", () => {
  it("includes only succeeded + unaudited-at-pass + recent quotes", () => {
    const nowish = "2026-06-14 00:00:00";
    insertMessage("m-ok", "succeeded");
    insertMessage("m-pending", "succeeded");
    insertMessage("m-audited", "succeeded");
    insertMessage("m-stale", "succeeded");
    insertMessage("m-failed", "failed");

    insertQuote({ quoteId: "q-ok", messageId: "m-ok", receivedAt: nowish });
    // already audited at v1 → excluded by the anti-join
    insertQuote({ quoteId: "q-audited", messageId: "m-audited", receivedAt: nowish });
    insertAudit("q-audited", "v1");
    // older than 7 days → excluded by recency
    insertQuote({ quoteId: "q-stale", messageId: "m-stale", receivedAt: "2000-01-01 00:00:00" });
    // failed extraction → excluded by the succeeded predicate
    insertQuote({ quoteId: "q-failed", messageId: "m-failed", receivedAt: nowish });
    // undated → recency predicate passes (NULL OR >= ...)
    insertQuote({ quoteId: "q-undated", messageId: "m-pending", receivedAt: null });

    const rows = listQuotesForProfile(db, PROFILE, { recent: true });
    expect(rows.map((r) => r.quote_id).sort()).toEqual(["q-ok", "q-undated"]);
  });

  it("treats a quote already audited at a DIFFERENT pass as still unaudited at v1", () => {
    insertMessage("m-1", "succeeded");
    insertQuote({ quoteId: "q-1", messageId: "m-1", receivedAt: "2026-06-14 00:00:00" });
    insertAudit("q-1", "v2"); // audited at v2, not v1
    const rows = listQuotesForProfile(db, PROFILE, { recent: true, passVersion: "v1" });
    expect(rows.map((r) => r.quote_id)).toEqual(["q-1"]);
  });
});

describe("getQuote", () => {
  it("reads one quote by id, null when absent", () => {
    insertMessage("m-1", "succeeded");
    insertQuote({ quoteId: "q-1", messageId: "m-1", financeApr: 6.9 });
    expect(getQuote(db, "q-1")!.finance_apr).toBe(6.9);
    expect(getQuote(db, "missing")).toBeNull();
  });
});

describe("listPeerQuotes", () => {
  it("returns the full profile slice (not recent-filtered)", () => {
    insertMessage("m-1", "pending");
    insertMessage("m-2", "succeeded");
    insertQuote({ quoteId: "q-1", messageId: "m-1", receivedAt: "2000-01-01 00:00:00" });
    insertQuote({ quoteId: "q-2", messageId: "m-2" });
    const peers = listPeerQuotes(db, PROFILE);
    expect(peers.map((r) => r.quote_id).sort()).toEqual(["q-1", "q-2"]);
  });
});

describe("listIncentivesSlice", () => {
  it("returns only the (make,model,zip)-exact slice", () => {
    db.$client
      .prepare(
        "INSERT INTO manufacturer_incentives (make, model, zip, type, amount, eligibility, scraped_at, scrape_source_url) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run("Hyundai", "Tucson", "92614", "customer_cash", 1500, "all", "2026-06-14 00:00:00", "https://x");
    db.$client
      .prepare(
        "INSERT INTO manufacturer_incentives (make, model, zip, type, amount, eligibility, scraped_at, scrape_source_url) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run("Hyundai", "Elantra", "92614", "loyalty", 500, "current_brand_owner", "2026-06-14 00:00:00", "https://y");

    const slice = listIncentivesSlice(db, "Hyundai", "Tucson", "92614");
    expect(slice).toHaveLength(1);
    expect(slice[0]).toEqual({ make: "Hyundai", eligibility: "all", type: "customer_cash", amount: 1500 });
  });

  it("matches make/model case-insensitively (zip stays exact)", () => {
    db.$client
      .prepare(
        "INSERT INTO manufacturer_incentives (make, model, zip, type, amount, eligibility, scraped_at, scrape_source_url) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run("HYUNDAI", "tucson", "92614", "customer_cash", 1500, "all", "2026-06-14 00:00:00", "https://x");

    // Off-canonical query casing still resolves the slice (a lowercased profile
    // make or an upcased scraped row must not silently drop a MISSING_REBATE).
    const slice = listIncentivesSlice(db, "hyundai", "Tucson", "92614");
    expect(slice).toHaveLength(1);
    expect(slice[0]?.type).toBe("customer_cash");

    // zip is NOT case-folded — a different zip returns nothing.
    expect(listIncentivesSlice(db, "Hyundai", "Tucson", "90000")).toHaveLength(0);
  });
});
