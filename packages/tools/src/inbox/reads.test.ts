/**
 * L1 unit tests — the profile-scoped inbox read closures + the per-profile
 * sweep watermark. Freezes:
 *   - listProfileThreadRows returns ONLY the passed profile's rows (the
 *     orphan-fix read mirror), joined to the dealer name;
 *   - readLastInboxCheckAt is null before the first sweep; writeLastInboxCheckAt
 *     upserts (a later write overwrites).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; the committed
 * migrations run against the throwaway DB. NEVER touches ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "../db.js";
import {
  listProfileDealerDomains,
  listProfileQuoteRows,
  listProfileThreadRows,
  readFirstLeadSubmitAtMs,
} from "./reads.js";
import { readLastInboxCheckAt, writeLastInboxCheckAt } from "./watermark.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = [
  "0000_military_red_skull.sql",
  "0001_redundant_ozymandias.sql",
  "0002_pale_thunderball.sql",
].map((f) => join(here, "..", "..", "..", "db", "drizzle", f));

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

const PROFILE_A = "prof-a";
const PROFILE_B = "prof-b";
const DEALER = "dealer-1";

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-inbox-reads-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
  const c = db.$client;
  c.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')").run(DEALER, "Example Hyundai");
  // One thread + message for profile A, one for profile B.
  for (const [p, t, m] of [
    [PROFILE_A, "t-a", "m-a"],
    [PROFILE_B, "t-b", "m-b"],
  ] as const) {
    c.prepare("INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id) VALUES (?, ?, ?, 'quoted', ?)").run(t, DEALER, `Subj ${p}`, p);
    c.prepare(
      "INSERT INTO messages (message_id, thread_id, direction, sender_email, subject, received_at, search_profile_id, quote_extraction_status) " +
        "VALUES (?, ?, 'inbound', ?, ?, ?, ?, 'pending')",
    ).run(m, t, `s@${p}.com`, `Subj ${p}`, "2026-06-13T10:00:00.000Z", p);
  }
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

describe("listProfileThreadRows", () => {
  it("returns only the passed profile's threads, with the dealer name", () => {
    const rows = listProfileThreadRows(db, PROFILE_A);
    expect(rows).toHaveLength(1);
    expect(rows[0]!["thread_id"]).toBe("t-a");
    expect(rows[0]!["dealer_name"]).toBe("Example Hyundai");
    expect(rows[0]!["search_profile_id"]).toBeUndefined(); // not selected — projection stays lean
  });
});

describe("listProfileThreadRows — extract_failed flag", () => {
  it("is 0 when no message failed extraction, 1 when a profile-scoped message failed", () => {
    // The base seed leaves PROFILE_A's one message at 'pending' → flag 0.
    expect(listProfileThreadRows(db, PROFILE_A)[0]!["extract_failed"]).toBe(0);

    // Flip PROFILE_A's message to 'failed' (the CHECK requires a null intent for
    // 'failed') → its thread's flag flips to 1.
    db.$client
      .prepare(
        "UPDATE messages SET quote_extraction_status = 'failed', quote_extraction_intent = NULL WHERE message_id = 'm-a'",
      )
      .run();
    expect(listProfileThreadRows(db, PROFILE_A)[0]!["extract_failed"]).toBe(1);

    // PROFILE_B's thread is untouched (the EXISTS is profile-scoped + thread-scoped).
    expect(listProfileThreadRows(db, PROFILE_B)[0]!["extract_failed"]).toBe(0);
  });
});

describe("listProfileQuoteRows", () => {
  /** Seed a 'succeeded'-extraction message (CHECK requires a non-null intent)
   *  carrying the source email + its dealer_quote (price stack) for a profile. */
  function insertQuote(
    quoteId: string,
    profile: string,
    mode: string,
    otd: number | null,
    receivedAt: string,
  ): void {
    const c = db.$client;
    const messageId = `qm-${quoteId}`;
    c.prepare(
      "INSERT INTO messages (message_id, thread_id, direction, sender_name, sender_email, subject, body_text, received_at, search_profile_id, quote_extraction_status, quote_extraction_intent) " +
        "VALUES (?, NULL, 'inbound', ?, ?, ?, ?, ?, ?, 'succeeded', 'quote')",
    ).run(
      messageId,
      `Rep ${quoteId}`,
      `rep-${quoteId}@dealer.com`,
      `Your ${quoteId} quote`,
      `Body of ${quoteId}`,
      receivedAt,
      profile,
    );
    c.prepare(
      "INSERT INTO dealer_quotes " +
        "(quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, financing_mode, " +
        " otd_total, selling_price, vin, msrp, doc_fee, sales_tax, finance_apr, lease_money_factor, " +
        " inventory_status, confidence, quote_expires_at, quote_format, intent, extractor_provider, " +
        " extraction_method, quote_received_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 45000, 85, 3200, 6.9, 0.0012, 'in_stock', 0.91, " +
        " '2026-06-30T00:00:00.000Z', 'otd', 'quote', 'deepseek', 'ocr', ?)",
    ).run(quoteId, DEALER, messageId, `g-${quoteId}`, profile, mode, otd, otd, "VIN123", receivedAt);
  }

  it("returns only the passed profile's quotes, joined to the dealer name, newest-received first", () => {
    insertQuote("q-old", PROFILE_A, "finance", 42000, "2026-06-10T10:00:00.000Z");
    insertQuote("q-new", PROFILE_A, "cash", 39500, "2026-06-12T10:00:00.000Z");
    insertQuote("q-other", PROFILE_B, "lease", 36000, "2026-06-11T10:00:00.000Z");

    const rows = listProfileQuoteRows(db, PROFILE_A);
    expect(rows).toHaveLength(2);
    // Newest quote_received_at first.
    expect(rows.map((r) => r["quote_id"])).toEqual(["q-new", "q-old"]);
    expect(rows[0]!["dealer_name"]).toBe("Example Hyundai");
    expect(rows[0]!["financing_mode"]).toBe("cash");
    expect(rows[0]!["otd_total"]).toBe(39500);
    expect(rows[0]!["extractor_provider"]).toBe("deepseek");
    expect(rows[0]!["extraction_method"]).toBe("ocr");
    // Unaudited quotes carry an empty audit_flag_summary (always a list, never
    // null) so the raw foldout renders no pills for them.
    expect(rows[0]!["audit_flag_summary"]).toEqual([]);
    // The profile B quote never surfaces under A (profile scoping).
    expect(rows.map((r) => r["quote_id"])).not.toContain("q-other");
  });

  it("returns the full price stack + finance/lease terms + meta for the detail modal", () => {
    insertQuote("q-stack", PROFILE_A, "finance", 41000, "2026-06-12T10:00:00.000Z");
    const row = listProfileQuoteRows(db, PROFILE_A)[0]!;
    // Price stack.
    expect(row["msrp"]).toBe(45000);
    expect(row["doc_fee"]).toBe(85);
    expect(row["sales_tax"]).toBe(3200);
    // Finance + lease term columns are both projected (null off-mode, present here).
    expect(row["finance_apr"]).toBe(6.9);
    expect(row["lease_money_factor"]).toBe(0.0012);
    // Meta the modal shows.
    expect(row["confidence"]).toBe(0.91);
    expect(row["inventory_status"]).toBe("in_stock");
    expect(row["quote_expires_at"]).toBe("2026-06-30T00:00:00.000Z");
  });

  it("attaches the source email (subject/body/sender/received-at) and never the message join key", () => {
    insertQuote("q-src", PROFILE_A, "finance", 41000, "2026-06-12T10:00:00.000Z");
    const row = listProfileQuoteRows(db, PROFILE_A)[0]!;
    expect(row["source_subject"]).toBe("Your q-src quote");
    expect(row["source_body_text"]).toBe("Body of q-src");
    expect(row["source_received_at"]).toBe("2026-06-12T10:00:00.000Z");
    // COALESCE(sender_name, sender_email) → the name when present.
    expect(row["source_sender"]).toBe("Rep q-src");
    // The message FK is a join key only — never projected as a renderable field
    // (id red line).
    expect(row["message_id"]).toBeUndefined();
    expect(row["source_gmail_message_id"]).toBeUndefined();
  });

  it("source_sender falls back to sender_email when sender_name is NULL", () => {
    const c = db.$client;
    c.prepare(
      "INSERT INTO messages (message_id, thread_id, direction, sender_email, subject, received_at, search_profile_id, quote_extraction_status, quote_extraction_intent) " +
        "VALUES ('qm-noname', NULL, 'inbound', 'noname@dealer.com', 'No-name quote', '2026-06-12T10:00:00.000Z', ?, 'succeeded', 'quote')",
    ).run(PROFILE_A);
    c.prepare(
      "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, financing_mode, otd_total, quote_received_at) " +
        "VALUES ('q-noname', ?, 'qm-noname', 'g-noname', ?, 'finance', 41000, '2026-06-12T10:00:00.000Z')",
    ).run(DEALER, PROFILE_A);
    const row = listProfileQuoteRows(db, PROFILE_A)[0]!;
    expect(row["source_sender"]).toBe("noname@dealer.com");
  });

  it("returns [] for a profile with no quotes", () => {
    expect(listProfileQuoteRows(db, PROFILE_A)).toEqual([]);
  });
});

