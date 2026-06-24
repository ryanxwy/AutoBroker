/**
 * In-stack tests — DEALERSHIP EXCLUSIVITY across two search profiles. These drive
 * the REAL flat Mastra dealer_web_lead_submit workflow (the claim step + submit +
 * email-fallback + recordConfirm) and the REAL dealer_closeout_email transition
 * release, against an ISOLATED tmp autobroker.db with ALL FOUR committed migrations
 * applied (0003 carries the partial-unique `uq_profile_dealers_bound_dealer` +
 * the status CHECK enum that the claim relies on). The browser scout, the gated
 * submit, and the gmail send are STUBBED through the test-only deps seam, while the
 * REAL claimDealer / releaseDealerClaims tools run against the real DB. NO real
 * browser, NO real Gmail, NO LLM, no network.
 *
 * THE EXCLUSIVITY INVARIANT under test: a dealer already 'bound' to profile B is
 * DROPPED from profile A's approved set BEFORE any send — no lead_submissions row
 * is written for it, no submitOne / sendAndRecord ever fires for it, and the
 * exclusion is VOICED in the receipt — while A's OTHER approved dealers still
 * submit. Then closing B (closeout transition) releases its bound dealers so A
 * could claim D on a re-run.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/restored);
 * mastra.db + autobroker.db both live there; NEVER ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claimDealer, closeDb, openDb, type Db } from "@autobroker/tools";

import { createMastraInstance } from "./mastra.js";
import {
  dealerCloseoutEmailWorkflow,
  DEALER_CLOSEOUT_EMAIL_WORKFLOW_ID,
  __resetDealerCloseoutEmailDepsForTests,
  __setDealerCloseoutEmailDepsForTests,
  type DealerCloseoutEmailWorkflowDeps,
} from "./dealerCloseoutEmail.js";
import {
  dealerWebLeadSubmitWorkflow,
  DEALER_WEB_LEAD_SUBMIT_WORKFLOW_ID,
  __resetDealerWebLeadSubmitDepsForTests,
  __setDealerWebLeadSubmitDepsForTests,
  type DealerWebLeadSubmitWorkflowDeps,
  type ScoutOutcome,
  type SubmitOneArgs,
  type SubmitVerdict,
} from "./dealerWebLeadSubmit.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = [
  "0000_military_red_skull.sql",
  "0001_redundant_ozymandias.sql",
  "0002_pale_thunderball.sql",
  "0003_salty_jocasta.sql",
].map((f) => join(here, "..", "..", "db", "drizzle", f));

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

const PROFILE_A = "prof-A-tucson";
const PROFILE_B = "prof-B-accord";
// D is the SHARED dealer A and B both want; OTHER is A-only.
const DEALER_D = "dealer-shared-D";
const DEALER_OTHER = "dealer-A-other";

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-exclusivity-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
});

afterEach(() => {
  __resetDealerWebLeadSubmitDepsForTests();
  __resetDealerCloseoutEmailDepsForTests();
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

// ---------------------------------------------------------------------------
// seed helpers
// ---------------------------------------------------------------------------

function seedProfile(over: { id: string; make: string; model: string }): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, trim, " +
        "search_radius_miles, location_query, latitude, longitude, postal_code, " +
        "follow_up_email, financing_preference, status, brand, account_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
    )
    .run(
      over.id,
      2026,
      over.make,
      over.model,
      "SEL",
      50,
      "Somewhere, US",
      32.3349,
      -110.9762,
      "92614",
      `buyer.${over.id}@example.com`,
      "finance",
      over.make,
      "acct-test-1",
    );
}

function seedDealer(over: {
  dealerId: string;
  name: string;
  website: string;
  contactEmail?: string | null;
}): void {
  db.$client
    .prepare(
      "INSERT INTO dealers (dealer_id, name, country, website, contact_email) VALUES (?, ?, 'US', ?, ?)",
    )
    .run(over.dealerId, over.name, over.website, over.contactEmail ?? null);
}

/** Bind a dealer to a profile with an explicit status (candidate/bound). */
function bindDealer(over: {
  profileId: string;
  dealerId: string;
  status: "candidate" | "bound";
}): void {
  db.$client
    .prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, ?)",
    )
    .run(over.profileId, over.dealerId, over.status);
}

