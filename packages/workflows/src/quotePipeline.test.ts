/**
 * In-stack tests — the quote_pipeline flat ORCHESTRATOR workflow.
 *
 * These drive the REAL flat Mastra createWorkflow → REAL createRun/start/resume
 * chain (in-process against a tmp mastra.db) → REAL step closures, with the
 * runtime collaborators injected through the test-only deps seam: the child
 * composer (runChild) and the gated send (sendAndRecord) are deterministic
 * stubs, while the profile resolver, detectPipelineState, recordQuoteFromListing,
 * resolveTargetedListing and writePipelineCompletion run REAL against an ISOLATED
 * tmp data dir + autobroker.db (the committed migrations applied). NO real child
 * workflows are registered (the composer is stubbed), NO live LLM, no network.
 *
 * Coverage:
 *   - resolveProfile: pin-less 0-active → no_active_profile STOP; pin-less
 *     1-active → pin_required STOP (never silently run); pin-less 2+ →
 *     multiple_active_profiles STOP; a stale pin → pin_required STOP.
 *   - dry_run → `completed` would-run preview, ZERO writes (no audit_log row).
 *   - fan-out: every detected step's child completes → ok + ONE audit_log row;
 *     a child that suspends/fails → partial (that step not completed).
 *   - targeted-VIN: SEND suspend BEFORE any send; decline → `declined` (zero
 *     send, zero record); approve → gated send fired + recordQuoteFromListing
 *     (one dealer_quotes row), `completed` ok.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/restored);
 * mastra.db + autobroker.db live there; NEVER ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { AgentSelection } from "@autobroker/core";
import {
  closeDb,
  FakeGmailAdapter,
  openDb,
  sendAndRecord as sendAndRecordImpl,
  type Db,
} from "@autobroker/tools";

import {
  __clearAllRunSelectionsForTests,
  getRunSelection,
  setRunSelection,
} from "./agentSelection.js";

import { INCENTIVE_SCRAPE_WORKFLOW_ID } from "./incentiveScrape.js";
import { DEALER_REPLY_EXTRACT_WORKFLOW_ID } from "./dealerReplyExtract.js";
import { createMastraInstance } from "./mastra.js";
import { QUOTE_AUDIT_WORKFLOW_ID } from "./quoteAuditContracts.js";
import { QUOTE_COMPARE_WORKFLOW_ID } from "./quoteCompareContracts.js";
import {
  quotePipelineWorkflow,
  QUOTE_PIPELINE_WORKFLOW_ID,
  __resetQuotePipelineDepsForTests,
  __setQuotePipelineDepsForTests,
  type ChildRunOutcome,
} from "./quotePipeline.js";
import { quotePipelineOutputSchema } from "./quotePipelineContracts.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const MODE = "AUTOBROKER_MODE";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = [
  "0000_military_red_skull.sql",
  "0001_redundant_ozymandias.sql",
  "0002_pale_thunderball.sql",
].map((f) => join(here, "..", "..", "db", "drizzle", f));

const PROFILE_ID = "qp-tucson-1";

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;
let originalMode: string | undefined;

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  originalMode = process.env[MODE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-qp-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  process.env[MODE] = "test"; // a non-injected send resolves fake/local.
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
});

afterEach(() => {
  __resetQuotePipelineDepsForTests();
  __clearAllRunSelectionsForTests();
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
  if (originalMode === undefined) delete process.env[MODE];
  else process.env[MODE] = originalMode;
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function seedProfile(id = PROFILE_ID, status = "active", accountId = "acct-1"): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, trim, " +
        "search_radius_miles, location_query, postal_code, latitude, longitude, " +
        "follow_up_email, financing_preference, status, brand, account_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      2026,
      "Hyundai",
      "Tucson Hybrid",
      "SEL",
      50,
      "Tucson, AZ 85704",
      "85704",
      32.3,
      -110.9,
      "buyer@example.com",
      "finance",
      status,
      "Hyundai",
      accountId,
    );
}

/** Two unaudited dealer_quotes → audit + compare both fire. */
function seedTwoUnauditedQuotes(): void {
  const insert = db.$client.prepare(
    "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, " +
      "search_profile_id, otd_total, financing_mode) VALUES (?, ?, ?, ?, ?, ?, 'finance')",
  );
  insert.run("q1", "d1", "m1", "g1", PROFILE_ID, 31_500);
  insert.run("q2", "d2", "m2", "g2", PROFILE_ID, 33_995);
}

