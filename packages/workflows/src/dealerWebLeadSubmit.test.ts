/**
 * In-stack tests — the dealer_web_lead_submit flat workflow (the irreversible-send
 * KEYSTONE). These drive the REAL flat Mastra createWorkflow → REAL
 * createRun/start/resume chain (in-process against a tmp mastra.db) → REAL step
 * closures, with the browser-read scout, the gated submit, and the gmail send all
 * STUBBED through the test-only deps seam, while the profile resolver, the
 * duplicate-skip precondition, the recordSubmission XOR writer and the read-back
 * (readFirstLeadSubmitAtMs) run REAL against an ISOLATED tmp autobroker.db (the
 * committed migrations applied). NO real browser, NO real Gmail, NO LLM, no
 * network.
 *
 * THE FUSE IS DISARMED (never set AUTOBROKER_TEST_AUTO_APPROVE): the gate stays
 * live in spirit — the submit/send boundaries are injected stubs that model the
 * disarmed-fuse approve path (a real fill+click / a fake draft+promote), so the
 * row is written, the round-trip holds, and the email_fallback re-confirm proves
 * the scope switch is an INDEPENDENT second suspend.
 *
 * Acceptance:
 *   1. unpinned + no target → STOP pin_required (NOT a run), zero rows;
 *   2. decline at ① → terminal `declined`, ZERO lead_submissions + ZERO messages;
 *   3. approve a web-form dealer → one web_form lead_submissions row +
 *      readFirstLeadSubmitAtMs returns a finite ms (the round-trip);
 *   4. a no-form dealer → the SECOND independent approval suspend renders →
 *      (a) approve → sendAndRecord called + an email-shape row;
 *      (b) decline the re-confirm → that dealer's fallback skipped, NO send,
 *          run still completes;
 *   5. scoutMapCustom with a stubbed harnessGenerate returning a valid LeadFormMap;
 *   6. duplicate-skip precondition (a prior row + force_retry=false → skipped).
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/restored);
 * mastra.db + autobroker.db both live there; NEVER ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeDb,
  ExternalMutationsBlockedError,
  openDb,
  readFirstLeadSubmitAtMs,
  type Approver,
  type BrowserEmitter,
  type BrowserSession,
  type DealerLeadForm,
  type Db,
} from "@autobroker/tools";

import { createMastraInstance } from "./mastra.js";
import {
  dealerWebLeadSubmitWorkflow,
  DEALER_WEB_LEAD_SUBMIT_WORKFLOW_ID,
  submitOneWithSession,
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
].map((f) => join(here, "..", "..", "db", "drizzle", f));

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

const PROFILE_ID = "prof-leadsubmit-1";
const DEALER_FORM = "dealer-jim-click"; // a web-form dealer
const DEALER_NOFORM = "dealer-tucson-kia"; // a no-form (email-fallback) dealer
const DEALER_CAPTCHA = "dealer-captcha-1"; // a captcha-gated form (captcha email-fallback)

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-leadsubmit-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
});

afterEach(() => {
  __resetDealerWebLeadSubmitDepsForTests();
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
        "search_radius_miles, location_query, latitude, longitude, postal_code, " +
        "follow_up_email, financing_preference, status, brand, account_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
    )
    .run(
      over.id ?? PROFILE_ID,
      2026,
      over.make ?? "Hyundai",
      over.model ?? "Tucson",
      "SEL",
      50,
      "Tucson, AZ 85704",
      32.3349,
      -110.9762,
      "92614",
      "jordan.buyer@example.com",
      "finance",
      over.make ?? "Hyundai",
      "acct-test-1",
    );
}

/** Bind a US dealer with a website (and optionally a contact email) to the
 *  profile. */
