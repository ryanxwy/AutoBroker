/**
 * In-stack tests — the negotiation_followup flat workflow (the irreversible-send
 * follow-up skill). These drive the REAL flat Mastra createWorkflow → REAL
 * createRun/start/resume chain (in-process against a tmp mastra.db) → REAL step
 * closures, with the PROSE draft (harness.draftProse) and the send path
 * (sendAndRecord) STUBBED through the test-only deps seam, while the profile
 * resolver, the follow-up reads, the pure deciders (selectNextReplyTargets /
 * classifyQuoteSituation / resolveReplyTarget / buildDraftContext) and the
 * contact-flip write run REAL against an ISOLATED tmp autobroker.db (the committed
 * migrations applied). NO real LLM, NO real Gmail, no network.
 *
 * THE FUSE IS DISARMED (never set AUTOBROKER_TEST_AUTO_APPROVE): the gate stays
 * live in spirit — the send boundary is an injected stub that models the
 * disarmed-fuse approve path (a fake draft+promote), so the row is written, the
 * thread state moves to 'negotiating', and the contact-flip re-confirm proves the
 * flip is an INDEPENDENT second suspend.
 *
 * Acceptance:
 *   1. unpinned (1 active) → STOP pin_required (NOT a run), zero rows;
 *   2. decline at ① → terminal `declined`, ZERO messages + ZERO threads-state changes;
 *   3. SEND n (approve) → per draft sendAndRecord called + threads.state→negotiating,
 *      the body has NO budget and NO competing-dealer name (numbers only);
 *   4. the tone is the classifyQuoteSituation tone (assertive here), picked in code;
 *   5. the responsive cap: too many UNANSWERED follow-ups → typed error / silent
 *      drop, but a deep thread the dealer keeps answering is NOT capped;
 *   6. a contact-flip override → ② re-confirm → setPrimaryReplyTarget called once
 *      (decline → not called);
 *   7. no candidates → a graceful no_candidates summary (not an error);
 *   8. a per-thread draft failure degrades (thread skipped + voiced, run
 *      continues on the surviving drafts); ALL failing → the run errors.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/restored);
 * mastra.db + autobroker.db both live there; NEVER ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/tools";

import { createMastraInstance } from "./mastra.js";
import {
  negotiationFollowupWorkflow,
  NEGOTIATION_FOLLOWUP_WORKFLOW_ID,
  requestContactFlipForRun,
  __resetNegotiationFollowupDepsForTests,
  __setNegotiationFollowupDepsForTests,
  type NegotiationFollowupWorkflowDeps,
} from "./negotiationFollowup.js";

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

const PROFILE_ID = "prof-followup-1";
const DEALER_TARGET = "dealer-jim-click"; // the thread we follow up
const DEALER_COMPETE = "dealer-tucson-kia"; // the competing dealer (cheaper quote)
const THREAD_TARGET = "thread-jim-click";
const COMPETING_NAME = "Tucson Kia";

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-followup-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
});

afterEach(() => {
  __resetNegotiationFollowupDepsForTests();
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

function seedProfile(over: { id?: string } = {}): void {
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
      "Hyundai",
      "Tucson",
      "Limited",
      50,
      "Tucson, AZ 85704",
      "92614",
      "jordan.buyer@example.com",
      "finance",
      "Hyundai",
      "acct-test-1",
    );
}

function seedDealer(over: {
  dealerId: string;
  name: string;
  website?: string;
  contactEmail?: string | null;
  profileId?: string;
}): void {
  const c = db.$client;
  c.prepare(
    "INSERT INTO dealers (dealer_id, name, country, website, contact_email) VALUES (?, ?, 'US', ?, ?)",
  ).run(over.dealerId, over.name, over.website ?? null, over.contactEmail ?? null);
  c.prepare(
    "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
  ).run(over.profileId ?? PROFILE_ID, over.dealerId);
}

/** A thread + its messages. `inboundAtMs` is the latest inbound recency; we seed
 *  NO outbound so the timing gate returns `ready` (no `wait`). */