/** A targeted listing + its dealer's inbound thread/message (resolveTargetedListing
 *  needs the listing row + an inbound message on a profile-matched thread). */
function seedTargetedWorld(): { listingId: string } {
  const c = db.$client;
  c.prepare(
    "INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')",
  ).run("d-jim", "Jim Click Hyundai");
  c.prepare(
    "INSERT INTO inventory_listings (listing_id, search_profile_id, dealer_id, vin, stock_number, " +
      "inventory_status, match_status, raw_listing_json, first_seen_at, last_seen_at, observed_at) " +
      "VALUES (?, ?, ?, ?, ?, 'in_stock', 'matched', '{}', ?, ?, ?)",
  ).run("L1", PROFILE_ID, "d-jim", "5NMJ_TARGET_VIN", "STK7", Date.now(), Date.now(), Date.now());
  c.prepare(
    "INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id, updated_at) " +
      "VALUES (?, ?, ?, 'replied', ?, ?)",
  ).run("t1", "d-jim", "Re: Tucson", PROFILE_ID, Date.now());
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, direction, sender, body_text, search_profile_id, " +
      "gmail_message_id, received_at) VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?)",
  ).run("in-1", "t1", "sales@dealer.example", "We have one in stock.", PROFILE_ID, "gmail-in-1", Date.now());
  return { listingId: "L1" };
}

function workflow() {
  const mastra = createMastraInstance({
    workflows: { [QUOTE_PIPELINE_WORKFLOW_ID]: quotePipelineWorkflow as never },
  });
  return mastra.getWorkflow(QUOTE_PIPELINE_WORKFLOW_ID);
}

async function start(input: {
  search_profile_id?: string | null;
  dry_run?: boolean;
  target_listing_id?: string | null;
}) {
  const run = await workflow().createRun({ runId: `qp-${Math.random().toString(36).slice(2)}` });
  const result = await run.start({
    inputData: {
      search_profile_id: input.search_profile_id ?? null,
      dry_run: input.dry_run ?? false,
      target_listing_id: input.target_listing_id ?? null,
    },
  });
  return { run, result };
}

function statusOf(r: unknown): string {
  return (r as { status: string }).status;
}

function outputOf(r: unknown): Record<string, unknown> {
  return (r as { result: Record<string, unknown> }).result;
}

function errorMessageOf(r: unknown): string {
  const err = (r as { error?: unknown }).error;
  if (err instanceof Error) return err.message;
  if (err !== null && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err ?? "");
}

function auditLogCount(): number {
  const row = db.$client
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'quote_pipeline.complete'")
    .get() as { n: number };
  return row.n;
}