/** Seed a dealer 'bound' to a profile with an OPEN thread + one inbound message
 *  (the closeout-addressable shape) so the closeout workflow has a real target. */
function seedDealerWithThread(over: {
  dealerId: string;
  name: string;
  threadId: string;
  contactEmail: string;
  profileId: string;
}): void {
  const c = db.$client;
  c.prepare(
    "INSERT INTO dealers (dealer_id, name, country, website, contact_email) VALUES (?, ?, 'US', ?, ?)",
  ).run(over.dealerId, over.name, `https://${over.dealerId}.example.com`, over.contactEmail);
  c.prepare(
    "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
  ).run(over.profileId, over.dealerId);
  c.prepare(
    "INSERT INTO threads (thread_id, dealer_id, gmail_thread_id, subject, state, search_profile_id) " +
      "VALUES (?, ?, ?, ?, 'replied', ?)",
  ).run(over.threadId, over.dealerId, `gmail-${over.threadId}`, "Quote request", over.profileId);
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, sender, " +
      "recipient, subject, body_text, processed_at, search_profile_id, quote_extraction_status) " +
      "VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, 'pending')",
  ).run(
    `inbound-${over.threadId}`,
    over.threadId,
    `gmail-msg-${over.threadId}`,
    over.contactEmail,
    "buyer@example.com",
    "Quote request",
    "Here is your quote.",
    new Date().toISOString(),
    over.profileId,
  );
}

/** A closeAndSuppressDealer stub modeling the `closed` outcome: records the dealer
 *  and performs the same local thread-close + suppression writes the real tool does
 *  (no live Gmail), so the run genuinely closes ≥1 thread → transition fires. */
function closeStub(calls: string[]): DealerCloseoutEmailWorkflowDeps["closeAndSuppressDealer"] {
  return async (args) => {
    calls.push(args.target.dealerId);
    const c = args.db.$client;
    const txn = c.transaction(() => {
      if (args.target.threadId !== null) {
        c.prepare("UPDATE threads SET state = 'closed' WHERE thread_id = ?").run(args.target.threadId);
      }
      c.prepare(
        "INSERT INTO thread_suppression (suppression_id, thread_id, dealer_id, gmail_thread_id, " +
          "scope, action, reason, approved_by, approved_at, search_profile_id) " +
          "VALUES (?, ?, ?, ?, 'dealer', 'suppress', ?, 'user', ?, ?) " +
          "ON CONFLICT(suppression_id) DO NOTHING",
      ).run(
        `closeout:${args.searchProfileId}:${args.target.dealerId}`,
        args.target.threadId,
        args.target.dealerId,
        args.target.gmailThreadId,
        `closeout:${args.searchProfileId}`,
        new Date().toISOString(),
        args.searchProfileId,
      );
    });
    txn();
    return { kind: "closed", messageRowId: null, sendBlocked: false };
  };
}

function leadRowsFor(profileId: string): Array<Record<string, unknown>> {
  return db.$client
    .prepare("SELECT * FROM lead_submissions WHERE search_profile_id = ?")
    .all(profileId) as Array<Record<string, unknown>>;
}

function dealerStatus(profileId: string, dealerId: string): string | undefined {
  const r = db.$client
    .prepare(
      "SELECT status FROM profile_dealers WHERE search_profile_id = ? AND dealer_id = ?",
    )
    .get(profileId, dealerId) as { status: string } | undefined;
  return r?.status;
}

// ---------------------------------------------------------------------------
// deps stubs
// ---------------------------------------------------------------------------

/** A web-form scout shape (a usable known-platform form) for the named dealers. */
function webFormScout(): DealerWebLeadSubmitWorkflowDeps["scoutForms"] {
  return async (args) =>
    args.dealers.map(
      (d): ScoutOutcome => ({
        dealerId: d.dealerId,
        name: d.name,
        website: d.website,
        form: { url: `${d.website}/contact.htm`, submitSelector: "button[type=submit]" },
        platform: "dealerfire",
        fieldMap: [
          { name: "Email", role: "email" },
          { name: "Comments", role: "comment" },
        ],
        formSnapshot: null,
        contactEmail: null,
        captcha: false,
      }),
    );
}

interface SubmitSpy {
  dealerIds: string[];
}

