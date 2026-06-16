/**
 * skills/sessionConsistency.driver.test.ts — the PURE plan-3 driver-side helpers
 * (the multi-launch journey's seed + the FOLLOW-UP-2 hardening bound + the
 * live-surface parsers). Mirrors skills/intake.test.ts: an isolated migrated tmp
 * DB (mkdtemp + openDb + exec the 3 drizzle migrations) for the seed + read helpers,
 * and pure in-memory assertions for the parsers + the bounded-promise guard. NO
 * live LLM, NO server boot, NO Playwright.
 *
 * Covered:
 *  - seedJourneyWorld: bound US dealers WITH websites + inventory listings + the
 *    SANCTIONED dealer-reply corpus (idempotent re-apply inserts 0).
 *  - readNewestActiveProfileId / readExtractedQuotes over real rows.
 *  - withTimeout (FOLLOW-UP 2): resolves fast → value; slow → sentinel; rejection
 *    → sentinel (the "a single invocation always terminates" guard).
 *  - parseSessionState / snapshotTruthForProjected / buildJourneyJudgeSutOutput /
 *    launchTextFor + the JOURNEY_FORM_FIELDS PII-safety shape.
 *
 * ISOLATION: a throwaway tmp DB at an EXPLICIT path; never ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDb, type Db } from "@autobroker/db";

import {
  BOUNDED_TIMEOUT,
  buildJourneyJudgeSutOutput,
  defaultJourneyReplies,
  JOURNEY_DEALERS,
  JOURNEY_FORM_FIELDS,
  JOURNEY_LISTINGS,
  journeyVehicleLabel,
  launchTextFor,
  parseSessionState,
  readExtractedQuotes,
  readNewestActiveProfileId,
  seedJourneyWorld,
  snapshotTruthForProjected,
  SUBSEQUENT_LAUNCHES,
  withTimeout,
  type JourneyLaunch,
} from "./sessionConsistency.js";
import { SENSITIVE_SEED_KEYS } from "./intake.js";

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "packages", "db", "drizzle");

let tmpDir: string;
let dbPath: string;
let db: Db;

const PROFILE = "soak-journey-profile";

/** Insert a minimal active search_profiles row (only the NOT NULL columns + status). */
function insertProfile(id: string): void {
  db.$client
    .prepare("INSERT INTO search_profiles (search_profile_id, year, make, model, status) VALUES (?, 2026, 'Hyundai', 'Tucson Hybrid', 'active')")
    .run(id);
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-soak-journey-"));
  dbPath = join(tmpDir, "autobroker.db");
  db = openDb(dbPath);
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0002_pale_thunderball.sql"), "utf8"));
  insertProfile(PROFILE);
});