describe("listProfileDealerDomains", () => {
  it("returns this profile's bound dealers' website host stems, deduped, profile-scoped, with null/empty dropped", () => {
    const c = db.$client;
    // Two dealers with websites bound to profile A (one shares a host stem to
    // prove dedupe), one with a NULL website (dropped), one with empty (dropped).
    c.prepare("INSERT INTO dealers (dealer_id, name, website, country) VALUES (?, ?, ?, 'US')").run(
      "d-hy",
      "Bob Smith Hyundai",
      "https://www.bob-smith-hyundai.com/",
    );
    c.prepare("INSERT INTO dealers (dealer_id, name, website, country) VALUES (?, ?, ?, 'US')").run(
      "d-hy-2",
      "Bob Smith Hyundai (Service)",
      "https://bob-smith-hyundai.com/service",
    );
    c.prepare("INSERT INTO dealers (dealer_id, name, website, country) VALUES (?, ?, ?, 'US')").run(
      "d-ki",
      "City Kia",
      "https://city-kia.com",
    );
    c.prepare("INSERT INTO dealers (dealer_id, name, website, country) VALUES (?, ?, NULL, 'US')").run(
      "d-nullsite",
      "No Site Motors",
    );
    c.prepare("INSERT INTO dealers (dealer_id, name, website, country) VALUES (?, ?, '', 'US')").run(
      "d-emptysite",
      "Empty Site Motors",
    );
    // Bind the first four to profile A; bind a fifth dealer to profile B only.
    for (const d of ["d-hy", "d-hy-2", "d-ki", "d-nullsite", "d-emptysite"]) {
      c.prepare(
        "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'candidate')",
      ).run(PROFILE_A, d);
    }
    c.prepare("INSERT INTO dealers (dealer_id, name, website, country) VALUES (?, ?, ?, 'US')").run(
      "d-other",
      "Other Profile Ford",
      "https://other-ford.com",
    );
    c.prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'candidate')",
    ).run(PROFILE_B, "d-other");

    const domains = listProfileDealerDomains(db, PROFILE_A);
    // "bob-smith-hyundai" appears once (dedupe), "city-kia" present, null/empty
    // dropped, and "other-ford" (profile B) absent (profile scoping).
    expect(domains).toContain("bob-smith-hyundai");
    expect(domains).toContain("city-kia");
    expect(domains).not.toContain("other-ford");
    expect(domains.filter((s) => s === "bob-smith-hyundai")).toHaveLength(1);
    expect(domains).toHaveLength(2);
  });
});