/** A submit spy modeling the buyer-mode approve path: records WHICH dealers ever
 *  reached the gated submit, and reports `submitted`. A dropped dealer must NEVER
 *  appear here. */
function submitSpy(spy: SubmitSpy): DealerWebLeadSubmitWorkflowDeps["submitOne"] {
  return async (args: SubmitOneArgs): Promise<SubmitVerdict> => {
    spy.dealerIds.push(args.dealerId);
    return { kind: "submitted" };
  };
}

const sendNeverCalled = (async () => {
  throw new Error("sendAndRecord must not be called on this path");
}) as unknown as DealerWebLeadSubmitWorkflowDeps["sendAndRecord"];

const harnessNeverCalled = (async () => {
  throw new Error("harness.generate must not be called on this path");
}) as unknown as DealerWebLeadSubmitWorkflowDeps["harnessGenerate"];

// ---------------------------------------------------------------------------
// run/resume drivers
// ---------------------------------------------------------------------------

function leadWorkflow() {
  const mastra = createMastraInstance({
    workflows: { [DEALER_WEB_LEAD_SUBMIT_WORKFLOW_ID]: dealerWebLeadSubmitWorkflow as never },
  });
  return mastra.getWorkflow(DEALER_WEB_LEAD_SUBMIT_WORKFLOW_ID);
}

function closeoutWorkflow() {
  const mastra = createMastraInstance({
    workflows: { [DEALER_CLOSEOUT_EMAIL_WORKFLOW_ID]: dealerCloseoutEmailWorkflow as never },
  });
  return mastra.getWorkflow(DEALER_CLOSEOUT_EMAIL_WORKFLOW_ID);
}

function suspendPayloadOf(result: unknown, step: string): Record<string, unknown> {
  const steps = (result as { steps?: Record<string, { suspendPayload?: Record<string, unknown> }> })
    .steps;
  const payload = steps?.[step]?.suspendPayload;
  expect(payload).toBeDefined();
  return payload!;
}

// ---------------------------------------------------------------------------
// case 1 — a dealer bound to B is EXCLUDED from A's send; A's other dealer submits
// ---------------------------------------------------------------------------

describe("dealership exclusivity — a dealer engaged by another search is dropped", () => {
  it("D (bound to B) is excluded from A's approved set; no row/no submit for D; OTHER still submits; voiced", async () => {
    seedProfile({ id: PROFILE_A, make: "Hyundai", model: "Tucson" });
    seedProfile({ id: PROFILE_B, make: "Honda", model: "Accord" });
    seedDealer({ dealerId: DEALER_D, name: "Shared Motors", website: "https://shared.example.com" });
    seedDealer({ dealerId: DEALER_OTHER, name: "A-Only Auto", website: "https://aonly.example.com" });

    // B already HOLDS D bound (the prior engagement). A wants BOTH D and OTHER.
    bindDealer({ profileId: PROFILE_B, dealerId: DEALER_D, status: "bound" });
    bindDealer({ profileId: PROFILE_A, dealerId: DEALER_D, status: "candidate" });
    bindDealer({ profileId: PROFILE_A, dealerId: DEALER_OTHER, status: "candidate" });

    const spy: SubmitSpy = { dealerIds: [] };
    __setDealerWebLeadSubmitDepsForTests({
      scoutForms: webFormScout(),
      submitOne: submitSpy(spy),
      sendAndRecord: sendNeverCalled,
      harnessGenerate: harnessNeverCalled,
    });

    const wf = leadWorkflow();
    const run = await wf.createRun({ runId: "excl-A-1" });
    const result = await run.start({
      inputData: { search_profile_id: PROFILE_A, target_listing_id: null, force_retry: false },
    });
    expect(result.status).toBe("suspended");

    // The card shows BOTH eligible dealers (the claim happens AFTER approval).
    const card = suspendPayloadOf(result, "batchReview");
    expect((card["targets"] as unknown[]).length).toBe(2);

    // A approves BOTH — the claim step then DROPS D (held by B) before any send.
    const final = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [DEALER_D, DEALER_OTHER] },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    const out = final.result as {
      outcome: string;
      submissions_successful: number;
      excluded_conflict_count: number;
      summary: string;
    };
    expect(out.outcome).toBe("scanned");

    // Exactly ONE submit fired — OTHER. D was dropped BEFORE the send seam.
    expect(spy.dealerIds).toEqual([DEALER_OTHER]);
    expect(out.submissions_successful).toBe(1);
    expect(out.excluded_conflict_count).toBe(1);

    // A wrote a lead_submissions row for OTHER only — NEVER for D.
    const aRows = leadRowsFor(PROFILE_A);
    expect(aRows.length).toBe(1);
    expect(aRows[0]!["dealer_id"]).toBe(DEALER_OTHER);
    expect(aRows.some((r) => r["dealer_id"] === DEALER_D)).toBe(false);

    // The exclusion is VOICED with B's vehicle label — and NEVER a budget.
    expect(out.summary).toContain("Excluded 1 dealer(s) already engaged by another of your searches");
    expect(out.summary).toContain("Honda Accord");
    expect(out.summary).not.toMatch(/\$|budget/i);

    // A's D row is marked excluded_conflict (it lost the claim); A's OTHER bound.
    expect(dealerStatus(PROFILE_A, DEALER_D)).toBe("excluded_conflict");
    expect(dealerStatus(PROFILE_A, DEALER_OTHER)).toBe("bound");
    // B's bound D is untouched.
    expect(dealerStatus(PROFILE_B, DEALER_D)).toBe("bound");
  });
});