function seedThread(over: {
  threadId: string;
  dealerId: string;
  subject?: string;
  state?: string;
  inboundAtMs: number;
  inboundGmailId?: string;
  inboundBody?: string;
  contactId?: string | null;
  senderEmail?: string;
  outboundRounds?: number;
  /** When true, seed one final INBOUND reply AFTER the outbound rounds — the
   *  dealer countered last, so the responsive cap sees 0 unanswered follow-ups
   *  no matter how many rounds were sent. */
  trailingInbound?: boolean;
}): void {
  const c = db.$client;
  c.prepare(
    "INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id) VALUES (?, ?, ?, ?, ?)",
  ).run(over.threadId, over.dealerId, over.subject ?? "Quote request", over.state ?? "replied", PROFILE_ID);
  // The inbound dealer reply (carries the gmail id the reply double-flag needs).
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, sender, recipient, " +
      "subject, body_text, received_at, processed_at, contact_id, sender_email, sender_name, " +
      "search_profile_id, quote_extraction_status) " +
      "VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
  ).run(
    `msg-in-${over.threadId}`,
    over.threadId,
    over.inboundGmailId ?? `gmail-${over.threadId}`,
    over.senderEmail ?? "sales@jimclick.example.com",
    "jordan.buyer@example.com",
    over.subject ?? "Quote request",
    over.inboundBody ?? "Here is our quote on the Tucson Limited. Let me know.",
    over.inboundAtMs,
    over.inboundAtMs,
    over.contactId ?? null,
    over.senderEmail ?? "sales@jimclick.example.com",
    "Sales Team",
    PROFILE_ID,
  );
  // Optional prior outbound follow-up rounds (drive the responsive cap's
  // unanswered count when no trailing inbound follows). Each is set well in the
  // past so they never become the latest-outbound that triggers `wait`.
  const rounds = over.outboundRounds ?? 0;
  for (let i = 0; i < rounds; i++) {
    c.prepare(
      "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, sender, recipient, " +
        "subject, body_text, received_at, processed_at, search_profile_id, quote_extraction_status) " +
        "VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, 'pending')",
    ).run(
      `msg-out-${over.threadId}-${i}`,
      over.threadId,
      `gmail-out-${over.threadId}-${i}`,
      "jordan.buyer@example.com",
      over.senderEmail ?? "sales@jimclick.example.com",
      `Re: ${over.subject ?? "Quote request"}`,
      "Following up.",
      over.inboundAtMs - (rounds - i + 30) * 24 * 60 * 60 * 1000, // far in the past.
      over.inboundAtMs - (rounds - i + 30) * 24 * 60 * 60 * 1000,
      PROFILE_ID,
    );
  }
  // A trailing dealer reply (inserted LAST → highest rowid) so the responsive cap
  // counts 0 unanswered follow-ups: the dealer answered our latest round.
  if (over.trailingInbound) {
    c.prepare(
      "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, sender, recipient, " +
        "subject, body_text, received_at, processed_at, contact_id, sender_email, sender_name, " +
        "search_profile_id, quote_extraction_status) " +
        "VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
    ).run(
      `msg-in2-${over.threadId}`,
      over.threadId,
      `gmail2-${over.threadId}`,
      over.senderEmail ?? "sales@jimclick.example.com",
      "jordan.buyer@example.com",
      over.subject ?? "Quote request",
      "Thanks for following up — here is a sharper number.",
      over.inboundAtMs,
      over.inboundAtMs,
      over.contactId ?? null,
      over.senderEmail ?? "sales@jimclick.example.com",
      "Sales Team",
      PROFILE_ID,
    );
  }
}

/** An open itemized dealer quote (the `assertive` tone needs the current OTD to
 *  be >$500 above the best competing AND itemized). */
function seedQuote(over: {
  dealerId: string;
  otdTotal: number;
  itemized?: boolean;
  receivedAtMs?: number;
}): void {
  db.$client
    .prepare(
      "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, " +
        "search_profile_id, financing_mode, selling_price, doc_fee, dealer_fee, sales_tax, " +
        "otd_total, quote_received_at, quote_expires_at) " +
        "VALUES (?, ?, ?, ?, ?, 'cash', ?, ?, ?, ?, ?, ?, NULL)",
    )
    .run(
      `quote-${over.dealerId}`,
      over.dealerId,
      `qmsg-${over.dealerId}`,
      `qgmail-${over.dealerId}`,
      PROFILE_ID,
      over.itemized === false ? null : over.otdTotal - 2500,
      over.itemized === false ? null : 85,
      over.itemized === false ? null : 499,
      over.itemized === false ? null : 1900,
      over.otdTotal,
      over.receivedAtMs ?? Date.now(),
    );
}

function seedContact(over: {
  contactId: string;
  dealerId: string;
  email: string;
  primary?: boolean;
}): void {
  db.$client
    .prepare(
      "INSERT INTO dealer_contacts (contact_id, dealer_id, email, normalized_email, " +
        "display_name, role, is_primary_reply_target) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      over.contactId,
      over.dealerId,
      over.email,
      over.email.toLowerCase(),
      "Sales Rep",
      "sales",
      over.primary ? 1 : 0,
    );
}

function count(table: string): number {
  const r = db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return r.n;
}

function threadState(threadId: string): string {
  const r = db.$client.prepare("SELECT state FROM threads WHERE thread_id = ?").get(threadId) as {
    state: string;
  };
  return r.state;
}

