/**
 * L1 unit tests — the digest aggregator. Freezes:
 *   - dealer / thread / needs-response / unanswered-question counts;
 *   - OTD-ascending best-first sort + offersLimit trim + best (lowest) OTD;
 *   - the `_NO_ACTIVE_SEARCHES` exact-string state on zero active profiles;
 *   - per-profile grouping (a profile with no offers is SKIPPED in the offers
 *     section but PRESENT with its dealer-status counts);
 *   - the freshness mix over inventory listings (fresh/stale/missing);
 *   - the deterministic Next Actions derivation;
 *   - is_current=1 (a superseded analysis row never inflates needs-response).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; the committed
 * migration SQL runs against the throwaway DB. NEVER touches ~/.autobroker-ts.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/db";

import { generateDigest, NO_ACTIVE_SEARCHES } from "./generateDigest.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const originalDataDir = process.env[DATA_DIR];
const originalDbOverride = process.env[DB_OVERRIDE];

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "db", "drizzle");

const NOW = 1_750_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-digest-"));
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

const TABLES = [
  "message_questions",
  "message_analysis",
  "messages",
  "dealer_quotes",
  "inventory_listings",
  "threads",
  "profile_dealers",
  "dealers",
  "search_profiles",
];

beforeEach(() => {
  for (const t of TABLES) db.$client.prepare(`DELETE FROM ${t}`).run();
});

// --- seed helpers -----------------------------------------------------------

function addProfile(id: string, status: string | null = "active"): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, trim, status) VALUES (?,?,?,?,?,?)",
    )
    .run(id, 2026, "Hyundai", "Tucson", "SEL", status);
}

function addDealer(id: string, name: string): void {
  db.$client.prepare("INSERT INTO dealers (dealer_id, name) VALUES (?,?)").run(id, name);
}

function bindDealer(profileId: string, dealerId: string, status = "candidate"): void {
  db.$client
    .prepare("INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?,?,?)")
    .run(profileId, dealerId, status);
}

function addThread(threadId: string, dealerId: string, profileId: string): void {
  db.$client
    .prepare("INSERT INTO threads (thread_id, dealer_id, search_profile_id) VALUES (?,?,?)")
    .run(threadId, dealerId, profileId);
}

function addMessage(messageId: string, threadId: string, profileId: string): void {
  db.$client
    .prepare(
      "INSERT INTO messages (message_id, thread_id, direction, search_profile_id, quote_extraction_status) VALUES (?,?,?,?,?)",
    )
    .run(messageId, threadId, "inbound", profileId, "pending");
}

function addAnalysis(
  analysisId: string,
  messageId: string,
  profileId: string,
  opts: { isCurrent?: number; needsResponse?: number; version?: number } = {},
): void {
  db.$client
    .prepare(
      "INSERT INTO message_analysis (analysis_id, message_id, analysis_version, is_current, needs_response, search_profile_id) VALUES (?,?,?,?,?,?)",
    )
    .run(
      analysisId,
      messageId,
      opts.version ?? 1,
      opts.isCurrent ?? 1,
      opts.needsResponse ?? 0,
      profileId,
    );
}

function addQuestion(
  questionId: string,
  analysisId: string,
  profileId: string,
  status = "needs_user_input",
): void {
  db.$client
    .prepare(
      "INSERT INTO message_questions (question_id, analysis_id, question_type, question_text, status, search_profile_id) VALUES (?,?,?,?,?,?)",
    )
    .run(questionId, analysisId, "clarification", "Which trim?", status, profileId);
}

function addQuote(
  quoteId: string,
  profileId: string,
  dealerId: string,
  otdTotal: number | null,
  opts: { sourceListingId?: string | null; financingMode?: string } = {},
): void {
  db.$client
    .prepare(
      "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, otd_total, financing_mode, source_listing_id) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(
      quoteId,
      dealerId,
      `msg-${quoteId}`,
      `gmsg-${quoteId}`,
      profileId,
      otdTotal,
      opts.financingMode ?? "cash",
      opts.sourceListingId ?? null,
    );
}

function addListing(listingId: string, profileId: string, dealerId: string, lastSeenAtMs: number): void {
  db.$client
    .prepare(
      "INSERT INTO inventory_listings (listing_id, search_profile_id, dealer_id, inventory_status, match_status, raw_listing_json, first_seen_at, last_seen_at, observed_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(listingId, profileId, dealerId, "in_stock", "exact", "{}", lastSeenAtMs, lastSeenAtMs, lastSeenAtMs);
}

// --- tests ------------------------------------------------------------------

describe("generateDigest — empty / no-active state", () => {
  it("zero active profiles → the exact _NO_ACTIVE_SEARCHES sentinel", () => {
    const payload = generateDigest(db, { profileIds: null, nowMs: NOW });
    expect(payload.state).toBe(NO_ACTIVE_SEARCHES);
    expect(payload.state).toBe("_NO_ACTIVE_SEARCHES");
    expect(payload.profiles).toHaveLength(0);
    expect(payload.nextActions).toHaveLength(0);
    expect(payload.overallBestOtd).toBeNull();
  });

  it("a closed profile is not active → still _NO_ACTIVE_SEARCHES", () => {
    addProfile("p-closed", "closed");
    const payload = generateDigest(db, { profileIds: null, nowMs: NOW });
    expect(payload.state).toBe("_NO_ACTIVE_SEARCHES");
  });
});

describe("generateDigest — counts", () => {
  it("dealer, thread, needs-response and unanswered-question counts", () => {
    addProfile("p1");
    addDealer("d1", "Alpha Hyundai");
    addDealer("d2", "Beta Hyundai");
    bindDealer("p1", "d1", "bound");
    bindDealer("p1", "d2", "candidate");
    addThread("t1", "d1", "p1");
    addThread("t2", "d2", "p1");
    addMessage("m1", "t1", "p1");
    addMessage("m2", "t2", "p1");
    addAnalysis("a1", "m1", "p1", { needsResponse: 1 });
    addAnalysis("a2", "m2", "p1", { needsResponse: 0 });
    addQuestion("q1", "a1", "p1", "needs_user_input");
    addQuestion("q2", "a2", "p1", "informational_only"); // not awaiting input

    const payload = generateDigest(db, { profileIds: null, nowMs: NOW });
    expect(payload.profiles).toHaveLength(1);
    const g = payload.profiles[0]!;
    expect(g.dealerCount).toBe(2);
    expect(g.boundDealerCount).toBe(1);
    expect(g.threadCount).toBe(2);
    expect(g.needsResponseCount).toBe(1);
    expect(g.unansweredQuestionCount).toBe(1);
    expect(g.vehicle).toBe("2026 Hyundai Tucson SEL");
  });

  it("a superseded (is_current=0) analysis never inflates needs-response", () => {
    addProfile("p1");
    addDealer("d1", "Alpha");
    addThread("t1", "d1", "p1");
    addMessage("m1", "t1", "p1");
    addAnalysis("a-old", "m1", "p1", { isCurrent: 0, needsResponse: 1, version: 1 });
    addAnalysis("a-new", "m1", "p1", { isCurrent: 1, needsResponse: 0, version: 2 });
    const payload = generateDigest(db, { profileIds: null, nowMs: NOW });
    expect(payload.profiles[0]!.needsResponseCount).toBe(0);
  });
});

describe("generateDigest — offers sort + trim + best OTD", () => {
  beforeEach(() => {
    addProfile("p1");
    addDealer("d1", "Alpha");
    addDealer("d2", "Beta");
  });

  it("offers are OTD-ascending (best first); best = lowest non-null", () => {
    addQuote("hi", "p1", "d1", 41000);
    addQuote("lo", "p1", "d2", 38000);
    addQuote("mid", "p1", "d1", 39500);
    const payload = generateDigest(db, { profileIds: null, nowMs: NOW });
    const g = payload.profiles[0]!;
    expect(g.offers.map((o) => o.otdTotal)).toEqual([38000, 39500, 41000]);
    expect(g.bestOtd).toBe(38000);
    expect(payload.overallBestOtd).toBe(38000);
  });

  it("null-OTD quotes sort LAST and never win best", () => {
    addQuote("priced", "p1", "d1", 40000);
    addQuote("unpriced", "p1", "d2", null);
    const payload = generateDigest(db, { profileIds: null, nowMs: NOW });
    const g = payload.profiles[0]!;
    expect(g.offers.map((o) => o.otdTotal)).toEqual([40000, null]);
    expect(g.bestOtd).toBe(40000);
  });

  it("offersLimit trims the surfaced offers but totalQuotes keeps the full count", () => {
    for (let i = 0; i < 5; i += 1) addQuote(`q${i}`, "p1", "d1", 40000 + i * 100);
    const payload = generateDigest(db, { profileIds: null, nowMs: NOW, offersLimit: 2 });
    const g = payload.profiles[0]!;
    expect(g.offers).toHaveLength(2);
    expect(g.totalQuotes).toBe(5);
    expect(g.offers.map((o) => o.otdTotal)).toEqual([40000, 40100]); // best two
  });
});

describe("generateDigest — per-profile grouping", () => {
  it("a profile with no offers is present (dealer status) but its offers list is empty", () => {
    addProfile("p-quotes");
    addProfile("p-noquotes");
    addDealer("d1", "Alpha");
    addDealer("d2", "Beta");
    bindDealer("p-noquotes", "d2", "bound");
    addQuote("q1", "p-quotes", "d1", 39000);

    const payload = generateDigest(db, { profileIds: null, nowMs: NOW });
    expect(payload.profiles).toHaveLength(2);
    const noQuotes = payload.profiles.find((g) => g.searchProfileId === "p-noquotes")!;
    expect(noQuotes.offers).toHaveLength(0);
    expect(noQuotes.totalQuotes).toBe(0);
    expect(noQuotes.bestOtd).toBeNull();
    expect(noQuotes.dealerCount).toBe(1); // dealer-status section still renders
    expect(noQuotes.boundDealerCount).toBe(1);
  });

  it("quotes never leak across profiles (search_profile_id scoping)", () => {
    addProfile("pA");
    addProfile("pB");
    addDealer("d1", "Alpha");
    addQuote("qa", "pA", "d1", 38000);
    addQuote("qb", "pB", "d1", 50000);
    const payload = generateDigest(db, { profileIds: null, nowMs: NOW });
    const a = payload.profiles.find((g) => g.searchProfileId === "pA")!;
    const b = payload.profiles.find((g) => g.searchProfileId === "pB")!;
    expect(a.offers.map((o) => o.otdTotal)).toEqual([38000]);
    expect(b.offers.map((o) => o.otdTotal)).toEqual([50000]);
  });
});

describe("generateDigest — freshness mix + quote freshness chip", () => {
  it("buckets listings fresh/stale/missing against nowMs", () => {
    addProfile("p1");
    addDealer("d1", "Alpha");
    addListing("l-fresh", "p1", "d1", NOW - 2 * HOUR);
    addListing("l-stale", "p1", "d1", NOW - 3 * DAY);
    addListing("l-missing", "p1", "d1", NOW - 10 * DAY);
    const payload = generateDigest(db, { profileIds: null, nowMs: NOW });
    expect(payload.profiles[0]!.freshnessMix).toEqual({ fresh: 1, stale: 1, missing: 1 });
  });

  it("a quote's freshness chip reflects its source listing; no listing → missing", () => {
    addProfile("p1");
    addDealer("d1", "Alpha");
    addListing("l1", "p1", "d1", NOW - 1 * HOUR);
    addQuote("q-fresh", "p1", "d1", 39000, { sourceListingId: "l1" });
    addQuote("q-nolisting", "p1", "d1", 40000, { sourceListingId: null });
    const payload = generateDigest(db, { profileIds: null, nowMs: NOW });
    const offers = payload.profiles[0]!.offers;
    expect(offers.find((o) => o.quoteId === "q-fresh")!.freshness).toBe("fresh");
    expect(offers.find((o) => o.quoteId === "q-nolisting")!.freshness).toBe("missing");
  });
});

describe("generateDigest — deterministic Next Actions", () => {
  it("derives one needs-response line and one question line per profile with non-zero counts", () => {
    addProfile("p1");
    addDealer("d1", "Alpha");
    addThread("t1", "d1", "p1");
    addMessage("m1", "t1", "p1");
    addAnalysis("a1", "m1", "p1", { needsResponse: 1 });
    addQuestion("q1", "a1", "p1", "needs_user_input");
    const payload = generateDigest(db, { profileIds: null, nowMs: NOW });
    expect(payload.nextActions.map((a) => a.kind)).toEqual([
      "needs_response",
      "unanswered_question",
    ]);
    expect(payload.nextActions[0]!.count).toBe(1);
  });

  it("no actions when everything is handled", () => {
    addProfile("p1");
    const payload = generateDigest(db, { profileIds: null, nowMs: NOW });
    expect(payload.nextActions).toHaveLength(0);
  });
});

describe("generateDigest — explicit profileIds scope", () => {
  it("pins exactly the requested profile(s)", () => {
    addProfile("p1");
    addProfile("p2");
    const payload = generateDigest(db, { profileIds: ["p2"], nowMs: NOW });
    expect(payload.profiles.map((g) => g.searchProfileId)).toEqual(["p2"]);
  });

  it("an explicit id set with no surviving rows → _NO_ACTIVE_SEARCHES", () => {
    addProfile("p1");
    const payload = generateDigest(db, { profileIds: ["does-not-exist"], nowMs: NOW });
    expect(payload.state).toBe("_NO_ACTIVE_SEARCHES");
  });
});