// ---------------------------------------------------------------------------
// case 2 — closeout releases B's claims so A can then claim D
// ---------------------------------------------------------------------------

describe("dealership exclusivity — closeout releases the holder's claims", () => {
  it("closing B releases its bound D ('bound' → 'closed_out') so a fresh claimDealer for A succeeds", async () => {
    seedProfile({ id: PROFILE_A, make: "Hyundai", model: "Tucson" });
    seedProfile({ id: PROFILE_B, make: "Honda", model: "Accord" });
    seedDealerWithThread({
      dealerId: DEALER_D,
      name: "Shared Motors",
      threadId: "thread-shared-D",
      contactEmail: "sales@shared.example.com",
      profileId: PROFILE_B,
    });

    // B HOLDS D bound; A has a candidate row for D.
    bindDealer({ profileId: PROFILE_A, dealerId: DEALER_D, status: "candidate" });
    // The seedDealerWithThread bound D to B as 'bound'; promote nothing else.
    expect(dealerStatus(PROFILE_B, DEALER_D)).toBe("bound");

    // Before closeout: A cannot claim D (B holds it) → conflict, not 'claimed'.
    const before = claimDealer({ searchProfileId: PROFILE_A, dealerId: DEALER_D, db });
    expect(before.kind).toBe("conflict");
    // A's candidate row is now marked excluded_conflict by the failed claim.
    expect(dealerStatus(PROFILE_A, DEALER_D)).toBe("excluded_conflict");

    // Drive the REAL closeout workflow for B end-to-end: the per-dealer close is
    // stubbed (no live Gmail), but transition's REAL releaseDealerClaims wiring
    // fires when the run genuinely closes a thread.
    const closeCalls: string[] = [];
    __setDealerCloseoutEmailDepsForTests({
      closeAndSuppressDealer: closeStub(closeCalls),
    });

    const wf = closeoutWorkflow();
    const run = await wf.createRun({ runId: "excl-closeB-1" });
    const startResult = await run.start({ inputData: { search_profile_id: PROFILE_B } });
    expect(startResult.status).toBe("suspended");
    const card = suspendPayloadOf(startResult, "batchReview");
    expect((card["targets"] as unknown[]).length).toBe(1);

    const final = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [DEALER_D] },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    expect(closeCalls).toEqual([DEALER_D]);
    // B's profile is closed AND its bound D was released to 'closed_out'.
    expect(
      (db.$client.prepare("SELECT status FROM search_profiles WHERE search_profile_id = ?").get(PROFILE_B) as { status: string }).status,
    ).toBe("closed");
    expect(dealerStatus(PROFILE_B, DEALER_D)).toBe("closed_out");

    // D is now free → A's claim succeeds (the excluded row can retry).
    const after = claimDealer({ searchProfileId: PROFILE_A, dealerId: DEALER_D, db });
    expect(after.kind).toBe("claimed");
    expect(dealerStatus(PROFILE_A, DEALER_D)).toBe("bound");
  });
});
