/**
 * hygieneReady.test.ts — the dealer_hygiene fixture world. Asserts the registry
 * resolves it AND that the THREE GLOBAL detection queries each surface EXACTLY
 * one candidate over the seeded world (so the live HygieneReviewCard renders a
 * single-row card per stage 5a/5b/5c). Validating the fixture against the real
 * detection SQL guards the slow live harness from a silently-empty stage.
 *
 * ISOLATION: a throwaway tmp DB at an EXPLICIT path; never ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "@autobroker/db";
import {
  findCrmOnlyThreads,
  findCrmPlatformContacts,
  findOrphanThreads,
  listSuppressions,
} from "@autobroker/tools";

import { getFixtureState } from "./index.js";
import { HYGIENE_READY_PROFILE_ID } from "./hygieneReady.js";

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "packages", "db", "drizzle");

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-fixture-hygiene-"));
  db = openDb(join(tmpDir, "autobroker.db"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0002_pale_thunderball.sql"), "utf8"));
});

afterEach(() => {
  db.$client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// A null trace so the detection queries don't print structured lines in tests.
const noTrace = (): void => {};

describe("hygiene_ready fixture state", () => {
  it("is resolvable from the registry", () => {
    expect(getFixtureState("hygiene_ready").id).toBe("hygiene_ready");
  });

  it("seeds an active pinnable profile + a bound dealer", () => {
    const state = getFixtureState("hygiene_ready");
    state.seed(db);
    state.seed(db); // idempotent re-run must not throw or double-insert.

    const profile = db.$client
      .prepare("SELECT COUNT(*) AS n FROM search_profiles WHERE status = 'active' AND search_profile_id = ?")
      .get(HYGIENE_READY_PROFILE_ID) as { n: number };
    expect(profile.n).toBe(1);

    const bound = db.$client
      .prepare("SELECT COUNT(*) AS n FROM profile_dealers WHERE search_profile_id = ? AND status = 'bound'")
      .get(HYGIENE_READY_PROFILE_ID) as { n: number };
    expect(bound.n).toBe(1);
  });

  it("surfaces EXACTLY one candidate per detection stage (5a orphan / 5b CRM thread / 5c CRM contact)", () => {
    getFixtureState("hygiene_ready").seed(db);

    const orphans = findOrphanThreads(db, HYGIENE_READY_PROFILE_ID, noTrace);
    expect(orphans).toHaveLength(1);
    // The orphan's gmail_thread_id is a real message-id (the red-line value) —
    // not a real thread id.
    expect(orphans[0]!.gmail_thread_id).toBe("hygiene-stray-msg-1");

    const crmThreads = findCrmOnlyThreads(db, HYGIENE_READY_PROFILE_ID, noTrace);
    expect(crmThreads).toHaveLength(1);
    expect(crmThreads[0]!.intent).toBe("nurture"); // the suppressible CRM-noise intent.

    const crmContacts = findCrmPlatformContacts(db, HYGIENE_READY_PROFILE_ID, noTrace);
    expect(crmContacts).toHaveLength(1);
    expect(crmContacts[0]!.normalized_email).toContain("crm-platform.example");
  });

  it("seeds NO pre-existing cleanup suppression rows (a first run is non-empty)", () => {
    getFixtureState("hygiene_ready").seed(db);
    expect(listSuppressions(db).size).toBe(0);
  });

  it("seeds the global table totals the destructive case anchors pin (threads=3 / thread_suppression=0 / dealer_contacts=1)", () => {
    getFixtureState("hygiene_ready").seed(db);
    // The ui_decline / decline_mid cases assert Δ=0 against these ABSOLUTE
    // totals (scope=global + exact). Pinning them here keeps the seed↔anchor
    // coupling self-documenting: a future seed edit that shifts a total fails
    // at unit-test time, not only when the live case anchor flips meaning.
    const threads = db.$client.prepare("SELECT COUNT(*) AS n FROM threads").get() as { n: number };
    expect(threads.n).toBe(3);
    const suppressions = db.$client
      .prepare("SELECT COUNT(*) AS n FROM thread_suppression")
      .get() as { n: number };
    expect(suppressions.n).toBe(0);
    const contacts = db.$client
      .prepare("SELECT COUNT(*) AS n FROM dealer_contacts")
      .get() as { n: number };
    expect(contacts.n).toBe(1);
  });
});