function seedBoundDealer(over: {
  dealerId: string;
  name: string;
  website: string;
  contactEmail?: string | null;
  profileId?: string;
}): void {
  const c = db.$client;
  c.prepare(
    "INSERT INTO dealers (dealer_id, name, country, website, contact_email) VALUES (?, ?, 'US', ?, ?)",
  ).run(over.dealerId, over.name, over.website, over.contactEmail ?? null);
  c.prepare(
    "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
  ).run(over.profileId ?? PROFILE_ID, over.dealerId);
}

/** A prior submitted row (the duplicate-skip path). */
function seedPriorSubmission(over: { dealerId: string; profileId?: string }): void {
  db.$client
    .prepare(
      "INSERT INTO lead_submissions (submission_id, dealer_id, search_profile_id, " +
        "submitted_at, outcome, submission_channel) VALUES (?, ?, ?, ?, 'submitted', 'web_form')",
    )
    .run(
      `prior-${over.dealerId}`,
      over.dealerId,
      over.profileId ?? PROFILE_ID,
      new Date().toISOString(),
    );
}

function count(table: string): number {
  const r = db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return r.n;
}

function leadRows(): Array<Record<string, unknown>> {
  return db.$client.prepare("SELECT * FROM lead_submissions").all() as Array<
    Record<string, unknown>
  >;
}

// ---------------------------------------------------------------------------
// deps stubs — the browser-read scout, the gated submit, the gmail send
// ---------------------------------------------------------------------------

/** A scout stub: one outcome per requested dealer, shaped by a per-dealer map. */
function scoutStub(
  shapeByDealer: Record<string, Omit<ScoutOutcome, "dealerId" | "name" | "website">>,
): DealerWebLeadSubmitWorkflowDeps["scoutForms"] {
  return async (args) =>
    args.dealers.map((d) => ({
      dealerId: d.dealerId,
      name: d.name,
      website: d.website,
      ...(shapeByDealer[d.dealerId] ?? {
        form: { url: `${d.website}/contact.htm`, submitSelector: "button[type=submit]" },
        platform: "dealerfire" as const,
        fieldMap: [
          { name: "Email", role: "email" as const },
          { name: "Comments", role: "comment" as const },
        ],
        formSnapshot: null,
        contactEmail: null,
        captcha: false,
      }),
    }));
}

/** A web-form scout shape (a usable form, a known parity platform). */
const WEB_FORM_SHAPE: Omit<ScoutOutcome, "dealerId" | "name" | "website"> = {
  form: { url: "https://jimclickhyundai.com/contact.htm", submitSelector: "button[type=submit]" },
  platform: "dealerfire",
  fieldMap: [
    { name: "Email", role: "email" },
    { name: "Comments", role: "comment" },
  ],
  formSnapshot: null,
  contactEmail: null,
  captcha: false,
};

/** A no-form scout shape (no web form, but a contact email → email fallback). */
const NO_FORM_SHAPE: Omit<ScoutOutcome, "dealerId" | "name" | "website"> = {
  form: null,
  platform: "custom",
  fieldMap: null,
  formSnapshot: null,
  contactEmail: "sales@tucsonkia.example.com",
  captcha: false,
};

/** A captcha scout shape: a captcha-gated contact form → NO usable form, but a
 *  harvested contact email → email fallback with reason "captcha_fallback" (the
 *  captcha is NEVER submitted). The scout sets form:null + captcha:true. */
const CAPTCHA_SHAPE: Omit<ScoutOutcome, "dealerId" | "name" | "website"> = {
  form: null,
  captcha: true,
  platform: "custom",
  fieldMap: null,
  formSnapshot: null,
  contactEmail: "sales@captcha-dealer.example.com",
};

/** A submit stub modeling the disarmed-fuse approve path: a web-form dealer
 *  reports `submitted` (the real fill+click against the fake session). */
const submitStubSubmitted: DealerWebLeadSubmitWorkflowDeps["submitOne"] = async (
  _args: SubmitOneArgs,
): Promise<SubmitVerdict> => ({ kind: "submitted" });

const submitNeverCalled: DealerWebLeadSubmitWorkflowDeps["submitOne"] = async () => {
  throw new Error("submitOne must not be called on this path");
};