function isPrimary(contactId: string): number {
  const r = db.$client
    .prepare("SELECT is_primary_reply_target AS p FROM dealer_contacts WHERE contact_id = ?")
    .get(contactId) as { p: number };
  return r.p;
}

// ---------------------------------------------------------------------------
// deps stubs
// ---------------------------------------------------------------------------

/** A prose stub: records the prompts + tone-revealing args, returns a fixed,
 *  budget-free, no-competing-name body (numbers only). */
function draftProseStub(record: { prompts: string[]; bodies: string[] }): NegotiationFollowupWorkflowDeps["draftProse"] {
  return (async (input: { prompt: string }) => {
    record.prompts.push(input.prompt);
    const body =
      "Thanks for the quote on the Tucson Limited. I'm comparing a few out-the-door " +
      "numbers and another dealer is currently at 31,200 out-the-door. Can you match or " +
      "beat that on the same trim? Happy to move quickly if the numbers work.";
    record.bodies.push(body);
    return {
      text: body,
      usage: {
        costUsd: null,
        durationMs: 1,
        pricingSource: "unavailable" as const,
        promptTokens: null,
        completionTokens: null,
      },
    };
  }) as unknown as NegotiationFollowupWorkflowDeps["draftProse"];
}

const draftProseNeverCalled = (async () => {
  throw new Error("draftProse must not be called on this path");
}) as unknown as NegotiationFollowupWorkflowDeps["draftProse"];

interface SendCallLike {
  to: string;
  /** The send `from` — must be the BUYER's follow_up_email, NOT the dealer. */
  from: string;
  threadId: string | null;
  inReplyToGmailId: string | null | undefined;
  subject: string;
  body: string;
  profileId: string | null;
}

/** A sendAndRecord spy: records the call + writes a fake promoted messages row
 *  (the disarmed-fuse `sent` outcome). */
function sendAndRecordSpy(record: { calls: SendCallLike[] }): NegotiationFollowupWorkflowDeps["sendAndRecord"] {
  return (async (target: {
    email: { to: string; from: string; subject: string; body: string };
    threadId: string | null;
    searchProfileId: string | null;
    inReplyToGmailId?: string | null;
  }) => {
    record.calls.push({
      to: target.email.to,
      from: target.email.from,
      threadId: target.threadId,
      inReplyToGmailId: target.inReplyToGmailId,
      subject: target.email.subject,
      body: target.email.body,
      profileId: target.searchProfileId,
    });
    db.$client
      .prepare(
        "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, sender, " +
          "recipient, subject, body_text, processed_at, search_profile_id, quote_extraction_status) " +
          "VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, 'pending')",
      )
      .run(
        `msg-sent-${record.calls.length}`,
        target.threadId,
        `fake-gmail-${record.calls.length}`,
        target.email.from,
        target.email.to,
        target.email.subject,
        target.email.body,
        new Date().toISOString(),
        target.searchProfileId,
      );
    return {
      kind: "sent" as const,
      messageRowId: `msg-sent-${record.calls.length}`,
      gmailMessageId: `fake-gmail-${record.calls.length}`,
      mode: "fake" as const,
    };
  }) as unknown as NegotiationFollowupWorkflowDeps["sendAndRecord"];
}

const sendNeverCalled = (async () => {
  throw new Error("sendAndRecord must not be called on this path");
}) as unknown as NegotiationFollowupWorkflowDeps["sendAndRecord"];

/** A sendAndRecord spy whose send threw AFTER the draft was inserted (a `partial`
 *  outcome — the ask did NOT reach the dealer). It records the call but reports
 *  no landed send, so the caller must never count it or advance thread state. */
function sendAndRecordPartial(record: { calls: SendCallLike[] }): NegotiationFollowupWorkflowDeps["sendAndRecord"] {
  return (async (target: {
    email: { to: string; from: string; subject: string; body: string };
    threadId: string | null;
    searchProfileId: string | null;
    inReplyToGmailId?: string | null;
  }) => {
    record.calls.push({
      to: target.email.to,
      from: target.email.from,
      threadId: target.threadId,
      inReplyToGmailId: target.inReplyToGmailId,
      subject: target.email.subject,
      body: target.email.body,
      profileId: target.searchProfileId,
    });
    return {
      kind: "partial" as const,
      messageRowId: "msg-partial-1",
      partial: {
        message_recorded: true,
        state_updated: false,
        reconcile_hint: "send_failed_draft_retained",
        external_id: null,
      },
    };
  }) as unknown as NegotiationFollowupWorkflowDeps["sendAndRecord"];
}

// ---------------------------------------------------------------------------
// run/resume drivers
// ---------------------------------------------------------------------------