function quoteCount(): number {
  const row = db.$client.prepare("SELECT COUNT(*) AS n FROM dealer_quotes").get() as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// resolveProfile — the strict pin_required three-branch
// ---------------------------------------------------------------------------

describe("quote_pipeline resolveProfile (pin_required three-branch)", () => {
  it("pin-less, 0 active → no_active_profile STOP (zero writes)", async () => {
    const { result } = await start({ search_profile_id: null });
    expect(statusOf(result)).toBe("failed");
    expect(errorMessageOf(result)).toContain("No active search profile");
    expect(auditLogCount()).toBe(0);
  });

  it("pin-less, exactly 1 active → pin_required STOP (never silently run)", async () => {
    seedProfile();
    const { result } = await start({ search_profile_id: null });
    expect(statusOf(result)).toBe("failed");
    expect(errorMessageOf(result)).toContain("Pin a search first");
    expect(auditLogCount()).toBe(0);
  });

  it("pin-less, 2+ active → multiple_active_profiles STOP", async () => {
    seedProfile(PROFILE_ID);
    seedProfile("qp-tucson-2", "active", "acct-2");
    const { result } = await start({ search_profile_id: null });
    expect(statusOf(result)).toBe("failed");
    expect(errorMessageOf(result)).toContain("Pin a search first");
    expect(auditLogCount()).toBe(0);
  });

  it("a stale/closed pin → pin_required STOP", async () => {
    seedProfile(PROFILE_ID, "closed");
    const { result } = await start({ search_profile_id: PROFILE_ID });
    expect(statusOf(result)).toBe("failed");
    expect(errorMessageOf(result)).toContain("no longer active");
    expect(auditLogCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dry_run — the would-run preview (Δ=0)
// ---------------------------------------------------------------------------

describe("quote_pipeline dry_run", () => {
  it("returns a completed preview with ZERO writes and no child run", async () => {
    seedProfile();
    seedTwoUnauditedQuotes(); // audit + compare are applicable
    let childCalls = 0;
    __setQuotePipelineDepsForTests({
      runChild: async (): Promise<ChildRunOutcome> => {
        childCalls += 1;
        return "success";
      },
    });

    const { result } = await start({ search_profile_id: PROFILE_ID, dry_run: true });
    expect(statusOf(result)).toBe("success");
    const out = quotePipelineOutputSchema.parse(outputOf(result));
    if (out.outcome !== "completed") throw new Error("expected completed");
    expect(out.completedSteps).toEqual([]);
    expect(out.summary).toContain("Dry run");
    expect(out.summary).toContain("audit");
    expect(childCalls).toBe(0); // no child invoked
    expect(auditLogCount()).toBe(0); // ZERO writes
  });
});

// ---------------------------------------------------------------------------
// fan-out — compose the children; ok vs partial
// ---------------------------------------------------------------------------

describe("quote_pipeline fan-out", () => {
  it("every detected step's child completes → ok + exactly ONE audit_log row", async () => {
    seedProfile();
    seedTwoUnauditedQuotes(); // detect → audit + compare (no pending msg → no extract; no fresh-cache check fires scrape, but seed no incentives makes scrape applicable)
    const calledChildren: string[] = [];
    __setQuotePipelineDepsForTests({
      runChild: async (_m, childId): Promise<ChildRunOutcome> => {
        calledChildren.push(childId);
        return "success";
      },
    });

    const { result } = await start({ search_profile_id: PROFILE_ID });
    expect(statusOf(result)).toBe("success");
    const out = quotePipelineOutputSchema.parse(outputOf(result));
    if (out.outcome !== "completed") throw new Error("expected completed");
    expect(out.finalState).toBe("ok");
    // detect fires scrape (no fresh incentive), audit + compare (2 unaudited quotes).
    expect(out.completedSteps).toEqual(expect.arrayContaining(["scrape", "audit", "compare"]));
    expect(auditLogCount()).toBe(1); // exactly ONE completion row
  });

  it("a child that SUSPENDS (scrape OEM ask) → that step not completed → partial", async () => {
    seedProfile();
    seedTwoUnauditedQuotes();
    __setQuotePipelineDepsForTests({
      runChild: async (_m, childId): Promise<ChildRunOutcome> =>
        childId.includes("incentive") ? "suspended" : "success",
    });

    const { result } = await start({ search_profile_id: PROFILE_ID });
    expect(statusOf(result)).toBe("success");
    const out = quotePipelineOutputSchema.parse(outputOf(result));
    if (out.outcome !== "completed") throw new Error("expected completed");
    expect(out.finalState).toBe("partial");
    expect(out.completedSteps).not.toContain("scrape");
    expect(out.completedSteps).toEqual(expect.arrayContaining(["audit", "compare"]));
    expect(out.nextAction).toContain("scrape");
    expect(auditLogCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// targeted-VIN — SEND suspend → decline / approve
// ---------------------------------------------------------------------------

describe("quote_pipeline targeted-VIN", () => {
  it("decline at the SEND suspend → declined, zero send, zero record", async () => {
    seedProfile();
    const { listingId } = seedTargetedWorld();
    let sends = 0;
    __setQuotePipelineDepsForTests({
      sendAndRecord: async () => {
        sends += 1;
        return { kind: "declined", messageRowId: null };
      },
    });

    const { run, result } = await start({ search_profile_id: PROFILE_ID, target_listing_id: listingId });
    expect(statusOf(result)).toBe("suspended");

    const final = await run.resume({ step: "targeted", resumeData: { action: "decline" } });
    expect(statusOf(final)).toBe("success");
    const out = quotePipelineOutputSchema.parse(outputOf(final));
    expect(out.outcome).toBe("declined");
    expect(sends).toBe(0);
    expect(quoteCount()).toBe(0); // zero record write
    expect(auditLogCount()).toBe(0); // targeted never writes a completion row
  });

  it("approve → gated send fired + one recorded quote, completed ok", async () => {
    seedProfile();
    const { listingId } = seedTargetedWorld();
    let sentBody = "";
    __setQuotePipelineDepsForTests({
      sendAndRecord: async (target) => {
        sentBody = target.email.body;
        // The send LANDED (a fake-mailbox send in test mode resolves `sent`).
        return { kind: "sent", messageRowId: "m-sent", gmailMessageId: "g-sent", mode: "fake" };
      },
    });

    const { run, result } = await start({ search_profile_id: PROFILE_ID, target_listing_id: listingId });
    expect(statusOf(result)).toBe("suspended");

    const final = await run.resume({ step: "targeted", resumeData: { action: "approve" } });
    expect(statusOf(final)).toBe("success");
    const out = quotePipelineOutputSchema.parse(outputOf(final));
    if (out.outcome !== "completed") throw new Error("expected completed");
    expect(out.finalState).toBe("ok");
    expect(out.completedSteps).toEqual([]);
    // the OTD ask carried the VIN-specific injection and no budget figure.
    expect(sentBody).toContain("5NMJ_TARGET_VIN");
    // recordQuoteFromListing wrote exactly one dealer_quotes row on the real inbound msg.
    expect(quoteCount()).toBe(1);
    const row = db.$client
      .prepare("SELECT source_listing_id, message_id, vin FROM dealer_quotes")
      .get() as { source_listing_id: string; message_id: string; vin: string };
    expect(row.source_listing_id).toBe(listingId);
    expect(row.message_id).toBe("in-1");
    expect(row.vin).toBe("5NMJ_TARGET_VIN");
  });

  it("a missing listing → typed STOP (never a crash)", async () => {
    seedProfile();
    const { result } = await start({ search_profile_id: PROFILE_ID, target_listing_id: "nope" });
    expect(statusOf(result)).toBe("failed");
    expect(errorMessageOf(result)).toContain("listing was not found");
  });

  // SEND-STATUS TRUTHFULNESS: a send that did NOT complete (a `partial` outcome —
  // the send threw AFTER the draft was inserted) must NOT record a quote and must
  // NOT report finalState "ok" / "sent"; it surfaces a stop-and-reconcile instead.
  // Against the pre-fix unconditional code this FAILS (recordQuoteFromListing was
  // called and finalState was "ok").
  it("approve but the send returns partial → NOT recorded, non-sent reconcile result", async () => {
    seedProfile();
    const { listingId } = seedTargetedWorld();
    let sends = 0;
    __setQuotePipelineDepsForTests({
      // The gate fired (the send WAS attempted) but the send threw after its draft
      // was inserted → a `partial` outcome (retained draft, gmail id still NULL).
      sendAndRecord: async () => {
        sends += 1;
        return {
          kind: "partial",
          messageRowId: "m-draft",
          partial: {
            message_recorded: true,
            state_updated: false,
            reconcile_hint: "send_failed_draft_retained",
            external_id: null,
          },
        };
      },
    });

    const { run, result } = await start({ search_profile_id: PROFILE_ID, target_listing_id: listingId });
    expect(statusOf(result)).toBe("suspended");

    const final = await run.resume({ step: "targeted", resumeData: { action: "approve" } });
    expect(statusOf(final)).toBe("success");
    const out = quotePipelineOutputSchema.parse(outputOf(final));
    if (out.outcome !== "completed") throw new Error("expected completed");

    // The send was attempted (the gate fired) but did NOT complete.
    expect(sends).toBe(1);
    // (a) recordQuoteFromListing was NOT called — zero dealer_quotes rows.
    expect(quoteCount()).toBe(0);
    // (b) the result is the not-sent shape — NOT finalState "ok".
    expect(out.finalState).not.toBe("ok");
    expect(out.finalState).toBe("partial");
    // (c) the reconcile hint is surfaced (and it never claims the ask was sent).
    expect(out.summary).toContain("did NOT send");
    expect(out.nextAction).toContain("send_failed_draft_retained");
    expect(out.nextAction).toContain("reconcile");
    // The targeted lane never writes a completion row.
    expect(auditLogCount()).toBe(0);
  });

  // The REAL sendAndRecord path (NOT a stub): the orchestrator builds a thread
  // reply target (threadId + inReplyToGmailId paired from the real inbound's
  // gmail_message_id), so validateThreadFlags must NOT throw. In test mode the
  // injected FakeGmailAdapter resolves a FAKE/local send (no real send), so one
  // outbound messages row is written, while the LOCAL recordQuoteFromListing also
  // writes one dealer_quotes row on the real inbound message id.
  it("approve through the REAL sendAndRecord in test mode → thread flags pair, fake send, one recorded quote", async () => {
    seedProfile();
    const { listingId } = seedTargetedWorld();
    let realSendCalled = false;
    __setQuotePipelineDepsForTests({
      // Drive the REAL sendAndRecord against a FakeGmailAdapter + the test DB.
      sendAndRecord: async (target, sendDeps) => {
        realSendCalled = true;
        return sendAndRecordImpl(target, {
          ...sendDeps,
          adapter: new FakeGmailAdapter(db),
          db,
        });
      },
    });
    const beforeOutbound = db.$client
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'outbound'")
      .get() as { n: number };

    const { run, result } = await start({ search_profile_id: PROFILE_ID, target_listing_id: listingId });
    expect(statusOf(result)).toBe("suspended");

    // validateThreadFlags throwing would surface here as a FAILED resume — assert
    // success (the flags now pair) instead.
    const final = await run.resume({ step: "targeted", resumeData: { action: "approve" } });
    expect(statusOf(final)).toBe("success");
    const out = quotePipelineOutputSchema.parse(outputOf(final));
    if (out.outcome !== "completed") throw new Error("expected completed");
    expect(out.finalState).toBe("ok");
    expect(realSendCalled).toBe(true);

    // Test mode → the FAKE send writes exactly one outbound row (no real send).
    const afterOutbound = db.$client
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'outbound'")
      .get() as { n: number };
    expect(afterOutbound.n).toBe(beforeOutbound.n + 1);

    // recordQuoteFromListing wrote exactly one dealer_quotes row on the REAL inbound msg.
    expect(quoteCount()).toBe(1);
    const row = db.$client
      .prepare("SELECT message_id, source_listing_id FROM dealer_quotes")
      .get() as { message_id: string; source_listing_id: string };
    expect(row.message_id).toBe("in-1");
    expect(row.source_listing_id).toBe(listingId);
  });

  // A 2nd targeted approve on the SAME listing/financing must replay cleanly:
  // the deterministic quote_id makes recordQuoteFromListing return {recorded:false}
  // (no duplicate row, no (source_gmail_message_id, financing_mode) UNIQUE throw).
  it("a re-run on the same listing is idempotent → no duplicate quote, no throw", async () => {
    seedProfile();
    const { listingId } = seedTargetedWorld();
    __setQuotePipelineDepsForTests({
      sendAndRecord: async () => ({
        kind: "sent",
        messageRowId: "m-sent",
        gmailMessageId: "g-sent",
        mode: "fake",
      }),
    });

    const run1 = await start({ search_profile_id: PROFILE_ID, target_listing_id: listingId });
    expect(statusOf(run1.result)).toBe("suspended");
    const final1 = await run1.run.resume({ step: "targeted", resumeData: { action: "approve" } });
    const out1 = quotePipelineOutputSchema.parse(outputOf(final1));
    if (out1.outcome !== "completed") throw new Error("expected completed");
    expect(out1.finalState).toBe("ok"); // recorded:true → ok
    expect(quoteCount()).toBe(1);

    // 2nd run, same listing → deterministic quote_id replays clean.
    const run2 = await start({ search_profile_id: PROFILE_ID, target_listing_id: listingId });
    expect(statusOf(run2.result)).toBe("suspended");
    const final2 = await run2.run.resume({ step: "targeted", resumeData: { action: "approve" } });
    expect(statusOf(final2)).toBe("success"); // no SQLITE_CONSTRAINT throw
    const out2 = quotePipelineOutputSchema.parse(outputOf(final2));
    if (out2.outcome !== "completed") throw new Error("expected completed");
    expect(out2.finalState).toBe("no_work"); // recorded:false → no_work
    expect(quoteCount()).toBe(1); // still exactly one row
  });
});

// ---------------------------------------------------------------------------
// child-run reap — an abandoned scrape-suspend must NOT linger as a dangling
// re-attachable run (the O2 "dangling bomb" anti-pattern).
// ---------------------------------------------------------------------------

describe("quote_pipeline child-run reap (no dangling suspend)", () => {
  const PASSTHROUGH_IO = z.object({ search_profile_id: z.string() });

  /** A minimal child workflow that SUSPENDS once on first run (modeling the
   *  incentive_scrape OEM first-encounter ask the orchestrator runs
   *  autonomously). The orchestrator must reap this abandoned run rather than
   *  leave it re-attachable. */
  function suspendingChild(id: string) {
    const step = createStep({
      id: "askOem",
      inputSchema: PASSTHROUGH_IO,
      outputSchema: PASSTHROUGH_IO,
      suspendSchema: z.object({}),
      resumeSchema: z.object({}),
      execute: async ({ inputData, resumeData, suspend }) => {
        if (resumeData === undefined) return (await suspend({})) as never;
        return inputData;
      },
    });
    return createWorkflow({ id, inputSchema: PASSTHROUGH_IO, outputSchema: PASSTHROUGH_IO })
      .then(step)
      .commit();
  }

  /** A trivial child workflow that succeeds immediately (models a clean child). */
  function succeedingChild(id: string) {
    const step = createStep({
      id: "noop",
      inputSchema: PASSTHROUGH_IO,
      outputSchema: PASSTHROUGH_IO,
      execute: async ({ inputData }) => inputData,
    });
    return createWorkflow({ id, inputSchema: PASSTHROUGH_IO, outputSchema: PASSTHROUGH_IO })
      .then(step)
      .commit();
  }

  it("an abandoned scrape-suspend is reaped → zero suspended runs in storage", async () => {
    seedProfile();
    seedTwoUnauditedQuotes(); // detect → scrape + audit + compare applicable

    // Register the orchestrator AND all three detected children on ONE Mastra
    // instance, then drive the REAL runChildImpl (runChild NOT stubbed) so the
    // abandon+reap path actually executes for the suspending scrape child.
    const mastra = createMastraInstance({
      workflows: {
        [QUOTE_PIPELINE_WORKFLOW_ID]: quotePipelineWorkflow as never,
        [INCENTIVE_SCRAPE_WORKFLOW_ID]: suspendingChild(INCENTIVE_SCRAPE_WORKFLOW_ID) as never,
        [QUOTE_AUDIT_WORKFLOW_ID]: succeedingChild(QUOTE_AUDIT_WORKFLOW_ID) as never,
        [QUOTE_COMPARE_WORKFLOW_ID]: succeedingChild(QUOTE_COMPARE_WORKFLOW_ID) as never,
        [DEALER_REPLY_EXTRACT_WORKFLOW_ID]: succeedingChild(DEALER_REPLY_EXTRACT_WORKFLOW_ID) as never,
      },
    });
    const orchestrator = mastra.getWorkflow(QUOTE_PIPELINE_WORKFLOW_ID);

    const run = await orchestrator.createRun({ runId: `qp-reap-${Math.random().toString(36).slice(2)}` });
    const result = await run.start({
      inputData: { search_profile_id: PROFILE_ID, dry_run: false, target_listing_id: null },
    });
    expect(statusOf(result)).toBe("success");
    const out = quotePipelineOutputSchema.parse(outputOf(result));
    if (out.outcome !== "completed") throw new Error("expected completed");
    expect(out.finalState).toBe("partial"); // scrape suspended → not completed
    expect(out.completedSteps).not.toContain("scrape");

    // The reap: the abandoned scrape child run must NOT linger as a suspended
    // (re-attachable) run — recoverOnBoot scans listWorkflowRuns({status:'suspended'}).
    const scrapeChild = mastra.getWorkflow(INCENTIVE_SCRAPE_WORKFLOW_ID);
    const suspended = await scrapeChild.listWorkflowRuns({ status: "suspended" });
    expect(suspended.runs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// per-run AgentSelection propagation — the parent's provider selection must
// flow onto EVERY fan-out child run (selecting Claude routes every useCase),
// run-scoped + cleared (no childRunId leak).
// ---------------------------------------------------------------------------

describe("quote_pipeline fan-out AgentSelection propagation", () => {
  const PASSTHROUGH_IO = z.object({ search_profile_id: z.string() });

  /** A trivial child that records its own runId + the selection visible to its
   *  harness.generate boundary (resolveSelectionForRun's registry hit), so the
   *  test can assert the parent's selection was re-homed onto the child run. */
  function selectionCapturingChild(
    id: string,
    seen: { runId: string; sel: AgentSelection | undefined }[],
  ) {
    const step = createStep({
      id: "cap",
      inputSchema: PASSTHROUGH_IO,
      outputSchema: PASSTHROUGH_IO,
      execute: async ({ inputData, runId }) => {
        seen.push({ runId, sel: getRunSelection(runId) });
        return inputData;
      },
    });
    return createWorkflow({ id, inputSchema: PASSTHROUGH_IO, outputSchema: PASSTHROUGH_IO })
      .then(step)
      .commit();
  }

  function fanOutMastra(seen: { runId: string; sel: AgentSelection | undefined }[]) {
    return createMastraInstance({
      workflows: {
        [QUOTE_PIPELINE_WORKFLOW_ID]: quotePipelineWorkflow as never,
        [INCENTIVE_SCRAPE_WORKFLOW_ID]: selectionCapturingChild(INCENTIVE_SCRAPE_WORKFLOW_ID, seen) as never,
        [QUOTE_AUDIT_WORKFLOW_ID]: selectionCapturingChild(QUOTE_AUDIT_WORKFLOW_ID, seen) as never,
        [QUOTE_COMPARE_WORKFLOW_ID]: selectionCapturingChild(QUOTE_COMPARE_WORKFLOW_ID, seen) as never,
        [DEALER_REPLY_EXTRACT_WORKFLOW_ID]: selectionCapturingChild(DEALER_REPLY_EXTRACT_WORKFLOW_ID, seen) as never,
      },
    });
  }

  it("a parent selection is re-homed onto each child run, then cleared (no leak)", async () => {
    seedProfile();
    seedTwoUnauditedQuotes(); // detect → scrape + audit + compare applicable

    const parentSel: AgentSelection = {
      provider: "anthropic",
      method: "oauth",
      model: null,
      effort: "off",
    };
    const seen: { runId: string; sel: AgentSelection | undefined }[] = [];
    const mastra = fanOutMastra(seen);
    const orchestrator = mastra.getWorkflow(QUOTE_PIPELINE_WORKFLOW_ID);

    const parentRunId = `qp-sel-${Math.random().toString(36).slice(2)}`;
    setRunSelection(parentRunId, parentSel); // mirror the server's per-run registration

    const run = await orchestrator.createRun({ runId: parentRunId });
    const result = await run.start({
      inputData: { search_profile_id: PROFILE_ID, dry_run: false, target_listing_id: null },
    });
    expect(statusOf(result)).toBe("success");

    // Every fan-out child saw the PARENT's selection at its harness boundary.
    expect(seen.length).toBeGreaterThanOrEqual(3); // scrape + audit + compare
    for (const entry of seen) {
      expect(entry.sel).toEqual(parentSel);
      expect(entry.runId).not.toBe(parentRunId); // a distinct child runId
    }

    // Run-scoped + cleared: no childRunId lingers in the registry after the run.
    for (const entry of seen) {
      expect(getRunSelection(entry.runId)).toBeUndefined();
    }
    // The parent's own registration is untouched (the server still owns it).
    expect(getRunSelection(parentRunId)).toEqual(parentSel);
  });

  it("no parent selection → children resolve nothing (DeepSeek default preserved)", async () => {
    seedProfile();
    seedTwoUnauditedQuotes();

    const seen: { runId: string; sel: AgentSelection | undefined }[] = [];
    const mastra = fanOutMastra(seen);
    const orchestrator = mastra.getWorkflow(QUOTE_PIPELINE_WORKFLOW_ID);

    const parentRunId = `qp-nosel-${Math.random().toString(36).slice(2)}`;
    // NO setRunSelection for the parent → nothing to propagate.
    const run = await orchestrator.createRun({ runId: parentRunId });
    const result = await run.start({
      inputData: { search_profile_id: PROFILE_ID, dry_run: false, target_listing_id: null },
    });
    expect(statusOf(result)).toBe("success");

    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const entry of seen) {
      expect(entry.sel).toBeUndefined(); // nothing registered for any child
    }
  });
});
