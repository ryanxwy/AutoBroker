/**
 * inboxReady.test.ts — the dealer_inbox_check fixture worlds. Asserts the
 * registry resolves both states; that inbox_ready seeds the XOR-valid submitted
 * lead, the bound dealer with a website whose host stem matches the reply
 * domain, and the dealer-domain reply senders (one known-style, one new
 * salesperson at the same domain); and that inbox_no_lead seeds the same world
 * MINUS any lead_submissions row. No real account string appears.
 *
 * ISOLATION: a throwaway tmp DB at an EXPLICIT path; never ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "@autobroker/db";

import { getFixtureState } from "./index.js";
import { INBOX_READY_PROFILE_ID } from "./inboxReady.js";

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "packages", "db", "drizzle");

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-fixture-inbox-"));
  db = openDb(join(tmpDir, "autobroker.db"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0002_pale_thunderball.sql"), "utf8"));
});

afterEach(() => {
  db.$client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("inbox_ready fixture state", () => {
  it("is resolvable from the registry", () => {
    expect(getFixtureState("inbox_ready").id).toBe("inbox_ready");
    expect(getFixtureState("inbox_no_lead").id).toBe("inbox_no_lead");
  });

  it("seeds an active profile, a bound dealer with a matching website, an XOR-valid submitted lead, and dealer-domain replies", () => {
    const state = getFixtureState("inbox_ready");
    state.seed(db);
    state.seed(db); // idempotent re-run must not throw or double-insert.

    const profile = db.$client
      .prepare(
        "SELECT COUNT(*) AS n FROM search_profiles WHERE status = 'active' AND search_profile_id = ?",
      )
      .get(INBOX_READY_PROFILE_ID) as { n: number };
    expect(profile.n).toBe(1);

    // The bound dealer carries a website whose host stem matches the senders.
    const dealer = db.$client
      .prepare(
        "SELECT d.website AS website FROM dealers d " +
          "JOIN profile_dealers pd ON pd.dealer_id = d.dealer_id " +
          "WHERE pd.search_profile_id = ? AND pd.status = 'bound'",
      )
      .get(INBOX_READY_PROFILE_ID) as { website: string } | undefined;
    expect(dealer?.website).toContain("example-dealer.com");

    // The submitted lead row is XOR-valid (web_form ⇒ fail/email_fallback NULL).
    const lead = db.$client
      .prepare(
        "SELECT outcome, submission_channel, fail_reason, email_fallback_reason, submitted_at " +
          "FROM lead_submissions WHERE search_profile_id = ?",
      )
      .get(INBOX_READY_PROFILE_ID) as
      | {
          outcome: string;
          submission_channel: string;
          fail_reason: string | null;
          email_fallback_reason: string | null;
          submitted_at: number;
        }
      | undefined;
    expect(lead?.outcome).toBe("submitted");
    expect(lead?.submission_channel).toBe("web_form");
    expect(lead?.fail_reason).toBeNull();
    expect(lead?.email_fallback_reason).toBeNull();

    // The replies precede "now" and FOLLOW the lead submit (so the window holds).
    const rows = db.$client
      .prepare("SELECT `from` AS f, internal_date_ms AS dt FROM fake_mailbox_messages ORDER BY dt")
      .all() as Array<{ f: string; dt: number }>;
    expect(rows.length).toBe(2);
    for (const { f, dt } of rows) {
      expect(f).toContain("example-dealer.com"); // dealer-domain senders.
      expect(f).toContain("example"); // no real account string.
      expect(dt).toBeGreaterThan(lead!.submitted_at);
      expect(dt).toBeLessThan(Date.now());
    }
    // One known-style sales address + one NEW salesperson at the same domain.
    const froms = rows.map((r) => r.f);
    expect(froms).toContain("sales@example-dealer.com");
    expect(froms).toContain("jordan.newrep@example-dealer.com");
  });
});

describe("inbox_no_lead fixture state", () => {
  it("seeds the same replies + bound dealer but ZERO lead_submissions rows", () => {
    const state = getFixtureState("inbox_no_lead");
    state.seed(db);

    const leads = db.$client
      .prepare("SELECT COUNT(*) AS n FROM lead_submissions")
      .get() as { n: number };
    expect(leads.n).toBe(0);

    const threads = db.$client
      .prepare("SELECT COUNT(*) AS n FROM fake_mailbox_threads")
      .get() as { n: number };
    expect(threads.n).toBe(2);

    const dealer = db.$client
      .prepare(
        "SELECT COUNT(*) AS n FROM profile_dealers WHERE search_profile_id = ? AND status = 'bound'",
      )
      .get(INBOX_READY_PROFILE_ID) as { n: number };
    expect(dealer.n).toBe(1);
  });
});