function followupWorkflow() {
  const mastra = createMastraInstance({
    workflows: { [NEGOTIATION_FOLLOWUP_WORKFLOW_ID]: negotiationFollowupWorkflow as never },
  });
  return mastra.getWorkflow(NEGOTIATION_FOLLOWUP_WORKFLOW_ID);
}

async function startRun(
  runId: string,
  input: { search_profile_id: string | null; thread_id?: string | null },
) {
  const wf = followupWorkflow();
  const run = await wf.createRun({ runId });
  const result = await run.start({
    inputData: {
      search_profile_id: input.search_profile_id,
      thread_id: input.thread_id ?? null,
    },
  });
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

/** Seed the standard two-dealer scenario: a target thread (Jim Click, higher
 *  itemized OTD) + a cheaper competing quote (Tucson Kia) → the `assertive` tone. */
function seedAssertiveScenario(): void {
  seedProfile();
  seedDealer({ dealerId: DEALER_TARGET, name: "Jim Click Hyundai", website: "https://jimclick.example.com" });
  seedDealer({ dealerId: DEALER_COMPETE, name: COMPETING_NAME, website: "https://tucsonkia.example.com" });
  const recent = Date.now() - 3 * 24 * 60 * 60 * 1000; // 3 days ago → `ready`.
  seedThread({ threadId: THREAD_TARGET, dealerId: DEALER_TARGET, inboundAtMs: recent });
  seedQuote({ dealerId: DEALER_TARGET, otdTotal: 33_900, itemized: true });
  seedQuote({ dealerId: DEALER_COMPETE, otdTotal: 31_200, itemized: true });
  seedContact({ contactId: "ct-jim-1", dealerId: DEALER_TARGET, email: "rep@jimclick.example.com", primary: true });
}

// ---------------------------------------------------------------------------
// case 1 — explicit-pin REQUIRED (the resolve step never infers)
// ---------------------------------------------------------------------------

describe("negotiation_followup — explicit pin required", () => {
  it("STOPs with pin_required (NOT a run) on a pin-less input with 1 active profile", async () => {
    seedProfile();
    __setNegotiationFollowupDepsForTests({
      draftProse: draftProseNeverCalled,
      sendAndRecord: sendNeverCalled,
    });
    const { result } = await startRun("nf-pinless-1", { search_profile_id: null });
    expect(result.status).toBe("failed");
    const msg = errorMessageOf(result);
    expect(msg).toContain("Pin a search first");
    expect(msg).toContain("Tucson");
    expect(count("messages")).toBe(0);
  });

  it("STOPs with no_active_profile on a pin-less input with 0 active profiles", async () => {
    __setNegotiationFollowupDepsForTests({ draftProse: draftProseNeverCalled, sendAndRecord: sendNeverCalled });
    const { result } = await startRun("nf-none-1", { search_profile_id: null });
    expect(result.status).toBe("failed");
    expect(errorMessageOf(result)).toContain("No active search profile");
  });
});

// ---------------------------------------------------------------------------
// case 2 — decline at ① → terminal declined, ZERO writes / ZERO state changes
// ---------------------------------------------------------------------------

describe("negotiation_followup — decline at the batch card", () => {
  it("decline at ① → terminal `declined`, ZERO messages + ZERO threads-state changes", async () => {
    seedAssertiveScenario();
    const prose = { prompts: [] as string[], bodies: [] as string[] };
    __setNegotiationFollowupDepsForTests({
      draftProse: draftProseStub(prose),
      sendAndRecord: sendNeverCalled,
    });

    const { run, result } = await startRun("nf-decline-1", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("suspended");
    const payload = suspendPayloadOf(result, "batchReview");
    expect(payload["kind"]).toBe("batch_review");
    expect((payload["targets"] as unknown[]).length).toBe(1);

    const final = await run.resume({ step: "batchReview", resumeData: { action: "decline" } });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    expect((final.result as { outcome: string }).outcome).toBe("declined");

    expect(count("messages")).toBe(1); // only the seeded inbound — no outbound written.
    expect(threadState(THREAD_TARGET)).toBe("replied"); // state UNCHANGED by a decline.
  });
});

// ---------------------------------------------------------------------------
// case 3 + 4 — SEND n → per-draft send + state→negotiating; tone in code; red lines
// ---------------------------------------------------------------------------

describe("negotiation_followup — SEND n (the fake send happy path)", () => {
  it("approve ① → sendAndRecord called, threads.state→negotiating, body has NO budget / NO competing name", async () => {
    seedAssertiveScenario();
    const prose = { prompts: [] as string[], bodies: [] as string[] };
    const sends: { calls: SendCallLike[] } = { calls: [] };
    __setNegotiationFollowupDepsForTests({
      draftProse: draftProseStub(prose),
      sendAndRecord: sendAndRecordSpy(sends),
    });

    const { run, result } = await startRun("nf-send-1", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("suspended");

    // case 4 — the tone is the CODE-chosen classifyQuoteSituation tone: the target
    // OTD (33,900) is > the competing (31,200) by >$500 AND itemized → `assertive`.
    // The prompt embeds the assertive guidance line; the model never chose it.
    expect(prose.prompts.length).toBe(1);
    expect(prose.prompts[0]).toContain("firm, confident register");
    // The financing preference (profile seeded "finance") reaches the draft prompt
    // end-to-end, so the draft is grounded and never fabricates a payment method
    // the buyer did not choose (PIC-20260629r2-3).
    expect(prose.prompts[0]).toContain("plan to finance");
    expect(prose.prompts[0]).toMatch(/NEVER state or imply a payment method/i);

    const final = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [THREAD_TARGET] },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    const out = final.result as {
      outcome: string;
      drafts_created: number;
      emails_sent: number;
      contact_flips: number;
    };
    expect(out.outcome).toBe("sent");
    expect(out.drafts_created).toBe(1);
    expect(out.emails_sent).toBe(1);
    expect(out.contact_flips).toBe(0);

    // The send fired once, replying on the EXISTING thread with the double-flag set.
    expect(sends.calls.length).toBe(1);
    expect(sends.calls[0]!.threadId).toBe(THREAD_TARGET);
    expect(sends.calls[0]!.inReplyToGmailId).toBe(`gmail-${THREAD_TARGET}`);
    expect(sends.calls[0]!.to).toBe("rep@jimclick.example.com"); // the primary-reply-target rung.
    // The reply is FROM the BUYER (the profile's follow_up_email), NOT the dealer.
    expect(sends.calls[0]!.from).toBe("jordan.buyer@example.com");
    expect(sends.calls[0]!.from).not.toBe(sends.calls[0]!.to); // never FROM the dealer.
    expect(sends.calls[0]!.subject.toLowerCase().startsWith("re:")).toBe(true);

    // RED LINES (asserted OFFLINE — the func lane has no sent body under BLOCK=1):
    // the sent body carries NO `$`-budget run and NO competing-dealer name.
    const body = sends.calls[0]!.body;
    expect(body).not.toContain("$");
    expect(body).not.toContain(COMPETING_NAME);
    expect(body).toContain("31,200"); // the leverage is the NUMBER only.

    // The sent thread moved to 'negotiating' — NEVER 'agreed'.
    expect(threadState(THREAD_TARGET)).toBe("negotiating");
  });

  it("approve ① but the send returns {partial} → emails_sent 0, thread NOT 'negotiating', summary truthful", async () => {
    seedAssertiveScenario();
    const prose = { prompts: [] as string[], bodies: [] as string[] };
    const sends: { calls: SendCallLike[] } = { calls: [] };
    __setNegotiationFollowupDepsForTests({
      draftProse: draftProseStub(prose),
      sendAndRecord: sendAndRecordPartial(sends),
    });

    const { run, result } = await startRun("nf-partial-1", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("suspended");

    const final = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [THREAD_TARGET] },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    const out = final.result as {
      outcome: string;
      drafts_created: number;
      emails_sent: number;
      summary: string;
    };

    // The send WAS attempted (the gate approved + sendAndRecord ran once)...
    expect(sends.calls.length).toBe(1);
    // ...but it did NOT land, so nothing is counted as a send.
    expect(out.emails_sent).toBe(0);
    expect(out.drafts_created).toBe(1); // the draft was composed; only the send failed.
    expect(out.summary).toContain("sent 0"); // the summary reports the truth.
    // A partial NEVER advances thread state — it stays 'replied', not 'negotiating'.
    expect(threadState(THREAD_TARGET)).toBe("replied");
  });
});

// ---------------------------------------------------------------------------
// case 5 — the responsive-aware follow-up cap (unanswered nudges vs deep mutual
// negotiation) — single-thread typed error, batch silent drop, and the
// dealer-answered thread that runs DEEP without being capped
// ---------------------------------------------------------------------------

describe("negotiation_followup — the responsive follow-up cap precondition", () => {
  it("a named thread with too many UNANSWERED follow-ups → typed error, never drafted/gated", async () => {
    seedProfile();
    seedDealer({ dealerId: DEALER_TARGET, name: "Jim Click Hyundai", website: "https://jimclick.example.com" });
    const recent = Date.now() - 3 * 24 * 60 * 60 * 1000;
    // 3 prior outbound rounds, dealer never replied → 3 unanswered (over the cap).
    seedThread({ threadId: THREAD_TARGET, dealerId: DEALER_TARGET, inboundAtMs: recent, outboundRounds: 3 });
    seedQuote({ dealerId: DEALER_TARGET, otdTotal: 33_900, itemized: true });

    const prose = { prompts: [] as string[], bodies: [] as string[] };
    __setNegotiationFollowupDepsForTests({
      draftProse: draftProseStub(prose),
      sendAndRecord: sendNeverCalled,
    });

    const { result } = await startRun("nf-cap-1", {
      search_profile_id: PROFILE_ID,
      thread_id: THREAD_TARGET,
    });
    expect(result.status).toBe("failed");
    expect(errorMessageOf(result)).toContain("unanswered follow-ups");
    // The gate was never reached for the capped thread → the prose stub never ran.
    expect(prose.prompts.length).toBe(0);
  });

  it("(batch mode) an over-nudged silent thread is SILENTLY filtered → no_candidates, never an error", async () => {
    seedProfile();
    seedDealer({ dealerId: DEALER_TARGET, name: "Jim Click Hyundai", website: "https://jimclick.example.com" });
    const recent = Date.now() - 3 * 24 * 60 * 60 * 1000;
    seedThread({ threadId: THREAD_TARGET, dealerId: DEALER_TARGET, inboundAtMs: recent, outboundRounds: 3 });
    seedQuote({ dealerId: DEALER_TARGET, otdTotal: 33_900, itemized: true });

    const prose = { prompts: [] as string[], bodies: [] as string[] };
    __setNegotiationFollowupDepsForTests({
      draftProse: draftProseStub(prose),
      sendAndRecord: sendNeverCalled,
    });

    const { result } = await startRun("nf-cap-batch-1", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect((result.result as { outcome: string }).outcome).toBe("no_candidates");
    expect(prose.prompts.length).toBe(0);
  });

  it("a deep thread the dealer KEEPS answering is NOT capped — mutual negotiation runs on", async () => {
    // The proven assertive drafting scenario, but with a DEEP thread: 3 prior
    // outbound rounds AND a trailing dealer counter → 0 unanswered → eligible even
    // though roundsSent (3) would have tripped the old flat 3-round cap.
    seedProfile();
    seedDealer({ dealerId: DEALER_TARGET, name: "Jim Click Hyundai", website: "https://jimclick.example.com" });
    seedDealer({ dealerId: DEALER_COMPETE, name: COMPETING_NAME, website: "https://tucsonkia.example.com" });
    const recent = Date.now() - 3 * 24 * 60 * 60 * 1000;
    seedThread({
      threadId: THREAD_TARGET,
      dealerId: DEALER_TARGET,
      inboundAtMs: recent,
      outboundRounds: 3,
      trailingInbound: true,
    });
    seedQuote({ dealerId: DEALER_TARGET, otdTotal: 33_900, itemized: true });
    seedQuote({ dealerId: DEALER_COMPETE, otdTotal: 31_200, itemized: true });
    seedContact({ contactId: "ct-jim-1", dealerId: DEALER_TARGET, email: "rep@jimclick.example.com", primary: true });

    const prose = { prompts: [] as string[], bodies: [] as string[] };
    __setNegotiationFollowupDepsForTests({
      draftProse: draftProseStub(prose),
      sendAndRecord: sendNeverCalled,
    });

    const { result } = await startRun("nf-cap-deep-1", { search_profile_id: PROFILE_ID });
    // Drafted + suspended at the batch gate (NOT filtered as no_candidates).
    expect(result.status).toBe("suspended");
    expect(prose.prompts.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// case 6 — contact-flip override → ② re-confirm → setPrimaryReplyTarget once
// ---------------------------------------------------------------------------

describe("negotiation_followup — contact-flip re-confirm (the independent ②)", () => {
  it("approve ① with a registered flip → ② sensitive re-confirm → approve flips one contact", async () => {
    seedAssertiveScenario();
    // A second, NON-primary contact the user wants to promote.
    seedContact({ contactId: "ct-jim-2", dealerId: DEALER_TARGET, email: "manager@jimclick.example.com", primary: false });

    const prose = { prompts: [] as string[], bodies: [] as string[] };
    const sends: { calls: SendCallLike[] } = { calls: [] };
    __setNegotiationFollowupDepsForTests({
      draftProse: draftProseStub(prose),
      sendAndRecord: sendAndRecordSpy(sends),
    });

    // Register the explicit override BEFORE the run (the user changed the address).
    requestContactFlipForRun("nf-flip-approve", {
      threadId: THREAD_TARGET,
      dealerId: DEALER_TARGET,
      contactId: "ct-jim-2",
    });

    const { run, result } = await startRun("nf-flip-approve", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("suspended");
    expect(suspendPayloadOf(result, "batchReview")["kind"]).toBe("batch_review");

    // ① approve → the SECOND, INDEPENDENT sensitive approval suspend renders.
    const afterBatch = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [THREAD_TARGET] },
    });
    expect(afterBatch.status).toBe("suspended");
    const second = suspendPayloadOf(afterBatch, "batchReview");
    expect(second["kind"]).toBe("approval");
    expect(second["sensitive"]).toBe(true);
    expect(second["reason"]).toBe("contact_flip");
    expect(second["contactId"]).toBe("ct-jim-2");
    // No flip happened on ①'s approval alone — the flip waits on the re-confirm.
    expect(isPrimary("ct-jim-2")).toBe(0);
    expect(isPrimary("ct-jim-1")).toBe(1);

    // ② approve → NOW the flip commits (clear-all-then-set-one, one txn).
    const final = await run.resume({ step: "batchReview", resumeData: { action: "approve" } });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    const out = final.result as { outcome: string; contact_flips: number; emails_sent: number };
    expect(out.outcome).toBe("sent");
    expect(out.contact_flips).toBe(1);
    expect(out.emails_sent).toBe(1); // the send is independent of the flip.

    // The flip promoted ct-jim-2 and demoted ct-jim-1 (the single-txn clear-all).
    expect(isPrimary("ct-jim-2")).toBe(1);
    expect(isPrimary("ct-jim-1")).toBe(0);
  });

  it("decline the ② re-confirm → no flip (setPrimaryReplyTarget NOT called), run completes", async () => {
    seedAssertiveScenario();
    seedContact({ contactId: "ct-jim-2", dealerId: DEALER_TARGET, email: "manager@jimclick.example.com", primary: false });

    const prose = { prompts: [] as string[], bodies: [] as string[] };
    const sends: { calls: SendCallLike[] } = { calls: [] };
    __setNegotiationFollowupDepsForTests({
      draftProse: draftProseStub(prose),
      sendAndRecord: sendAndRecordSpy(sends),
    });
    requestContactFlipForRun("nf-flip-decline", {
      threadId: THREAD_TARGET,
      dealerId: DEALER_TARGET,
      contactId: "ct-jim-2",
    });

    const { run, result } = await startRun("nf-flip-decline", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("suspended");
    const afterBatch = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [THREAD_TARGET] },
    });
    expect(afterBatch.status).toBe("suspended");
    expect(suspendPayloadOf(afterBatch, "batchReview")["reason"]).toBe("contact_flip");

    // Decline ② → the flip NEVER commits; the send still happens.
    const final = await run.resume({ step: "batchReview", resumeData: { action: "decline" } });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    const out = final.result as { outcome: string; contact_flips: number; emails_sent: number };
    expect(out.outcome).toBe("sent");
    expect(out.contact_flips).toBe(0);
    expect(out.emails_sent).toBe(1);

    // The primary flag is untouched — the flip write never ran.
    expect(isPrimary("ct-jim-2")).toBe(0);
    expect(isPrimary("ct-jim-1")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// case 8 — a per-thread draft failure degrades (thread skipped, run continues);
// ALL drafts failing stays fail-closed (run errors, zero sends)
// ---------------------------------------------------------------------------

/** A prose stub that throws on ONE invocation (1-based) and otherwise returns
 *  the fixed budget-free body — the per-thread provider-failure scenario. */
function draftProseFailingOn(
  failOnCall: number,
  record: { prompts: string[] },
): NegotiationFollowupWorkflowDeps["draftProse"] {
  let calls = 0;
  return (async (input: { prompt: string }) => {
    calls += 1;
    record.prompts.push(input.prompt);
    if (calls === failOnCall) {
      const err = new Error("lane B returned error_max_turns — fails closed");
      err.name = "ClaudeOAuthError";
      throw err;
    }
    return {
      text:
        "Thanks for the quote on the Tucson Limited. I'm comparing a few out-the-door " +
        "numbers and another dealer is currently at 31,200 out-the-door. Can you match or " +
        "beat that on the same trim? Happy to move quickly if the numbers work.",
      usage: {
        costUsd: null,
        durationMs: 1,
        pricingSource: "unavailable" as const,
        promptTokens: null,
        completionTokens: null,
      },
    };
  }) as unknown as NegotiationFollowupWorkflowDeps["draftProse"];
}

/** Seed THREE eligible threads (distinct dealers/recencies) + a cheaper
 *  competing quote, each with a primary reply contact. */
function seedTriThreadScenario(): string[] {
  seedProfile();
  seedDealer({ dealerId: DEALER_COMPETE, name: COMPETING_NAME, website: "https://tucsonkia.example.com" });
  seedQuote({ dealerId: DEALER_COMPETE, otdTotal: 31_200, itemized: true });
  const day = 24 * 60 * 60 * 1000;
  const threadIds: string[] = [];
  for (const [i, letter] of (["a", "b", "c"] as const).entries()) {
    const dealerId = `dealer-${letter}`;
    const threadId = `thread-${letter}`;
    seedDealer({ dealerId, name: `Dealer ${letter.toUpperCase()}`, website: `https://${dealerId}.example.com` });
    seedThread({ threadId, dealerId, inboundAtMs: Date.now() - (2 + i) * day });
    seedQuote({ dealerId, otdTotal: 33_900, itemized: true });
    seedContact({ contactId: `ct-${dealerId}`, dealerId, email: `rep@${dealerId}.example.com`, primary: true });
    threadIds.push(threadId);
  }
  return threadIds;
}

describe("negotiation_followup — per-thread draft failure degradation", () => {
  it("one failing draft of 3 → gate shows 2, approve sends 2, the failed thread stays a candidate", async () => {
    const threadIds = seedTriThreadScenario();
    const prose = { prompts: [] as string[] };
    const sends: { calls: SendCallLike[] } = { calls: [] };
    __setNegotiationFollowupDepsForTests({
      draftProse: draftProseFailingOn(2, prose),
      sendAndRecord: sendAndRecordSpy(sends),
    });

    const { run, result } = await startRun("nf-draftfail-1", { search_profile_id: PROFILE_ID });
    // (a) the gate suspends over EXACTLY the 2 successful drafts — the failed
    // thread never reaches the card (draft_body stayed null).
    expect(result.status).toBe("suspended");
    const payload = suspendPayloadOf(result, "batchReview");
    expect(payload["kind"]).toBe("batch_review");
    const shown = (payload["targets"] as Array<{ dealer_id: string }>).map((t) => t.dealer_id);
    expect(shown.length).toBe(2);
    expect(prose.prompts.length).toBe(3); // all 3 were ATTEMPTED.
    const failed = threadIds.filter((id) => !shown.includes(id));
    expect(failed.length).toBe(1);

    // (b) approve → exactly the 2 reviewed drafts send.
    const final = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: shown },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    const out = final.result as {
      outcome: string;
      drafts_created: number;
      emails_sent: number;
      summary: string;
    };
    expect(out.outcome).toBe("sent");
    expect(sends.calls.length).toBe(2);

    // (c) the summary voices the counts AND the failure.
    expect(out.drafts_created).toBe(2);
    expect(out.emails_sent).toBe(2);
    expect(out.summary).toMatch(/1 thread\(s\) failed to draft/);

    // (d) the failed thread's state is UNCHANGED — still a candidate next round.
    expect(threadState(failed[0]!)).toBe("replied");
    for (const id of shown) expect(threadState(id)).toBe("negotiating");
  });

  it("ALL drafts failing → the run errors (fail-closed), zero sends, zero state changes", async () => {
    seedAssertiveScenario();
    const prose = { prompts: [] as string[] };
    __setNegotiationFollowupDepsForTests({
      draftProse: draftProseFailingOn(1, prose),
      sendAndRecord: sendNeverCalled,
    });

    const { result } = await startRun("nf-draftfail-all", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("failed");
    expect(errorMessageOf(result)).toContain("error_max_turns");
    expect(count("messages")).toBe(1); // only the seeded inbound — no outbound written.
    expect(threadState(THREAD_TARGET)).toBe("replied");
  });
});

// ---------------------------------------------------------------------------
// case 7 — no candidates → a graceful no_candidates summary (not an error)
// ---------------------------------------------------------------------------

describe("negotiation_followup — no candidates", () => {
  it("no eligible threads → a graceful no_candidates summary (success, not an error)", async () => {
    seedProfile();
    seedDealer({ dealerId: DEALER_TARGET, name: "Jim Click Hyundai", website: "https://jimclick.example.com" });
    // An AGREED thread is never re-contacted → the ranker excludes it → no candidates.
    const recent = Date.now() - 3 * 24 * 60 * 60 * 1000;
    seedThread({ threadId: THREAD_TARGET, dealerId: DEALER_TARGET, inboundAtMs: recent, state: "agreed" });

    const prose = { prompts: [] as string[], bodies: [] as string[] };
    __setNegotiationFollowupDepsForTests({
      draftProse: draftProseStub(prose),
      sendAndRecord: sendNeverCalled,
    });

    const { result } = await startRun("nf-nocand-1", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    const out = result.result as { outcome: string; summary: string };
    expect(out.outcome).toBe("no_candidates");
    expect(out.summary.length).toBeGreaterThan(0);
    expect(prose.prompts.length).toBe(0); // nothing drafted.
    expect(count("messages")).toBe(1); // only the seeded inbound.
  });
});