/** A sendAndRecord spy: records calls and writes a fake messages draft+promote
 *  (the disarmed-fuse `sent` outcome), so the email-shape lead row + a messages
 *  row both appear. */
function sendAndRecordSpy(record: { calls: SendRecordTargetLike[] }): DealerWebLeadSubmitWorkflowDeps["sendAndRecord"] {
  return (async (target: {
    email: { to: string; from: string; subject: string; body: string };
    searchProfileId: string | null;
  }) => {
    record.calls.push({ to: target.email.to, profileId: target.searchProfileId });
    // Mirror the disarmed-fuse `sent` path: one promoted draft row.
    db.$client
      .prepare(
        "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, sender, " +
          "recipient, subject, body_text, processed_at, search_profile_id, quote_extraction_status) " +
          "VALUES (?, NULL, ?, 'outbound', ?, ?, ?, ?, ?, ?, 'pending')",
      )
      .run(
        `msg-${record.calls.length}`,
        `fake-gmail-${record.calls.length}`,
        target.email.from,
        target.email.to,
        target.email.subject,
        target.email.body,
        new Date().toISOString(),
        target.searchProfileId,
      );
    return { kind: "sent", messageRowId: `msg-${record.calls.length}`, gmailMessageId: `fake-gmail-${record.calls.length}`, mode: "fake" };
  }) as unknown as DealerWebLeadSubmitWorkflowDeps["sendAndRecord"];
}

interface SendRecordTargetLike {
  to: string;
  profileId: string | null;
}

const sendNeverCalled = (async () => {
  throw new Error("sendAndRecord must not be called on this path");
}) as unknown as DealerWebLeadSubmitWorkflowDeps["sendAndRecord"];

/** A harness stub returning a valid LeadFormMap for every call. */
function harnessStubMap(record?: { prompts: string[] }): DealerWebLeadSubmitWorkflowDeps["harnessGenerate"] {
  return (async (input: { prompt: string }) => {
    record?.prompts.push(input.prompt);
    return {
      object: {
        fields: [
          { name: "your_email", role: "email", required: true },
          { name: "your_message", role: "comment", required: false },
        ],
        submit_selector: "#send",
      },
      usage: { pricingSource: "unavailable", promptTokens: null, completionTokens: null },
    };
  }) as unknown as DealerWebLeadSubmitWorkflowDeps["harnessGenerate"];
}

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

