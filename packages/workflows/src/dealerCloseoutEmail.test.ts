/**
 * In-stack tests — the dealer_closeout_email flat workflow (the Phase-5 EXIT
 * skill). These drive the REAL flat Mastra createWorkflow → REAL createRun/start/
 * resume chain (in-process against a tmp mastra.db) → REAL step closures, against
 * an ISOLATED tmp autobroker.db (the committed migrations applied). The profile
 * resolver, assembleCloseoutTargets, and the deterministic closeout-draft
 * templates run REAL; the atomic closeAndSuppressDealer is exercised BOTH ways:
 *   - injected as a stub that performs the real local close+suppress writes (the
 *     `closed` model) for the suspend/decline/skip-all branches, and
 *   - driven REAL (against the default FakeGmailAdapter in test mode) in one
 *     focused case — a promoted `messages` row + the body byte-match.
 * NO real Gmail, NO LLM, no network.
 *
 * TEST MODE is the floor (the global vitest setup pins AUTOBROKER_MODE=test, and
 * AUTOBROKER_TEST_AUTO_APPROVE is never set): the send resolves fake/local, the
 * gate stays live, the close + suppression row are written, the thread flips to
 * 'closed', and the profile transitions to 'closed' on completion.
 *
 * Acceptance (the brief's 8):
 *   1. unpinned (1 active) → STOP pin_required (NOT a run), zero rows;
 *   2. decline at ① → terminal `declined`, ZERO messages + ZERO threads/
 *      search_profiles state changes + ZERO thread_suppression rows;
 *   3. SEND → per dealer threads.state='closed' + 1 thread_suppression row
 *      (reason 'closeout:…') + on completion search_profiles.status='closed';
 *      the default body byte-matches the canonical template (the real tool, test mode);
 *   4. SKIP ALL → the typed `skip_all_reset` result, 0 sends, 0 state changes;
 *   5. a no-address dealer is skipped + the skip count is shown;
 *   6. idempotent: a 2nd run with the dealer already closeout-suppressed → no-op;
 *   7. zero candidates → a graceful exit (not an error, no suspend);
 *   8. NO DELETE is ever issued (state-only).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/restored);
 * mastra.db + autobroker.db both live there; NEVER ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCloseoutDraft, closeDb, openDb, type Db } from "@autobroker/tools";

import { createMastraInstance } from "./mastra.js";
import {
  dealerCloseoutEmailWorkflow,
  DEALER_CLOSEOUT_EMAIL_WORKFLOW_ID,
  __resetDealerCloseoutEmailDepsForTests,
  __setDealerCloseoutEmailDepsForTests,
  type DealerCloseoutEmailWorkflowDeps,
} from "./dealerCloseoutEmail.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";
const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = [
  "0000_military_red_skull.sql",
  "0001_redundant_ozymandias.sql",
  "0002_pale_thunderball.sql",
  "0008_graceful_magdalene.sql",
].map((f) => join(here, "..", "..", "db", "drizzle", f));

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

const PROFILE_ID = "prof-closeout-1";
const DEALER_A = "dealer-jim-click"; // addressable (dealer contact_email) + open thread
const DEALER_B = "dealer-tucson-kia"; // addressable + open thread
const DEALER_NOADDR = "dealer-no-address"; // bound + open thread, NO reply address
const THREAD_A = "thread-jim-click";
const THREAD_B = "thread-tucson-kia";
const THREAD_NOADDR = "thread-no-address";

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-closeout-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  // AUTOBROKER_MODE=test is the global vitest floor; the default send resolves fake.
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
});

afterEach(() => {
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

function seedProfile(over: { id?: string; make?: string; model?: string } = {}): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, trim, " +
        "search_radius_miles, location_query, postal_code, follow_up_email, " +
        "financing_preference, status, brand, account_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
    )
    .run(
      over.id ?? PROFILE_ID,
      2026,
      over.make ?? "Hyundai",
      over.model ?? "Tucson Hybrid",
      "Limited",
      50,
      "Tucson, AZ 85704",
      "92614",
      "jordan.buyer@example.com",
      "finance",
      over.make ?? "Hyundai",
      "acct-test-1",
    );
}

/** Bind a US dealer (optionally addressable via contact_email) to the profile and
 *  give it an OPEN thread + one inbound message. A null contactEmail dealer with
 *  no contacts/inbound is the no-address case (skipped before the gate). */