describe("readFirstLeadSubmitAtMs", () => {
  /** Insert a lead_submissions row honoring the XOR check. */
  function insertSubmission(
    id: string,
    profile: string,
    outcome: "submitted" | "pending" | "failed",
    submittedAt: string | null,
  ): void {
    const c = db.$client;
    if (outcome === "submitted") {
      c.prepare(
        "INSERT INTO lead_submissions (submission_id, dealer_id, search_profile_id, submitted_at, outcome, submission_channel) " +
          "VALUES (?, ?, ?, ?, 'submitted', 'web_form')",
      ).run(id, DEALER, profile, submittedAt);
    } else if (outcome === "failed") {
      c.prepare(
        "INSERT INTO lead_submissions (submission_id, dealer_id, search_profile_id, submitted_at, outcome, fail_reason) " +
          "VALUES (?, ?, ?, ?, 'failed', 'site_unreachable')",
      ).run(id, DEALER, profile, submittedAt);
    } else {
      c.prepare(
        "INSERT INTO lead_submissions (submission_id, dealer_id, search_profile_id, submitted_at, outcome) " +
          "VALUES (?, ?, ?, ?, 'pending')",
      ).run(id, DEALER, profile, submittedAt);
    }
  }

  it("returns the MIN submitted_at (parsed from the ISO string) across submitted rows", () => {
    insertSubmission("ls-1", PROFILE_A, "submitted", "2026-06-10T09:00:00.000Z");
    insertSubmission("ls-2", PROFILE_A, "submitted", "2026-06-08T15:30:00.000Z"); // earliest
    insertSubmission("ls-3", PROFILE_A, "submitted", "2026-06-12T20:00:00.000Z");
    expect(readFirstLeadSubmitAtMs(db, PROFILE_A)).toBe(Date.parse("2026-06-08T15:30:00.000Z"));
  });

  it("ignores pending and failed outcomes", () => {
    insertSubmission("ls-p", PROFILE_A, "pending", "2026-06-01T00:00:00.000Z");
    insertSubmission("ls-f", PROFILE_A, "failed", "2026-06-02T00:00:00.000Z");
    insertSubmission("ls-s", PROFILE_A, "submitted", "2026-06-09T00:00:00.000Z");
    // The earlier pending/failed rows must not lower the floor.
    expect(readFirstLeadSubmitAtMs(db, PROFILE_A)).toBe(Date.parse("2026-06-09T00:00:00.000Z"));
  });

  it("returns null when the profile has no submitted lead", () => {
    insertSubmission("ls-p", PROFILE_A, "pending", "2026-06-01T00:00:00.000Z");
    expect(readFirstLeadSubmitAtMs(db, PROFILE_A)).toBeNull();
    // A submitted row for a DIFFERENT profile does not count.
    insertSubmission("ls-b", PROFILE_B, "submitted", "2026-06-05T00:00:00.000Z");
    expect(readFirstLeadSubmitAtMs(db, PROFILE_A)).toBeNull();
    expect(readFirstLeadSubmitAtMs(db, PROFILE_B)).toBe(Date.parse("2026-06-05T00:00:00.000Z"));
  });

  it("returns null when the submitted row's submitted_at is NULL", () => {
    insertSubmission("ls-null", PROFILE_A, "submitted", null);
    expect(readFirstLeadSubmitAtMs(db, PROFILE_A)).toBeNull();
  });
});

describe("inbox watermark — per profile", () => {
  it("is null before the first sweep, then reads back the written timestamp", () => {
    expect(readLastInboxCheckAt(db, PROFILE_A)).toBeNull();
    writeLastInboxCheckAt(db, PROFILE_A, "2026-06-13T12:00:00.000Z");
    expect(readLastInboxCheckAt(db, PROFILE_A)).toBe("2026-06-13T12:00:00.000Z");
    // A later write overwrites (one row per profile).
    writeLastInboxCheckAt(db, PROFILE_A, "2026-06-14T08:00:00.000Z");
    expect(readLastInboxCheckAt(db, PROFILE_A)).toBe("2026-06-14T08:00:00.000Z");
    // Profile B is independent.
    expect(readLastInboxCheckAt(db, PROFILE_B)).toBeNull();
  });
});