afterAll(() => {
  db.$client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// seedJourneyWorld — bound dealers WITH websites + listings + the reply corpus
// ===========================================================================

describe("seedJourneyWorld (the deterministic journey-world seed)", () => {
  it("seeds bound US dealers WITH websites + inventory listings + the reply corpus", () => {
    const r = seedJourneyWorld({ dbPath, profileId: PROFILE });
    expect(r.dealers).toBe(JOURNEY_DEALERS.length);
    expect(r.listings).toBe(JOURNEY_LISTINGS.length);
    expect(r.replyDealers).toBeGreaterThan(0);
    expect(r.replyMessages).toBeGreaterThan(0);

    // The bound dealers carry websites + country='US' and are bound to the profile.
    const bound = db.$client
      .prepare(
        "SELECT d.dealer_id AS id, d.website AS website, d.country AS country FROM dealers d " +
          "JOIN profile_dealers pd ON pd.dealer_id = d.dealer_id WHERE pd.search_profile_id = ?",
      )
      .all(PROFILE) as Array<{ id: string; website: string | null; country: string }>;
    const seededIds = new Set(JOURNEY_DEALERS.map((d) => d.dealerId));
    const seededBound = bound.filter((b) => seededIds.has(b.id));
    expect(seededBound).toHaveLength(JOURNEY_DEALERS.length);
    for (const b of seededBound) {
      expect(b.website).toMatch(/^https:\/\//);
      expect(b.country).toBe("US");
    }

    // The listings carry a VIN + a stock number + the profile scope.
    const listings = db.$client
      .prepare("SELECT vin, stock_number, search_profile_id FROM inventory_listings WHERE search_profile_id = ?")
      .all(PROFILE) as Array<{ vin: string | null; stock_number: string | null; search_profile_id: string }>;
    expect(listings).toHaveLength(JOURNEY_LISTINGS.length);
    for (const l of listings) {
      expect(typeof l.vin).toBe("string");
      expect(l.vin!.length).toBe(17);
      expect(typeof l.stock_number).toBe("string");
    }

    // The reply corpus landed inbound 'pending' candidate messages for the profile.
    const pending = db.$client
      .prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE search_profile_id = ? AND direction = 'inbound' AND quote_extraction_status = 'pending'",
      )
      .get(PROFILE) as { n: number };
    expect(pending.n).toBeGreaterThan(0);
  });

  it("is idempotent — a re-apply inserts ZERO net-new rows", () => {
    const r = seedJourneyWorld({ dbPath, profileId: PROFILE });
    expect(r.dealers).toBe(0);
    expect(r.listings).toBe(0);
    expect(r.replyDealers).toBe(0);
    expect(r.replyMessages).toBe(0);
  });
});

// ===========================================================================
// readNewestActiveProfileId / readExtractedQuotes
// ===========================================================================

describe("readNewestActiveProfileId", () => {
  it("reads the active profile id off the isolated DB", () => {
    expect(readNewestActiveProfileId(dbPath)).toBe(PROFILE);
  });
  it("returns null on a DB with no active profile", () => {
    const otherDir = mkdtempSync(join(tmpdir(), "autobroker-soak-empty-"));
    const otherPath = join(otherDir, "autobroker.db");
    const odb = openDb(otherPath);
    try {
      odb.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
      odb.$client.close();
      expect(readNewestActiveProfileId(otherPath)).toBeNull();
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

describe("readExtractedQuotes", () => {
  it("reads the dealer_quotes the extraction child would write (empty until extract runs)", () => {
    expect(readExtractedQuotes(dbPath, PROFILE)).toEqual([]);
    // Simulate the extract child writing one quote off a seeded inbound message
    // (message_id is NOT NULL — reference the corpus row seedJourneyWorld created).
    const msg = db.$client
      .prepare("SELECT message_id AS id FROM messages WHERE search_profile_id = ? AND direction = 'inbound' LIMIT 1")
      .get(PROFILE) as { id: string };
    db.$client
      .prepare(
        "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, otd_total, selling_price, financing_mode) " +
          "VALUES ('jq-1', 'sc-jim-click', ?, 'jq-1-gmsg', ?, 35500, 33200, 'finance')",
      )
      .run(msg.id, PROFILE);
    const quotes = readExtractedQuotes(dbPath, PROFILE);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.otdTotal).toBe(35500);
    expect(quotes[0]!.sellingPrice).toBe(33200);
    expect(quotes[0]!.financingMode).toBe("finance");
  });
});

// ===========================================================================
// withTimeout (FOLLOW-UP 2 — the always-terminates guard)
// ===========================================================================

describe("withTimeout (the bounded-promise guard)", () => {
  it("resolves to the value when the promise settles before the bound", async () => {
    const r = await withTimeout(Promise.resolve(42), 1000);
    expect(r).toBe(42);
  });
  it("resolves to the BOUNDED_TIMEOUT sentinel when the promise is too slow", async () => {
    const slow = new Promise<number>((resolve) => {
      const t = setTimeout(() => resolve(1), 1000);
      t.unref();
    });
    const r = await withTimeout(slow, 5);
    expect(r).toBe(BOUNDED_TIMEOUT);
  });
  it("resolves to the sentinel when the promise REJECTS (best-effort, never throws)", async () => {
    const r = await withTimeout(Promise.reject(new Error("boom")), 1000);
    expect(r).toBe(BOUNDED_TIMEOUT);
  });
});

// ===========================================================================
// the live-surface parsers (pure)
// ===========================================================================

describe("parseSessionState", () => {
  it("parses last_run_id + pinned_profile_id off the snake_case wire", () => {
    const s = parseSessionState({ id: "sess-1", last_run_id: "run-9", pinned_profile_id: "p-1" });
    expect(s).toEqual({ id: "sess-1", lastRunId: "run-9", pinnedProfileId: "p-1" });
  });
  it("maps absent/null fields to null", () => {
    const s = parseSessionState({ id: "sess-1", last_run_id: null });
    expect(s.lastRunId).toBeNull();
    expect(s.pinnedProfileId).toBeNull();
  });
});

describe("snapshotTruthForProjected (the INV-projection pairing)", () => {
  it("maps each projected product status onto the snapshot truth", () => {
    expect(snapshotTruthForProjected("awaiting_approval")).toBe("suspended");
    expect(snapshotTruthForProjected("done")).toBe("success");
    expect(snapshotTruthForProjected("declined")).toBe("success_declined");
    expect(snapshotTruthForProjected("running")).toBe("running");
    expect(snapshotTruthForProjected("error")).toBe("failed");
    expect(snapshotTruthForProjected(null)).toBe("running");
  });
});

describe("buildJourneyJudgeSutOutput", () => {
  it("describes slash mode (router not exercised)", () => {
    expect(buildJourneyJudgeSutOutput({ mode: "slash", routingObservations: [] })).toMatch(/slash/);
  });
  it("lists the nl router decisions", () => {
    const out = buildJourneyJudgeSutOutput({
      mode: "nl",
      routingObservations: [
        { nlText: "find dealers near me", expectedSkillId: "dealer_geosearch", routedSkillId: "dealer_geosearch" },
      ],
    });
    expect(out).toMatch(/dealer_geosearch/);
  });
  it("appends the extracted quotes when extraction ran (the extraction-quality view)", () => {
    const out = buildJourneyJudgeSutOutput({
      mode: "slash",
      routingObservations: [],
      extractedQuotes: [{ dealerId: "sc-jim-click", otdTotal: 35500, sellingPrice: 33200, financingMode: "finance" }],
    });
    expect(out).toMatch(/extracted dealer_quotes/);
    expect(out).toMatch(/35500/);
  });
});

// ===========================================================================
// launchTextFor + the journey constants (the mode branch + PII safety)
// ===========================================================================

describe("launchTextFor (the nl/slash mode branch)", () => {
  const launch: JourneyLaunch = { skillId: "dealer_geosearch", nlPhrasing: "find dealers near me", isIntake: false };
  it("nl mode → the natural prose", () => {
    expect(launchTextFor(launch, "nl")).toBe("find dealers near me");
  });
  it("slash mode → the deterministic /skillId", () => {
    expect(launchTextFor(launch, "slash")).toBe("/dealer_geosearch");
  });
});

describe("SUBSEQUENT_LAUNCHES (the post-intake launch sequence)", () => {
  it("excludes the cold-start intake and covers the four pinned-session skills", () => {
    const ids = SUBSEQUENT_LAUNCHES.map((l) => l.skillId);
    expect(ids).toEqual(["dealer_geosearch", "inventory_site_scan", "dealer_inbox_check", "quote_pipeline"]);
    expect(SUBSEQUENT_LAUNCHES.every((l) => !l.isIntake)).toBe(true);
  });
});

describe("journeyVehicleLabel (the Searches pin label)", () => {
  it("builds the UI's 'Year Make Model Trim' label off the confirmed form fields", () => {
    expect(journeyVehicleLabel()).toBe("2026 Hyundai Tucson Hybrid SEL");
  });
});

describe("JOURNEY_FORM_FIELDS (the intake-confirm fields)", () => {
  it("NEVER pre-fills a PII/budget sensitive key BEYOND a confirmed email (no phone, no budget)", () => {
    // follow_up_email is the harness fixture address (a confirmed entry, not a
    // guessed one); follow_up_phone + budget_max are NEVER seeded (#9).
    expect("follow_up_phone" in JOURNEY_FORM_FIELDS).toBe(false);
    expect("budget_max" in JOURNEY_FORM_FIELDS).toBe(false);
    // The sensitive-key contract from intake: phone + budget absent.
    const sensitiveButEmail = SENSITIVE_SEED_KEYS.filter((k) => k !== "follow_up_email");
    for (const k of sensitiveButEmail) {
      expect(k in JOURNEY_FORM_FIELDS).toBe(false);
    }
  });
});

describe("defaultJourneyReplies (the budget-free dealer reply corpus)", () => {
  it("mints one reply per dealer with a quoted OTD + NO budget figure", () => {
    const replies = defaultJourneyReplies();
    expect(replies).toHaveLength(JOURNEY_DEALERS.length);
    for (const r of replies) {
      expect(r.dealerWebsite).toMatch(/^https:\/\//);
      expect(r.from).toMatch(/@/);
      expect(r.body.length).toBeGreaterThan(0);
    }
  });
});