function seedBoundDealerWithThread(over: {
  dealerId: string;
  name: string;
  threadId: string;
  contactEmail?: string | null;
  profileId?: string;
}): void {
  const c = db.$client;
  const profileId = over.profileId ?? PROFILE_ID;
  c.prepare(
    "INSERT INTO dealers (dealer_id, name, country, website, contact_email) VALUES (?, ?, 'US', ?, ?)",
  ).run(over.dealerId, over.name, `https://${over.dealerId}.example.com`, over.contactEmail ?? null);
  c.prepare(
    "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
  ).run(profileId, over.dealerId);
  // An OPEN (non closed/agreed) thread with a backend id, so a reply rides the
  // existing thread (both reply flags travel together).
  c.prepare(
    "INSERT INTO threads (thread_id, dealer_id, gmail_thread_id, subject, state, search_profile_id) " +
      "VALUES (?, ?, ?, ?, 'replied', ?)",
  ).run(over.threadId, over.dealerId, `gmail-${over.threadId}`, "Quote request", profileId);
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, sender, " +
      "recipient, subject, body_text, processed_at, search_profile_id, quote_extraction_status) " +
      "VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, 'pending')",
  ).run(
    `inbound-${over.threadId}`,
    over.threadId,
    `gmail-msg-${over.threadId}`,
    over.contactEmail ?? "noreply@example.com",
    "jordan.buyer@example.com",
    "Quote request",
    "Here is your quote.",
    new Date().toISOString(),
    profileId,
  );
}

/** A prior closeout suppression row for a dealer (the idempotency-floor seed). */
function seedCloseoutSuppression(over: { dealerId: string; threadId: string; profileId?: string }): void {
  const profileId = over.profileId ?? PROFILE_ID;
  db.$client
    .prepare(
      "INSERT INTO thread_suppression (suppression_id, thread_id, dealer_id, gmail_thread_id, " +
        "scope, action, reason, approved_by, approved_at, search_profile_id) " +
        "VALUES (?, ?, ?, ?, 'dealer', 'suppress', ?, 'user', ?, ?)",
    )
    .run(
      `closeout:${profileId}:${over.dealerId}`,
      over.threadId,
      over.dealerId,
      `gmail-${over.threadId}`,
      `closeout:${profileId}`,
      new Date().toISOString(),
      profileId,
    );
}

function count(table: string): number {
  const r = db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return r.n;
}

function threadState(threadId: string): string | null {
  const r = db.$client
    .prepare("SELECT state FROM threads WHERE thread_id = ?")
    .get(threadId) as { state: string } | undefined;
  return r?.state ?? null;
}

function profileStatus(id: string): string | null {
  const r = db.$client
    .prepare("SELECT status FROM search_profiles WHERE search_profile_id = ?")
    .get(id) as { status: string } | undefined;
  return r?.status ?? null;
}

function suppressionRows(): Array<Record<string, unknown>> {
  return db.$client.prepare("SELECT * FROM thread_suppression").all() as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// closeAndSuppressDealer stub — models the `closed` outcome by
// performing the SAME local close+suppress writes the real tool commits (so the
// suspend/decline/skip-all branches assert the deltas without a live Gmail send).
// Records every dealer it was called for + the body/subject it received.
// ---------------------------------------------------------------------------

interface CloseCall {
  dealerId: string;
  threadId: string | null;
  body: string;
  subject: string;
  fromEmail: string;
}

function closeStub(record: {
  calls: CloseCall[];
  shortCircuitDealerIds?: Set<string>;
}): DealerCloseoutEmailWorkflowDeps["closeAndSuppressDealer"] {
  return async (args) => {
    record.calls.push({
      dealerId: args.target.dealerId,
      threadId: args.target.threadId,
      body: args.body,
      subject: args.subject,
      fromEmail: args.fromEmail,
    });
    if (record.shortCircuitDealerIds?.has(args.target.dealerId)) {
      return { kind: "short_circuit", reconcileHint: "gate_declined" };
    }
    // Mirror the `sent` local writes (close + suppress in one go).
    const suppressionId = `closeout:${args.searchProfileId}:${args.target.dealerId}`;
    const reason = `closeout:${args.searchProfileId}`;
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
        suppressionId,
        args.target.threadId,
        args.target.dealerId,
        args.target.gmailThreadId,
        reason,
        new Date().toISOString(),
        args.searchProfileId,
      );
    });
    txn();
    return { kind: "closed", messageRowId: null, sendBlocked: false };
  };
}