async function startRun(
  runId: string,
  input: { search_profile_id: string | null; target_listing_id?: string | null; force_retry?: boolean },
) {
  const wf = leadWorkflow();
  const run = await wf.createRun({ runId });
  const result = await run.start({
    inputData: {
      search_profile_id: input.search_profile_id,
      target_listing_id: input.target_listing_id ?? null,
      force_retry: input.force_retry ?? false,
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

// ---------------------------------------------------------------------------
// case 1 — explicit-pin REQUIRED (the resolve step never infers)
// ---------------------------------------------------------------------------

describe("dealer_web_lead_submit — explicit pin required", () => {
  it("STOPs with pin_required (NOT a run) on a pin-less input with 1 active profile", async () => {
    seedProfile();
    seedBoundDealer({ dealerId: DEALER_FORM, name: "Jim Click Hyundai", website: "https://jimclickhyundai.com" });
    __setDealerWebLeadSubmitDepsForTests({
      scoutForms: scoutStub({}),
      submitOne: submitNeverCalled,
      sendAndRecord: sendNeverCalled,
      harnessGenerate: harnessNeverCalled,
    });
    const { result } = await startRun("ls-pinless-1", { search_profile_id: null });
    expect(result.status).toBe("failed");
    const msg = errorMessageOf(result);
    expect(msg).toContain("Pin a search first");
    expect(msg).toContain("Tucson");
    expect(count("lead_submissions")).toBe(0);
    expect(count("messages")).toBe(0);
  });

  it("STOPs with no_active_profile on a pin-less input with 0 active profiles", async () => {
    __setDealerWebLeadSubmitDepsForTests({ scoutForms: scoutStub({}), submitOne: submitNeverCalled });
    const { result } = await startRun("ls-none-1", { search_profile_id: null });
    expect(result.status).toBe("failed");
    expect(errorMessageOf(result)).toContain("No active search profile");
  });
});

// ---------------------------------------------------------------------------
// case 2 — decline at ① → terminal declined, ZERO writes
// ---------------------------------------------------------------------------

describe("dealer_web_lead_submit — decline at the batch card", () => {
  it("decline at ① → terminal `declined`, ZERO lead_submissions + ZERO messages", async () => {
    seedProfile();
    seedBoundDealer({ dealerId: DEALER_FORM, name: "Jim Click Hyundai", website: "https://jimclickhyundai.com" });
    __setDealerWebLeadSubmitDepsForTests({
      scoutForms: scoutStub({ [DEALER_FORM]: WEB_FORM_SHAPE }),
      submitOne: submitNeverCalled,
      sendAndRecord: sendNeverCalled,
      harnessGenerate: harnessNeverCalled,
    });
    const { run, result } = await startRun("ls-decline-1", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("suspended");
    const payload = suspendPayloadOf(result, "batchReview");
    expect(payload["kind"]).toBe("batch_review");
    expect((payload["targets"] as unknown[]).length).toBe(1);

    const final = await run.resume({ step: "batchReview", resumeData: { action: "decline" } });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    expect((final.result as { outcome: string }).outcome).toBe("declined");
    expect(count("lead_submissions")).toBe(0);
    expect(count("messages")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// case 3 — approve a web-form dealer → one web_form row + finite round-trip
// ---------------------------------------------------------------------------

describe("dealer_web_lead_submit — approve a web-form dealer (the fake submit)", () => {
  it("approve ① → one web_form lead_submissions row + readFirstLeadSubmitAtMs finite", async () => {
    seedProfile();
    seedBoundDealer({ dealerId: DEALER_FORM, name: "Jim Click Hyundai", website: "https://jimclickhyundai.com" });
    __setDealerWebLeadSubmitDepsForTests({
      scoutForms: scoutStub({ [DEALER_FORM]: WEB_FORM_SHAPE }),
      submitOne: submitStubSubmitted,
      sendAndRecord: sendNeverCalled,
      harnessGenerate: harnessNeverCalled,
    });
    const { run, result } = await startRun("ls-approve-1", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("suspended");

    const final = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [DEALER_FORM] },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    const out = final.result as { outcome: string; submissions_successful: number };
    expect(out.outcome).toBe("scanned");
    expect(out.submissions_successful).toBe(1);

    // ONE web_form lead_submissions row, the XOR shape.
    const rows = leadRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!["outcome"]).toBe("submitted");
    expect(rows[0]!["submission_channel"]).toBe("web_form");
    expect(rows[0]!["email_fallback_reason"]).toBeNull();
    expect(rows[0]!["fail_reason"]).toBeNull();
    expect(count("messages")).toBe(0); // a web-form dealer never emails.

    // The round-trip: the submitted_at ISO stamp parses to a finite ms.
    const ms = readFirstLeadSubmitAtMs(db, PROFILE_ID);
    expect(ms).not.toBeNull();
    expect(Number.isFinite(ms!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// case 4 — the email_fallback path: the INDEPENDENT second suspend
// ---------------------------------------------------------------------------

describe("dealer_web_lead_submit — email_fallback re-confirm (the X1 fix point)", () => {
  it("(a) approve ① then approve the SECOND approval → sendAndRecord + an email-shape row", async () => {
    seedProfile();
    seedBoundDealer({
      dealerId: DEALER_NOFORM,
      name: "Tucson Kia",
      website: "https://tucsonkia.example.com",
      contactEmail: "sales@tucsonkia.example.com",
    });
    const sends: { calls: SendRecordTargetLike[] } = { calls: [] };
    __setDealerWebLeadSubmitDepsForTests({
      scoutForms: scoutStub({ [DEALER_NOFORM]: NO_FORM_SHAPE }),
      submitOne: submitNeverCalled, // a no-form dealer never reaches the gated submit.
      sendAndRecord: sendAndRecordSpy(sends),
      harnessGenerate: harnessNeverCalled,
    });

    // ① batch card → approve the no-form dealer.
    const { run, result } = await startRun("ls-fallback-approve", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("suspended");
    expect(suspendPayloadOf(result, "batchReview")["kind"]).toBe("batch_review");

    const afterBatch = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [DEALER_NOFORM] },
    });
    // ② the SECOND, INDEPENDENT approval suspend (the email_fallback re-confirm).
    expect(afterBatch.status).toBe("suspended");
    const second = suspendPayloadOf(afterBatch, "emailFallback");
    expect(second["kind"]).toBe("approval");
    expect(second["sensitive"]).toBe(true);
    expect(second["reason"]).toBe("email_fallback");
    expect(second["fallbackTo"]).toBe("sales@tucsonkia.example.com");
    // No send and no row fired on ①'s approval alone — the scope switch waits.
    expect(sends.calls.length).toBe(0);
    expect(count("lead_submissions")).toBe(0);

    // Re-confirm → NOW the gmail.send scope fires (fake).
    const final = await run.resume({ step: "emailFallback", resumeData: { action: "approve" } });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    const out = final.result as { outcome: string; email_fallback_count: number };
    expect(out.outcome).toBe("scanned");
    expect(out.email_fallback_count).toBe(1);

    expect(sends.calls.length).toBe(1);
    expect(sends.calls[0]!.to).toBe("sales@tucsonkia.example.com");
    expect(count("messages")).toBe(1);

    // The email-shape XOR row.
    const rows = leadRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!["outcome"]).toBe("submitted");
    expect(rows[0]!["submission_channel"]).toBe("email");
    expect(rows[0]!["email_fallback_reason"]).toBe("no_form");
  });

  it("(b) decline the re-confirm → that dealer's fallback skipped, NO send, run completes", async () => {
    seedProfile();
    seedBoundDealer({
      dealerId: DEALER_NOFORM,
      name: "Tucson Kia",
      website: "https://tucsonkia.example.com",
      contactEmail: "sales@tucsonkia.example.com",
    });
    const sends: { calls: SendRecordTargetLike[] } = { calls: [] };
    __setDealerWebLeadSubmitDepsForTests({
      scoutForms: scoutStub({ [DEALER_NOFORM]: NO_FORM_SHAPE }),
      submitOne: submitNeverCalled,
      sendAndRecord: sendAndRecordSpy(sends),
      harnessGenerate: harnessNeverCalled,
    });

    const { run, result } = await startRun("ls-fallback-decline", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("suspended");
    const afterBatch = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [DEALER_NOFORM] },
    });
    expect(afterBatch.status).toBe("suspended");
    expect(suspendPayloadOf(afterBatch, "emailFallback")["reason"]).toBe("email_fallback");

    // Decline the re-confirm → the scope switch NEVER fires; the run still completes.
    const final = await run.resume({ step: "emailFallback", resumeData: { action: "decline" } });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    const out = final.result as { outcome: string; email_fallback_count: number };
    expect(out.outcome).toBe("scanned");
    expect(out.email_fallback_count).toBe(0);

    expect(sends.calls.length).toBe(0); // the gmail.send never fired without the second approval.
    expect(count("messages")).toBe(0);
    // The declined re-confirm is recorded as a typed user_skipped failure (zero submitted).
    const rows = leadRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!["outcome"]).toBe("failed");
    expect(rows[0]!["fail_reason"]).toBe("user_skipped");
  });
});

// ---------------------------------------------------------------------------
// case 4c — captcha-gated form → captcha_fallback (the dead-branch wire-up)
// ---------------------------------------------------------------------------

describe("dealer_web_lead_submit — captcha-gated form routes to email fallback", () => {
  it("approve a captcha dealer → SECOND suspend with captcha_fallback → email row + captcha_manual_count===1", async () => {
    seedProfile();
    seedBoundDealer({
      dealerId: DEALER_CAPTCHA,
      name: "Captcha Motors",
      website: "https://captcha-dealer.example.com",
      contactEmail: "sales@captcha-dealer.example.com",
    });
    const sends: { calls: SendRecordTargetLike[] } = { calls: [] };
    __setDealerWebLeadSubmitDepsForTests({
      scoutForms: scoutStub({ [DEALER_CAPTCHA]: CAPTCHA_SHAPE }),
      submitOne: submitNeverCalled, // a captcha dealer NEVER reaches the gated submit.
      sendAndRecord: sendAndRecordSpy(sends),
      harnessGenerate: harnessNeverCalled,
    });

    // ① batch card → approve the captcha dealer.
    const { run, result } = await startRun("ls-captcha-approve", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("suspended");
    expect(suspendPayloadOf(result, "batchReview")["kind"]).toBe("batch_review");

    const afterBatch = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [DEALER_CAPTCHA] },
    });
    // ② the SECOND, INDEPENDENT approval suspend, surfacing the captcha reason.
    expect(afterBatch.status).toBe("suspended");
    const second = suspendPayloadOf(afterBatch, "emailFallback");
    expect(second["kind"]).toBe("approval");
    expect(second["sensitive"]).toBe(true);
    expect(second["fallbackReason"]).toBe("captcha_fallback");
    // No send / no row on ①'s approval alone — the captcha was never submitted.
    expect(sends.calls.length).toBe(0);
    expect(count("lead_submissions")).toBe(0);

    // Re-confirm → the email scope fires (fake); the captcha is NEVER submitted.
    const final = await run.resume({ step: "emailFallback", resumeData: { action: "approve" } });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    const out = final.result as {
      outcome: string;
      email_fallback_count: number;
      captcha_manual_count: number;
    };
    expect(out.outcome).toBe("scanned");
    expect(out.email_fallback_count).toBe(1);
    expect(out.captcha_manual_count).toBe(1);

    expect(sends.calls.length).toBe(1);
    expect(sends.calls[0]!.to).toBe("sales@captcha-dealer.example.com");
    expect(count("messages")).toBe(1);

    // The email-shape XOR row carries the captcha_fallback reason.
    const rows = leadRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!["outcome"]).toBe("submitted");
    expect(rows[0]!["submission_channel"]).toBe("email");
    expect(rows[0]!["email_fallback_reason"]).toBe("captcha_fallback");
  });
});

// ---------------------------------------------------------------------------
// case 5 — scoutMapCustom with a stubbed harnessGenerate (the only LLM step)
// ---------------------------------------------------------------------------

describe("dealer_web_lead_submit — scoutMapCustom (the Custom field-map LLM step)", () => {
  it("maps a Custom-platform form via the stubbed LeadFormMap, then submits web_form", async () => {
    seedProfile();
    seedBoundDealer({ dealerId: DEALER_FORM, name: "Boutique Motors", website: "https://boutique.example.com" });
    const prompts: { prompts: string[] } = { prompts: [] };
    __setDealerWebLeadSubmitDepsForTests({
      scoutForms: scoutStub({
        [DEALER_FORM]: {
          form: { url: "https://boutique.example.com/get-in-touch", submitSelector: "" },
          platform: "custom",
          fieldMap: null,
          formSnapshot: "<form><input name=your_email><textarea name=your_message></form>",
          contactEmail: null,
          captcha: false,
        },
      }),
      submitOne: submitStubSubmitted,
      sendAndRecord: sendNeverCalled,
      harnessGenerate: harnessStubMap(prompts),
    });

    const { run, result } = await startRun("ls-custom-1", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("suspended");
    const final = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [DEALER_FORM] },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    expect((final.result as { submissions_successful: number }).submissions_successful).toBe(1);

    // The LLM field-map ran exactly once (the one Custom dealer); the prompt
    // fenced the UNTRUSTED form DOM.
    expect(prompts.prompts.length).toBe(1);
    expect(prompts.prompts[0]).toContain("UNTRUSTED");

    const rows = leadRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!["submission_channel"]).toBe("web_form");
  });
});

// ---------------------------------------------------------------------------
// case 6 — duplicate-skip precondition
// ---------------------------------------------------------------------------

describe("dealer_web_lead_submit — duplicate-skip precondition", () => {
  it("a prior submitted row + force_retry=false → the dealer is skipped (no new row)", async () => {
    seedProfile();
    seedBoundDealer({ dealerId: DEALER_FORM, name: "Jim Click Hyundai", website: "https://jimclickhyundai.com" });
    seedPriorSubmission({ dealerId: DEALER_FORM });
    __setDealerWebLeadSubmitDepsForTests({
      scoutForms: scoutStub({ [DEALER_FORM]: WEB_FORM_SHAPE }),
      submitOne: submitNeverCalled, // skipped before the card → never submitted.
      sendAndRecord: sendNeverCalled,
      harnessGenerate: harnessNeverCalled,
    });

    // The only eligible dealer is a duplicate → it is filtered out in buildPayloads,
    // so the batch card has zero targets and the approve resolves to zero submits.
    const { run, result } = await startRun("ls-dup-1", { search_profile_id: PROFILE_ID });
    expect(result.status).toBe("suspended");
    const payload = suspendPayloadOf(result, "batchReview");
    expect((payload["targets"] as unknown[]).length).toBe(0);

    // Approving an empty card declines is impossible (min 1 id), so decline to
    // finish — the duplicate stays the only row, the skipped count is surfaced.
    const final = await run.resume({ step: "batchReview", resumeData: { action: "decline" } });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    expect((final.result as { outcome: string }).outcome).toBe("declined");

    // Still exactly the ONE prior row — the duplicate was skipped, not re-fired.
    expect(count("lead_submissions")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// case 7 — submitOneWithSession: the GATED WIRING (a FAKE BrowserSession)
//
// These prove the production per-dealer LOGIC actually drives session.submitForm
// with the APPROVED approver (so the L2 gate genuinely fires), WITHOUT a real
// chromium. The fake session implements the BrowserSession interface inline (only
// the verbs the logic touches are real; the read faces are no-op stubs), and its
// submitForm records the approver it was handed.
// ---------------------------------------------------------------------------

/** The approver the submit step passes (mirrors the workflow's internal APPROVED:
 *  the human already approved at the suspend → decide() returns true). */
const APPROVED_TEST: Approver = { async decide() { return true; } };

/** A silent emitter for the per-dealer logic (no UI in these unit tests). */
const NOOP_EMITTER: BrowserEmitter = {
  opened() {},
  closed() {},
  error() {},
  action() {},
};

type SessionPage = Awaited<ReturnType<BrowserSession["newPage"]>>;

/** A fake page: only close() is exercised by the logic; the rest are unused. */
const FAKE_PAGE = { close: async () => undefined } as unknown as SessionPage;

/** Build a fake BrowserSession whose navigate/submitForm behavior is scripted.
 *  Records the approver submitForm was handed + which verbs were called. */
function fakeSubmitSession(script: {
  navBlocked?: string | null;
  submit: () => Promise<{ submitted: true } | { declined: true }>;
}): {
  session: BrowserSession;
  navCalls: string[];
  submitCalls: Array<{ form: DealerLeadForm; approver: Approver }>;
} {
  const navCalls: string[] = [];
  const submitCalls: Array<{ form: DealerLeadForm; approver: Approver }> = [];
  const session = {
    newPage: async () => FAKE_PAGE,
    navigate: async (_page: SessionPage, url: string) => {
      navCalls.push(url);
      return { robotsDisallowed: false, blocked: script.navBlocked ?? null };
    },
    submitForm: async (_page: SessionPage, form: DealerLeadForm, approver: Approver) => {
      submitCalls.push({ form, approver });
      return script.submit();
    },
  } as unknown as BrowserSession;
  return { session, navCalls, submitCalls };
}

const SUBMIT_FORM: DealerLeadForm = {
  url: "https://jimclickhyundai.com/contact.htm",
  fields: { Email: "jordan.buyer@example.com", Comments: "Interested in a 2026 Tucson SEL." },
  submitSelector: "button[type=submit]",
};

function submitArgs(session: BrowserSession): Parameters<typeof submitOneWithSession>[0] {
  return {
    session,
    runId: "ls-wiring-1",
    emitter: NOOP_EMITTER,
    dealerId: DEALER_FORM,
    form: SUBMIT_FORM,
    approver: APPROVED_TEST,
  };
}

describe("submitOneWithSession — the gated wiring (fake BrowserSession)", () => {
  it("calls session.submitForm with the APPROVED approver and returns submitted (disarmed fuse)", async () => {
    const fx = fakeSubmitSession({ submit: async () => ({ submitted: true }) });
    const verdict = await submitOneWithSession(submitArgs(fx.session));

    expect(verdict).toEqual({ kind: "submitted" });
    // The ONE Approver-holding call fired against the navigated form page.
    expect(fx.navCalls).toEqual([SUBMIT_FORM.url]);
    expect(fx.submitCalls.length).toBe(1);
    expect(fx.submitCalls[0]!.form).toBe(SUBMIT_FORM);
    // The APPROVED approver (the human's prior approval) reached the gate, and
    // it decides true (the gate would proceed past the L2 approval check).
    expect(fx.submitCalls[0]!.approver).toBe(APPROVED_TEST);
    expect(
      await fx.submitCalls[0]!.approver.decide({
        kind: "dealer_form_submit",
        runId: "ls-wiring-1",
        summary: "test",
        payload: {},
      }),
    ).toBe(true);
  });

  it("submitForm throwing ExternalMutationsBlockedError → fuse_blocked (the BLOCK=1 fake-send)", async () => {
    const fx = fakeSubmitSession({
      submit: async () => {
        // The L1 fuse fired inside the gate BEFORE the click — fail CLOSED.
        throw new ExternalMutationsBlockedError("dealer_form_submit");
      },
    });
    const verdict = await submitOneWithSession(submitArgs(fx.session));

    expect(verdict).toEqual({ kind: "fuse_blocked" });
    // The gate WAS reached (the fuse is what stopped it), holding the approver.
    expect(fx.submitCalls.length).toBe(1);
    expect(fx.submitCalls[0]!.approver).toBe(APPROVED_TEST);
  });

  it("navigate blocked → needs_fallback, and session.submitForm is NEVER called", async () => {
    const fx = fakeSubmitSession({
      navBlocked: "captcha",
      submit: async () => {
        throw new Error("submitForm must not be reached on a blocked navigation");
      },
    });
    const verdict = await submitOneWithSession(submitArgs(fx.session));

    expect(verdict.kind).toBe("needs_fallback");
    // The form page never loaded → the gated submit was NOT attempted.
    expect(fx.navCalls).toEqual([SUBMIT_FORM.url]);
    expect(fx.submitCalls.length).toBe(0);
  });

  it("a non-ExternalMutationsBlockedError submit failure rethrows (never swallowed)", async () => {
    const fx = fakeSubmitSession({
      submit: async () => {
        throw new Error("playwright timeout");
      },
    });
    await expect(submitOneWithSession(submitArgs(fx.session))).rejects.toThrow("playwright timeout");
    // The gate was reached (the approver was handed in) before the real failure.
    expect(fx.submitCalls.length).toBe(1);
  });
});
