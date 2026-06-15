/**
 * L1 unit tests — the quote_pipeline deterministic tools. Freezes:
 *   - each of the 4 detectPipelineState predicates TRUE and FALSE, incl. the
 *     7-day scrape-cache window EDGE (exactly-7d fresh / just-over-7d stale)
 *     and the audit_pass_version boundary (audited@v1 not re-flagged at v1, IS
 *     flagged at v2);
 *   - resolveTargetedListing: throws on a missing listing / no inbound thread;
 *     sets reusesProcessedInbound from a processed inbound; NEVER mutates
 *     processed_at (asserted by re-reading the row);
 *   - buildOtdInjection: stock clause present vs omitted-on-null-stock; RAISES
 *     on null/empty VIN;
 *   - recordQuoteFromListing: inserts one row with source_listing_id set;
 *     idempotent replay (no duplicate); rejects a missing/synthetic message_id;
 *     resolves source_gmail_message_id from the real messages row;
 *   - computeFinalState → ok/partial/no_work; computeNextAction;
 *   - writePipelineCompletion: one row, payload_json round-trips.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; the committed
 * migration SQL runs against the throwaway DB. NEVER touches ~/.autobroker-ts
 * or ~/.autobroker.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/db";

import { detectPipelineState } from "./detectPipelineState.js";
import {
  resolveTargetedListing,
  TargetedListingNotFound,
  NoInboundThread,
} from "./resolveTargetedListing.js";
import { buildOtdInjection, MissingVinError } from "./buildOtdInjection.js";
import {
  recordQuoteFromListing,
  MessageNotFoundError,
  MissingMessageIdError,
} from "./recordQuoteFromListing.js";
import { computeFinalState, computeNextAction } from "./finalState.js";
import { writePipelineCompletion } from "./auditLogWriter.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

let tmpDir: string;
let db: Db;

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 5, 14); // 2026-06-14
const PASS_V1 = "v1";
const PASS_V2 = "v2";

const PROFILE = "prof-1";
const DEALER = "dealer-1";

// ---------------------------------------------------------------------------
// Seed helpers (raw SQL — all NOT NULL columns satisfied)
// ---------------------------------------------------------------------------

function seedProfile(id: string, make: string, model: string, zip: string): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, postal_code, status) VALUES (?,?,?,?,?,?)",
    )
    .run(id, 2026, make, model, zip, "active");
}

function seedDealer(id: string): void {
  db.$client.prepare("INSERT INTO dealers (dealer_id, name) VALUES (?, ?)").run(id, "Test Dealer");
}

function seedThread(threadId: string, dealerId: string, profileId: string | null): void {
  db.$client
    .prepare(
      "INSERT INTO threads (thread_id, dealer_id, search_profile_id, updated_at) VALUES (?,?,?,?)",
    )
    .run(threadId, dealerId, profileId, NOW_MS);
}

function seedMessage(opts: {
  messageId: string;
  threadId: string | null;
  direction: string;
  profileId: string | null;
  status?: string;
  intent?: string | null;
  gmailMessageId?: string | null;
  processedAt?: number | null;
  receivedAt?: number | null;
}): void {
  db.$client
    .prepare(
      "INSERT INTO messages (message_id, thread_id, direction, search_profile_id, quote_extraction_status, quote_extraction_intent, gmail_message_id, processed_at, received_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(
      opts.messageId,
      opts.threadId,
      opts.direction,
      opts.profileId,
      opts.status ?? "pending",
      opts.intent ?? null,
      opts.gmailMessageId ?? null,
      opts.processedAt ?? null,
      opts.receivedAt ?? NOW_MS,
    );
}

function seedIncentive(make: string, model: string, zip: string, scrapedAtMs: number): void {
  // Store scraped_at as the ISO-8601 STRING the production writer (persistIncentives
  // / the incentive_scrape workflow) actually emits — NOT a raw epoch-ms number —
  // so the 7-day freshness check is exercised against the real stored format.
  const scrapedAtIso = new Date(scrapedAtMs).toISOString();
  db.$client
    .prepare(
      "INSERT INTO manufacturer_incentives (make, model, zip, type, amount, eligibility, scraped_at, scrape_source_url) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(make, model, zip, "customer_cash", 1000, "all", scrapedAtIso, "https://example.com/offers");
}

function seedQuote(opts: {
  quoteId: string;
  profileId: string;
  dealerId?: string;
  messageId?: string;
  sourceGmailMessageId?: string;
  financingMode?: string;
}): void {
  db.$client
    .prepare(
      "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, financing_mode) VALUES (?,?,?,?,?,?)",
    )
    .run(
      opts.quoteId,
      opts.dealerId ?? DEALER,
      opts.messageId ?? "msg-q",
      opts.sourceGmailMessageId ?? `gmail-${opts.quoteId}`,
      opts.profileId,
      opts.financingMode ?? "cash",
    );
}

function seedAudit(quoteId: string, profileId: string, passVersion: string): void {
  db.$client
    .prepare(
      "INSERT INTO quote_audits (dealer_quote_id, search_profile_id, flags_json, audited_at, audit_pass_version) VALUES (?,?,?,?,?)",
    )
    .run(quoteId, profileId, "[]", NOW_MS, passVersion);
}

function seedListing(opts: {
  listingId: string;
  profileId: string;
  dealerId: string;
  vin?: string | null;
  stock?: string | null;
}): void {
  // inventory_listings has several NOT NULL cols — satisfy them with placeholders.
  db.$client
    .prepare(
      "INSERT INTO inventory_listings (listing_id, search_profile_id, dealer_id, vin, stock_number, inventory_status, match_status, raw_listing_json, first_seen_at, last_seen_at, observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      opts.listingId,
      opts.profileId,
      opts.dealerId,
      opts.vin ?? null,
      opts.stock ?? null,
      "available",
      "exact",
      "{}",
      NOW_MS,
      NOW_MS,
      NOW_MS,
    );
}

function clearAll(): void {
  for (const t of [
    "quote_audits",
    "dealer_quotes",
    "manufacturer_incentives",
    "messages",
    "inventory_listings",
    "threads",
    "dealers",
    "search_profiles",
    "audit_log",
  ]) {
    db.$client.prepare(`DELETE FROM ${t}`).run();
  }
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-pipeline-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0002_pale_thunderball.sql"), "utf8"));
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
  clearAll();
});

// ===========================================================================
// detectPipelineState — extract
// ===========================================================================

describe("detectPipelineState: extract predicate", () => {
  it("TRUE when a pending message exists for the profile", () => {
    seedProfile(PROFILE, "Hyundai", "Tucson", "92614");
    seedMessage({ messageId: "m1", threadId: null, direction: "inbound", profileId: PROFILE, status: "pending" });
    const s = detectPipelineState({ searchProfileId: PROFILE, auditPassVersion: PASS_V1, nowMs: NOW_MS, db });
    expect(s.extract).toBe(true);
  });

  it("FALSE when every message is succeeded/failed (none pending)", () => {
    seedProfile(PROFILE, "Hyundai", "Tucson", "92614");
    seedMessage({ messageId: "m1", threadId: null, direction: "inbound", profileId: PROFILE, status: "succeeded", intent: "quote" });
    seedMessage({ messageId: "m2", threadId: null, direction: "inbound", profileId: PROFILE, status: "failed" });
    const s = detectPipelineState({ searchProfileId: PROFILE, auditPassVersion: PASS_V1, nowMs: NOW_MS, db });
    expect(s.extract).toBe(false);
  });

  it("FALSE when the pending message belongs to a DIFFERENT profile", () => {
    seedProfile(PROFILE, "Hyundai", "Tucson", "92614");
    seedProfile("other", "Toyota", "RAV4", "90001");
    seedMessage({ messageId: "m1", threadId: null, direction: "inbound", profileId: "other", status: "pending" });
    const s = detectPipelineState({ searchProfileId: PROFILE, auditPassVersion: PASS_V1, nowMs: NOW_MS, db });
    expect(s.extract).toBe(false);
  });
});

// ===========================================================================
// detectPipelineState — scrape (7-day window edge)
// ===========================================================================

describe("detectPipelineState: scrape predicate + 7-day window edge", () => {
  beforeEach(() => seedProfile(PROFILE, "Hyundai", "Tucson", "92614"));

  it("TRUE when no incentive row exists for the slice", () => {
    const s = detectPipelineState({ searchProfileId: PROFILE, auditPassVersion: PASS_V1, nowMs: NOW_MS, db });
    expect(s.scrape).toBe(true);
  });

  it("FALSE when a row scraped EXACTLY 7 days ago exists (window inclusive)", () => {
    seedIncentive("Hyundai", "Tucson", "92614", NOW_MS - 7 * DAY_MS);
    const s = detectPipelineState({ searchProfileId: PROFILE, auditPassVersion: PASS_V1, nowMs: NOW_MS, db });
    expect(s.scrape).toBe(false);
  });

  it("TRUE when the newest row is just OVER 7 days old (stale)", () => {
    seedIncentive("Hyundai", "Tucson", "92614", NOW_MS - 7 * DAY_MS - 1);
    const s = detectPipelineState({ searchProfileId: PROFILE, auditPassVersion: PASS_V1, nowMs: NOW_MS, db });
    expect(s.scrape).toBe(true);
  });

  it("FALSE matching make/model case-insensitively (one logical slice)", () => {
    seedIncentive("hyundai", "tucson", "92614", NOW_MS - DAY_MS);
    const s = detectPipelineState({ searchProfileId: PROFILE, auditPassVersion: PASS_V1, nowMs: NOW_MS, db });
    expect(s.scrape).toBe(false);
  });

  it("TRUE when a fresh row exists but for a DIFFERENT zip", () => {
    seedIncentive("Hyundai", "Tucson", "90001", NOW_MS - DAY_MS);
    const s = detectPipelineState({ searchProfileId: PROFILE, auditPassVersion: PASS_V1, nowMs: NOW_MS, db });
    expect(s.scrape).toBe(true);
  });
});

// ===========================================================================
// detectPipelineState — audit (audit_pass_version boundary)
// ===========================================================================

describe("detectPipelineState: audit predicate + audit_pass_version boundary", () => {
  beforeEach(() => {
    seedProfile(PROFILE, "Hyundai", "Tucson", "92614");
    seedDealer(DEALER);
    seedQuote({ quoteId: "q1", profileId: PROFILE });
  });

  it("TRUE when a quote has no audit at the current pass version", () => {
    const s = detectPipelineState({ searchProfileId: PROFILE, auditPassVersion: PASS_V1, nowMs: NOW_MS, db });
    expect(s.audit).toBe(true);
  });

  it("FALSE when the quote is audited at the SAME pass version (v1 not re-flagged at v1)", () => {
    seedAudit("q1", PROFILE, PASS_V1);
    const s = detectPipelineState({ searchProfileId: PROFILE, auditPassVersion: PASS_V1, nowMs: NOW_MS, db });
    expect(s.audit).toBe(false);
  });

  it("TRUE when the quote is audited at v1 but the current pass version is v2", () => {
    seedAudit("q1", PROFILE, PASS_V1);
    const s = detectPipelineState({ searchProfileId: PROFILE, auditPassVersion: PASS_V2, nowMs: NOW_MS, db });
    expect(s.audit).toBe(true);
  });
});

// ===========================================================================
// detectPipelineState — compare
// ===========================================================================

describe("detectPipelineState: compare predicate", () => {
  beforeEach(() => {
    seedProfile(PROFILE, "Hyundai", "Tucson", "92614");
    seedDealer(DEALER);
  });

  it("FALSE with fewer than two quotes", () => {
    seedQuote({ quoteId: "q1", profileId: PROFILE });
    const s = detectPipelineState({ searchProfileId: PROFILE, auditPassVersion: PASS_V1, nowMs: NOW_MS, db });
    expect(s.compare).toBe(false);
  });

  it("TRUE with two or more quotes for the profile", () => {
    seedQuote({ quoteId: "q1", profileId: PROFILE, sourceGmailMessageId: "g1" });
    seedQuote({ quoteId: "q2", profileId: PROFILE, sourceGmailMessageId: "g2" });
    const s = detectPipelineState({ searchProfileId: PROFILE, auditPassVersion: PASS_V1, nowMs: NOW_MS, db });
    expect(s.compare).toBe(true);
  });

  it("FALSE when the two quotes belong to a different profile", () => {
    seedProfile("other", "Toyota", "RAV4", "90001");
    seedQuote({ quoteId: "q1", profileId: "other", sourceGmailMessageId: "g1" });
    seedQuote({ quoteId: "q2", profileId: "other", sourceGmailMessageId: "g2" });
    const s = detectPipelineState({ searchProfileId: PROFILE, auditPassVersion: PASS_V1, nowMs: NOW_MS, db });
    expect(s.compare).toBe(false);
  });
});

// ===========================================================================
// resolveTargetedListing
// ===========================================================================

describe("resolveTargetedListing", () => {
  beforeEach(() => {
    seedProfile(PROFILE, "Hyundai", "Tucson", "92614");
    seedDealer(DEALER);
  });

  it("throws TargetedListingNotFound for a missing listing id", () => {
    expect(() => resolveTargetedListing({ targetListingId: "nope", db })).toThrow(
      TargetedListingNotFound,
    );
  });

  it("throws NoInboundThread when the dealer has no inbound thread for the profile", () => {
    seedListing({ listingId: "L1", profileId: PROFILE, dealerId: DEALER, vin: "VIN1", stock: "S1" });
    // A thread exists but only with an OUTBOUND message — not an inbound.
    seedThread("t1", DEALER, PROFILE);
    seedMessage({ messageId: "m-out", threadId: "t1", direction: "outbound", profileId: PROFILE });
    expect(() => resolveTargetedListing({ targetListingId: "L1", db })).toThrow(NoInboundThread);
  });

  it("resolves the listing + inbound thread and flags reusesProcessedInbound", () => {
    seedListing({ listingId: "L1", profileId: PROFILE, dealerId: DEALER, vin: "VIN1", stock: "S1" });
    seedThread("t1", DEALER, PROFILE);
    seedMessage({ messageId: "m-in", threadId: "t1", direction: "inbound", profileId: PROFILE, processedAt: NOW_MS });
    const res = resolveTargetedListing({ targetListingId: "L1", db });
    expect(res.listing.vin).toBe("VIN1");
    expect(res.listing.stockNumber).toBe("S1");
    expect(res.inboundThread.threadId).toBe("t1");
    expect(res.reusesProcessedInbound).toBe(true);
  });

  it("reusesProcessedInbound is false when the inbound was not processed; NEVER mutates processed_at", () => {
    seedListing({ listingId: "L1", profileId: PROFILE, dealerId: DEALER, vin: "VIN1" });
    seedThread("t1", DEALER, PROFILE);
    seedMessage({ messageId: "m-in", threadId: "t1", direction: "inbound", profileId: PROFILE, processedAt: null });
    const res = resolveTargetedListing({ targetListingId: "L1", db });
    expect(res.reusesProcessedInbound).toBe(false);
    // The read must not have written processed_at.
    const row = db.$client.prepare("SELECT processed_at FROM messages WHERE message_id = ?").get("m-in") as {
      processed_at: number | null;
    };
    expect(row.processed_at).toBeNull();
  });

  it("requires the thread to match the listing's profile (NULL-profile threads excluded)", () => {
    seedListing({ listingId: "L1", profileId: PROFILE, dealerId: DEALER, vin: "VIN1" });
    seedThread("t-legacy", DEALER, null);
    seedMessage({ messageId: "m-in", threadId: "t-legacy", direction: "inbound", profileId: null });
    expect(() => resolveTargetedListing({ targetListingId: "L1", db })).toThrow(NoInboundThread);
  });
});

// ===========================================================================
// buildOtdInjection
// ===========================================================================

describe("buildOtdInjection", () => {
  it("includes the stock clause when stock is present", () => {
    expect(buildOtdInjection({ stock: "ABC123", vin: "1HGCM82633A004352" })).toBe(
      "I'd specifically like an out-the-door quote on stock #ABC123, VIN 1HGCM82633A004352.",
    );
  });

  it("omits the stock clause when stock is null", () => {
    expect(buildOtdInjection({ stock: null, vin: "1HGCM82633A004352" })).toBe(
      "I'd specifically like an out-the-door quote on VIN 1HGCM82633A004352.",
    );
  });

  it("omits the stock clause when stock is whitespace-only", () => {
    expect(buildOtdInjection({ stock: "   ", vin: "VIN9" })).toBe(
      "I'd specifically like an out-the-door quote on VIN VIN9.",
    );
  });

  it("raises MissingVinError on a null VIN", () => {
    expect(() => buildOtdInjection({ stock: "S1", vin: null })).toThrow(MissingVinError);
  });

  it("raises MissingVinError on an empty/whitespace VIN", () => {
    expect(() => buildOtdInjection({ stock: "S1", vin: "   " })).toThrow(MissingVinError);
  });
});

// ===========================================================================
// recordQuoteFromListing
// ===========================================================================

describe("recordQuoteFromListing", () => {
  beforeEach(() => {
    seedProfile(PROFILE, "Hyundai", "Tucson", "92614");
    seedDealer(DEALER);
    seedThread("t1", DEALER, PROFILE);
    seedMessage({ messageId: "real-msg", threadId: "t1", direction: "inbound", profileId: PROFILE, gmailMessageId: "gmail-abc" });
    seedListing({ listingId: "L1", profileId: PROFILE, dealerId: DEALER, vin: "VIN1", stock: "S1" });
  });

  function quoteRows(): Array<Record<string, unknown>> {
    return db.$client
      .prepare("SELECT * FROM dealer_quotes WHERE quote_id = ?")
      .all("tq-1") as Array<Record<string, unknown>>;
  }

  it("inserts exactly one row with source_listing_id set and resolves source_gmail_message_id", () => {
    const res = recordQuoteFromListing({
      quoteId: "tq-1",
      messageId: "real-msg",
      sourceListingId: "L1",
      dealerId: DEALER,
      searchProfileId: PROFILE,
      financingMode: "cash",
      vin: "VIN1",
      db,
    });
    expect(res.recorded).toBe(true);
    const rows = quoteRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["source_listing_id"]).toBe("L1");
    expect(rows[0]!["source_gmail_message_id"]).toBe("gmail-abc");
    expect(rows[0]!["message_id"]).toBe("real-msg");
  });

  it("is idempotent on quote_id — a replay yields no duplicate row", () => {
    const a = recordQuoteFromListing({
      quoteId: "tq-1",
      messageId: "real-msg",
      sourceListingId: "L1",
      dealerId: DEALER,
      searchProfileId: PROFILE,
      financingMode: "cash",
      db,
    });
    const b = recordQuoteFromListing({
      quoteId: "tq-1",
      messageId: "real-msg",
      sourceListingId: "L1",
      dealerId: DEALER,
      searchProfileId: PROFILE,
      financingMode: "cash",
      db,
    });
    expect(a.recorded).toBe(true);
    expect(b.recorded).toBe(false);
    expect(quoteRows()).toHaveLength(1);
  });

  it("rejects a missing/blank message_id (MissingMessageIdError)", () => {
    expect(() =>
      recordQuoteFromListing({
        quoteId: "tq-1",
        messageId: "   ",
        sourceListingId: "L1",
        dealerId: DEALER,
        searchProfileId: PROFILE,
        financingMode: "cash",
        db,
      }),
    ).toThrow(MissingMessageIdError);
  });

  it("rejects a synthetic message_id that resolves to no real messages row", () => {
    expect(() =>
      recordQuoteFromListing({
        quoteId: "tq-1",
        messageId: "synthesized-local-id",
        sourceListingId: "L1",
        dealerId: DEALER,
        searchProfileId: PROFILE,
        financingMode: "cash",
        db,
      }),
    ).toThrow(MessageNotFoundError);
    expect(quoteRows()).toHaveLength(0);
  });

  it("falls back to message_id for provenance when the real message lacks a gmail id", () => {
    seedMessage({ messageId: "real-no-gmail", threadId: "t1", direction: "inbound", profileId: PROFILE, gmailMessageId: null });
    recordQuoteFromListing({
      quoteId: "tq-1",
      messageId: "real-no-gmail",
      sourceListingId: "L1",
      dealerId: DEALER,
      searchProfileId: PROFILE,
      financingMode: "cash",
      db,
    });
    expect(quoteRows()[0]!["source_gmail_message_id"]).toBe("real-no-gmail");
  });
});

// ===========================================================================
// finalState — computeFinalState / computeNextAction
// ===========================================================================

describe("computeFinalState", () => {
  it("no_work when nothing was detected", () => {
    expect(computeFinalState([], [])).toBe("no_work");
    expect(computeFinalState([], ["extract"])).toBe("no_work");
  });

  it("ok when every applicable step completed", () => {
    expect(computeFinalState(["extract", "audit"], ["extract", "audit"])).toBe("ok");
    expect(computeFinalState(["extract"], ["extract", "scrape"])).toBe("ok");
  });

  it("partial when some applicable steps completed but not all", () => {
    expect(computeFinalState(["extract", "scrape", "audit"], ["extract"])).toBe("partial");
  });

  it("partial when something was detected but nothing completed (first-step failure)", () => {
    expect(computeFinalState(["extract", "scrape"], [])).toBe("partial");
  });
});

describe("computeNextAction", () => {
  it("no_work → the nothing-to-do line", () => {
    expect(computeNextAction("no_work", [], [])).toContain("Nothing to do");
  });

  it("ok → the review line", () => {
    expect(computeNextAction("ok", ["extract"], ["extract"])).toContain("Pipeline complete");
  });

  it("partial → lists the remaining steps in canonical order", () => {
    const msg = computeNextAction("partial", ["compare", "extract", "audit"], ["extract"]);
    expect(msg).toContain("audit, compare");
    expect(msg).not.toContain("extract,");
  });
});

// ===========================================================================
// writePipelineCompletion
// ===========================================================================

describe("writePipelineCompletion", () => {
  it("writes exactly one audit_log row whose payload_json round-trips", () => {
    const before = db.$client.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number };
    const { auditId } = writePipelineCompletion({
      searchProfileId: PROFILE,
      pipelineRunId: "run-xyz",
      completedSteps: ["extract", "audit"],
      finalState: "partial",
      nextAction: "re-run to finish compare",
      nowMs: NOW_MS,
      db,
    });
    const after = db.$client.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number };
    expect(after.n - before.n).toBe(1);

    const row = db.$client
      .prepare("SELECT action, target_table, search_profile_id, payload_json FROM audit_log WHERE audit_id = ?")
      .get(auditId) as { action: string; target_table: string; search_profile_id: string; payload_json: string };
    expect(row.action).toBe("quote_pipeline.complete");
    expect(row.search_profile_id).toBe(PROFILE);
    const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
    expect(parsed["pipeline_run_id"]).toBe("run-xyz");
    expect(parsed["completed_steps"]).toEqual(["extract", "audit"]);
    expect(parsed["final_state"]).toBe("partial");
    expect(parsed["next_action"]).toBe("re-run to finish compare");
  });
});