const closeNeverCalled: DealerCloseoutEmailWorkflowDeps["closeAndSuppressDealer"] = async () => {
  throw new Error("closeAndSuppressDealer must not be called on this path");
};

// ---------------------------------------------------------------------------
// run/resume drivers
// ---------------------------------------------------------------------------

function closeoutWorkflow() {
  const mastra = createMastraInstance({
    workflows: { [DEALER_CLOSEOUT_EMAIL_WORKFLOW_ID]: dealerCloseoutEmailWorkflow as never },
  });
  return mastra.getWorkflow(DEALER_CLOSEOUT_EMAIL_WORKFLOW_ID);
}

async function startRun(runId: string, input: { search_profile_id: string | null }) {
  const wf = closeoutWorkflow();
  const run = await wf.createRun({ runId });
  const result = await run.start({ inputData: { search_profile_id: input.search_profile_id } });
  return { run, result };
}

function suspendPayloadOf(result: unknown, step: string): Record<string, unknown> {
  const steps = (result as { steps?: Record<string, { suspendPayload?: Record<string, unknown> }> })
    .steps;
  const payload = steps?.[step]?.suspendPayload;
  expect(payload).toBeDefined();
  return payload!;
}

function errorMessageOf(result: unknown): string {
  const err = (result as { error?: unknown }).error;
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err !== null && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "";
}

// ---------------------------------------------------------------------------
// case 1 — explicit-pin REQUIRED (the resolve step never infers)
// ---------------------------------------------------------------------------

describe("dealer_closeout_email — explicit pin required", () => {
  it("STOPs with pin_required (NOT a run) on a pin-less input with 1 active profile", async () => {
    seedProfile();
    seedBoundDealerWithThread({
      dealerId: DEALER_A,
      name: "Jim Click Hyundai",
      threadId: THREAD_A,
      contactEmail: "sales@jimclick.example.com",
    });
    __setDealerCloseoutEmailDepsForTests({ closeAndSuppressDealer: closeNeverCalled });

    const { result } = await startRun("co-pinless-1", { search_profile_id: null });
    expect(result.status).toBe("failed");
    const msg = errorMessageOf(result);
    expect(msg).toContain("Pin a search first");
    expect(msg).toContain("Tucson Hybrid");
    expect(count("messages")).toBe(1); // only the seeded inbound; no new rows.
    expect(count("thread_suppression")).toBe(0);
  });

  it("STOPs with no_active_profile on a pin-less input with 0 active profiles", async () => {
    __setDealerCloseoutEmailDepsForTests({ closeAndSuppressDealer: closeNeverCalled });
    const { result } = await startRun("co-none-1", { search_profile_id: null });
    expect(result.status).toBe("failed");
    expect(errorMessageOf(result)).toContain("No active search profile");
  });
});

// ---------------------------------------------------------------------------
// case 2 — decline at ① → terminal declined, ZERO writes / ZERO state changes
// ---------------------------------------------------------------------------

describe("dealer_closeout_email — decline at the batch card", () => {
  it("decline at ① → `declined`, ZERO suppression + threads/profile state unchanged", async () => {
    seedProfile();
    seedBoundDealerWithThread({
      dealerId: DEALER_A,
      name: "Jim Click Hyundai",
      threadId: THREAD_A,
      contactEmail: "sales@jimclick.example.com",
    });
    const sends = { calls: [] as CloseCall[] };
    __setDealerCloseoutEmailDepsForTests({ closeAndSuppressDealer: closeStub(sends) });

    const { run, result } = await startRun("co-decline-1", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("suspended");
    const payload = suspendPayloadOf(result, "batchReview");
    expect(payload["kind"]).toBe("batch_review");
    expect((payload["targets"] as unknown[]).length).toBe(1);

    const final = await run.resume({ step: "batchReview", resumeData: { action: "decline" } });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    expect((final.result as { outcome: string }).outcome).toBe("declined");

    // ZERO writes, ZERO state changes.
    expect(sends.calls.length).toBe(0);
    expect(count("thread_suppression")).toBe(0);
    expect(threadState(THREAD_A)).toBe("replied"); // unchanged.
    expect(profileStatus(PROFILE_ID)).toBe("active"); // unchanged.
  });
});

// ---------------------------------------------------------------------------
// case 3 — SEND (the stub-driven happy path): close + suppress + profile flip
// ---------------------------------------------------------------------------

describe("dealer_closeout_email — approve the batch (close + suppress)", () => {
  it("approve ① → per dealer threads.state='closed' + 1 suppression row + profile 'closed'", async () => {
    seedProfile();
    seedBoundDealerWithThread({
      dealerId: DEALER_A,
      name: "Jim Click Hyundai",
      threadId: THREAD_A,
      contactEmail: "sales@jimclick.example.com",
    });
    seedBoundDealerWithThread({
      dealerId: DEALER_B,
      name: "Tucson Kia",
      threadId: THREAD_B,
      contactEmail: "sales@tucsonkia.example.com",
    });
    const sends = { calls: [] as CloseCall[] };
    __setDealerCloseoutEmailDepsForTests({ closeAndSuppressDealer: closeStub(sends) });

    const { run, result } = await startRun("co-approve-1", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("suspended");
    expect((suspendPayloadOf(result, "batchReview")["targets"] as unknown[]).length).toBe(2);

    const final = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [DEALER_A, DEALER_B] },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    const out = final.result as {
      outcome: string;
      closed_thread_ids: string[];
      emails_sent: number;
      profile_status_transition: string;
      skipped_no_address: number;
    };
    expect(out.outcome).toBe("sent");
    expect(out.closed_thread_ids.sort()).toEqual([THREAD_A, THREAD_B].sort());
    expect(out.emails_sent).toBe(2);
    expect(out.profile_status_transition).toBe("closed");
    expect(out.skipped_no_address).toBe(0);

    // The closeout subject is UNCONDITIONALLY the open thread's subject re-cast as
    // a reply (subjectForFollowup) so the closeout lands in the conversation — the
    // seeded threads carry "Quote request", so every send is "Re: Quote request".
    expect(sends.calls.map((c) => c.subject)).toEqual(["Re: Quote request", "Re: Quote request"]);

    // Per dealer: thread closed + a 'closeout:'-reason suppression row.
    expect(threadState(THREAD_A)).toBe("closed");
    expect(threadState(THREAD_B)).toBe("closed");
    const rows = suppressionRows();
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(String(r["reason"]).startsWith("closeout:")).toBe(true);
      expect(r["scope"]).toBe("dealer");
      expect(r["action"]).toBe("suppress");
      expect(r["approved_by"]).toBe("user");
    }
    // The profile transitioned to 'closed' on completion.
    expect(profileStatus(PROFILE_ID)).toBe("closed");

    // The default body byte-matches the canonical template (no LLM, no EDIT).
    const expectedBody = buildCloseoutDraft({ year: 2026, make: "Hyundai", model: "Tucson Hybrid" }, {});
    expect(sends.calls.every((c) => c.body === expectedBody)).toBe(true);
  });

  it("approving ONLY one dealer closes only that dealer (the explicit id list)", async () => {
    seedProfile();
    seedBoundDealerWithThread({
      dealerId: DEALER_A,
      name: "Jim Click Hyundai",
      threadId: THREAD_A,
      contactEmail: "sales@jimclick.example.com",
    });
    seedBoundDealerWithThread({
      dealerId: DEALER_B,
      name: "Tucson Kia",
      threadId: THREAD_B,
      contactEmail: "sales@tucsonkia.example.com",
    });
    const sends = { calls: [] as CloseCall[] };
    __setDealerCloseoutEmailDepsForTests({ closeAndSuppressDealer: closeStub(sends) });

    const { run, result } = await startRun("co-approve-one", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("suspended");
    const final = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [DEALER_A] },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    expect(sends.calls.map((c) => c.dealerId)).toEqual([DEALER_A]);
    expect(threadState(THREAD_A)).toBe("closed");
    expect(threadState(THREAD_B)).toBe("replied"); // not approved → untouched.
    expect(count("thread_suppression")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// case 4 — SKIP ALL → the typed skip_all_reset result (NOT a failure)
// ---------------------------------------------------------------------------

describe("dealer_closeout_email — SKIP ALL (the reset hand-off)", () => {
  it("approve with no reviewed-target ids → `skip_all_reset` typed result, 0 sends, 0 state changes", async () => {
    seedProfile();
    seedBoundDealerWithThread({
      dealerId: DEALER_A,
      name: "Jim Click Hyundai",
      threadId: THREAD_A,
      contactEmail: "sales@jimclick.example.com",
    });
    const sends = { calls: [] as CloseCall[] };
    __setDealerCloseoutEmailDepsForTests({ closeAndSuppressDealer: closeStub(sends) });

    const { run, result } = await startRun("co-skipall-1", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("suspended");

    // "SKIP ALL": the user skipped every row, so the approved set carries an id
    // that is NOT one of the reviewed targets → it intersects to zero. This is the
    // typed reset hand-off, NOT a throw / failure.
    const final = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: ["__skip_all__"] },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    const out = final.result as { outcome: string; reset_requested?: boolean; summary?: string };
    expect(out.outcome).toBe("skip_all_reset");
    expect(out.reset_requested).toBe(true);
    expect(out.summary).toContain("reset requested");

    // 0 sends, 0 state changes.
    expect(sends.calls.length).toBe(0);
    expect(count("thread_suppression")).toBe(0);
    expect(threadState(THREAD_A)).toBe("replied");
    expect(profileStatus(PROFILE_ID)).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// case 5 — a no-address dealer is skipped + the skip count is shown
// ---------------------------------------------------------------------------

describe("dealer_closeout_email — no-address dealer skipped", () => {
  it("a bound dealer with no resolvable reply address is skipped (counted, never a card row)", async () => {
    seedProfile();
    seedBoundDealerWithThread({
      dealerId: DEALER_A,
      name: "Jim Click Hyundai",
      threadId: THREAD_A,
      contactEmail: "sales@jimclick.example.com",
    });
    // No contact_email, no contacts, no lead submissions → the ladder yields null.
    seedBoundDealerWithThread({
      dealerId: DEALER_NOADDR,
      name: "No Address Motors",
      threadId: THREAD_NOADDR,
      contactEmail: null,
    });
    // Strip the inbound sender so rung-2 cannot resolve an address for the no-addr
    // dealer (the seeded inbound carried a fallback sender by default).
    db.$client
      .prepare("UPDATE messages SET sender = NULL, gmail_message_id = NULL WHERE thread_id = ?")
      .run(THREAD_NOADDR);

    const sends = { calls: [] as CloseCall[] };
    __setDealerCloseoutEmailDepsForTests({ closeAndSuppressDealer: closeStub(sends) });

    const { run, result } = await startRun("co-noaddr-1", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("suspended");
    const payload = suspendPayloadOf(result, "batchReview");
    // Only the addressable dealer is a card row; the no-address one is skipped.
    const cardIds = (payload["targets"] as Array<{ dealer_id: string }>).map((t) => t.dealer_id);
    expect(cardIds).toEqual([DEALER_A]);

    const final = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [DEALER_A] },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    const out = final.result as { skipped_no_address: number; summary: string };
    expect(out.skipped_no_address).toBe(1);
    expect(out.summary).toContain("1 dealer(s) skipped");
    // The no-address dealer was never closed out.
    expect(threadState(THREAD_NOADDR)).toBe("replied");
  });
});

// ---------------------------------------------------------------------------
// case 6 — idempotent: a 2nd run with the dealer already suppressed → no-op
// ---------------------------------------------------------------------------

describe("dealer_closeout_email — idempotent (a 2nd run is a no-op)", () => {
  it("a dealer already closeout-suppressed is not re-assembled → zero candidates → graceful exit", async () => {
    seedProfile();
    seedBoundDealerWithThread({
      dealerId: DEALER_A,
      name: "Jim Click Hyundai",
      threadId: THREAD_A,
      contactEmail: "sales@jimclick.example.com",
    });
    // Simulate the FIRST run's durable record: the dealer is already closed out
    // (thread closed + a closeout suppression row).
    db.$client.prepare("UPDATE threads SET state = 'closed' WHERE thread_id = ?").run(THREAD_A);
    seedCloseoutSuppression({ dealerId: DEALER_A, threadId: THREAD_A });
    const before = count("thread_suppression");

    const sends = { calls: [] as CloseCall[] };
    __setDealerCloseoutEmailDepsForTests({ closeAndSuppressDealer: closeStub(sends) });

    // The 2nd run re-assembles ZERO targets → no suspend, a graceful `sent` exit.
    const { result } = await startRun("co-idem-2", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    const out = result.result as {
      outcome: string;
      closed_thread_ids: string[];
      profile_status_transition: string;
    };
    expect(out.outcome).toBe("sent");
    expect(out.closed_thread_ids).toEqual([]);
    expect(out.profile_status_transition).toBe("unchanged");

    // No-op: zero new rows, no new closes.
    expect(sends.calls.length).toBe(0);
    expect(count("thread_suppression")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// case 7 — zero candidates → a graceful exit (no suspend, no error)
// ---------------------------------------------------------------------------

describe("dealer_closeout_email — zero candidates", () => {
  it("a pinned profile with no bound dealers → graceful `sent` exit (no suspend, no error)", async () => {
    seedProfile(); // no dealers bound at all.
    const sends = { calls: [] as CloseCall[] };
    __setDealerCloseoutEmailDepsForTests({ closeAndSuppressDealer: closeStub(sends) });

    const { result } = await startRun("co-zero-1", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    const out = result.result as { outcome: string; closed_thread_ids: string[] };
    expect(out.outcome).toBe("sent");
    expect(out.closed_thread_ids).toEqual([]);
    expect(sends.calls.length).toBe(0);
    expect(count("thread_suppression")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// case 8 — the REAL atomic tool (test mode) → a promoted messages row + close+suppress
// ---------------------------------------------------------------------------

describe("dealer_closeout_email — the REAL closeAndSuppressDealer (test mode)", () => {
  it("approve → a promoted `messages` row + thread closed + suppression row + profile 'closed'", async () => {
    seedProfile();
    seedBoundDealerWithThread({
      dealerId: DEALER_A,
      name: "Jim Click Hyundai",
      threadId: THREAD_A,
      contactEmail: "sales@jimclick.example.com",
    });
    // Real tool: no injected closeAndSuppressDealer; in test mode the default
    // FakeGmailAdapter promotes a `messages` draft (the fake send), then the local
    // close+suppress commit.
    const messagesBefore = count("messages");

    const { run, result } = await startRun("co-real-disarmed", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("suspended");
    const final = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [DEALER_A] },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    const out = final.result as { emails_sent: number; closed_thread_ids: string[] };
    expect(out.emails_sent).toBe(1); // a promoted send (test-mode fake).
    expect(out.closed_thread_ids).toEqual([THREAD_A]);

    // The test-mode fake send promoted exactly one outbound `messages` row whose body is
    // the canonical closeout template (the round-trip byte-match).
    expect(count("messages")).toBe(messagesBefore + 1);
    const outbound = db.$client
      .prepare("SELECT body_text FROM messages WHERE direction = 'outbound'")
      .all() as Array<{ body_text: string }>;
    expect(outbound.length).toBe(1);
    expect(outbound[0]!.body_text).toBe(
      buildCloseoutDraft({ year: 2026, make: "Hyundai", model: "Tucson Hybrid" }, {}),
    );

    // The local close+suppress committed.
    expect(threadState(THREAD_A)).toBe("closed");
    expect(count("thread_suppression")).toBe(1);
    expect(profileStatus(PROFILE_ID)).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// case 10 — mid-batch short-circuit: a gate-declined send halts; trailing zero
// ---------------------------------------------------------------------------

describe("dealer_closeout_email — mid-batch short-circuit", () => {
  it("a short_circuit on the first dealer writes nothing for the trailing dealers", async () => {
    seedProfile();
    seedBoundDealerWithThread({
      dealerId: DEALER_A,
      name: "Jim Click Hyundai",
      threadId: THREAD_A,
      contactEmail: "sales@jimclick.example.com",
    });
    seedBoundDealerWithThread({
      dealerId: DEALER_B,
      name: "Tucson Kia",
      threadId: THREAD_B,
      contactEmail: "sales@tucsonkia.example.com",
    });
    // DEALER_A short-circuits (the gate declined its send) → DEALER_B is never
    // reached: trailing dealers write nothing.
    const sends = { calls: [] as CloseCall[], shortCircuitDealerIds: new Set([DEALER_A]) };
    __setDealerCloseoutEmailDepsForTests({ closeAndSuppressDealer: closeStub(sends) });

    const { run, result } = await startRun("co-shortcircuit", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("suspended");
    const final = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [DEALER_A, DEALER_B] },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    const out = final.result as { closed_thread_ids: string[]; profile_status_transition: string };
    expect(out.closed_thread_ids).toEqual([]); // A short-circuited; B never reached.
    expect(out.profile_status_transition).toBe("unchanged"); // zero closed → no flip.

    // The tool was called for A (which short-circuited) and NOT for B.
    expect(sends.calls.map((c) => c.dealerId)).toEqual([DEALER_A]);
    expect(count("thread_suppression")).toBe(0); // short-circuit wrote nothing.
    expect(threadState(THREAD_A)).toBe("replied");
    expect(threadState(THREAD_B)).toBe("replied");
  });
});

// ---------------------------------------------------------------------------
// case 11 — NO DELETE is ever issued (state-only) — a transaction-function guard
// ---------------------------------------------------------------------------

describe("dealer_closeout_email — state-only (never deletes)", () => {
  it("a full SEND run issues no DELETE against the product DB", async () => {
    seedProfile();
    seedBoundDealerWithThread({
      dealerId: DEALER_A,
      name: "Jim Click Hyundai",
      threadId: THREAD_A,
      contactEmail: "sales@jimclick.example.com",
    });
    // Spy the raw better-sqlite3 prepare to assert no DELETE statement is ever
    // prepared during the run (state-only invariant).
    const c = db.$client as unknown as { prepare: (sql: string) => unknown };
    const originalPrepare = c.prepare.bind(c);
    const prepared: string[] = [];
    c.prepare = (sql: string) => {
      prepared.push(sql);
      return originalPrepare(sql);
    };
    try {
      const { run, result } = await startRun("co-nodelete", { search_profile_id: PROFILE_ID });
      expect(result.status).toBe("suspended");
      const final = await run.resume({
        step: "batchReview",
        resumeData: { action: "approve", approved_dealer_ids: [DEALER_A] },
      });
      expect(final.status).toBe("success");
    } finally {
      c.prepare = originalPrepare;
    }
    // The run closed + suppressed but issued NO DELETE.
    expect(prepared.some((sql) => /\bDELETE\b/i.test(sql))).toBe(false);
    expect(threadState(THREAD_A)).toBe("closed"); // proves the run actually ran.
    expect(count("thread_suppression")).toBe(1);
  });
});
