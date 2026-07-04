/**
 * In-stack tests — the dealer_inbox_check flat workflow.
 *
 * These drive the REAL flat Mastra createWorkflow → REAL createRun/start/resume
 * chain (in-process against a tmp mastra.db) → REAL step closures, with a
 * deterministic in-memory GmailAdapter stub injected through the test-only deps
 * seam, while the profile resolver, the routing ladder, the inbox reads, the
 * atomic write and the per-profile watermark run REAL against an ISOLATED tmp
 * autobroker.db (the committed migrations applied). NO real Gmail, NO LLM, no
 * network.
 *
 * Acceptance under the EXPLICIT-PIN + LEAD-ANCHOR contract:
 *   - pin-less + 1 active → pin_required STOP (NOT a run);
 *   - pin-less + 0 active → no_active_profile STOP;
 *   - pin-less + 2+ active → pin_required STOP (candidate vehicles listed);
 *   - valid pin → runs, resolution "pinned";
 *   - stale/closed pin → pin_required STOP;
 *   - first run + lead submitted N days ago → window anchored to the submit
 *     (≈ (N+1)d), NOT a blind "2d";
 *   - first run + NO lead submitted → no_lead_submitted STOP, zero writes;
 *   - subsequent run with a watermark → window from the watermark (lead floor
 *     ignored);
 *   - dealer-domain routing: a new sender at a known dealer's host → routed;
 *     a sender at no bound dealer's host → unrouted with sender_email;
 *   - approve → inbound messages written `pending`, watermark advanced;
 *   - decline → ZERO writes, watermark NOT advanced;
 *   - re-run dedup no-op.
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
  openDb,
  RealGmailAdapter,
  type Db,
  type GmailAdapter,
  type GmailApiClient,
  type Thread,
  type ThreadRef,
} from "@autobroker/tools";

import { createMastraInstance } from "./mastra.js";
import {
  dealerInboxCheckWorkflow,
  DEALER_INBOX_CHECK_WORKFLOW_ID,
  __resetDealerInboxCheckDepsForTests,
  __setDealerInboxCheckDepsForTests,
} from "./dealerInboxCheck.js";

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

const PROFILE_ID = "prof-inbox-1";
const DEALER_A = "dealer-a";
const DEALER_B = "dealer-b";
const DAY_MS = 86_400_000;

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-inboxchk-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
});

afterEach(() => {
  __resetDealerInboxCheckDepsForTests();
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

function seedProfile(over: { id?: string; make?: string; model?: string; brand?: string } = {}): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, trim, " +
        "search_radius_miles, location_query, latitude, longitude, follow_up_email, " +
        "financing_preference, status, brand, account_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
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
      "buyer@example.com",
      "finance",
      over.brand ?? over.make ?? "Hyundai",
      "acct-test-1",
    );
}

/** Soft-delete a profile (the stale-pin path: a pinned id that is no longer
 *  active resolves to non-pinned). */
function closeProfile(id: string): void {
  db.$client.prepare("UPDATE search_profiles SET status = 'closed' WHERE search_profile_id = ?").run(id);
}

function seedDealerWithContact(over: {
  dealerId: string;
  name: string;
  email: string;
  website?: string;
  profileId?: string;
}): void {
  const c = db.$client;
  c.prepare("INSERT INTO dealers (dealer_id, name, country, website) VALUES (?, ?, 'US', ?)").run(
    over.dealerId,
    over.name,
    over.website ?? null,
  );
  c.prepare("INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'candidate')").run(
    over.profileId ?? PROFILE_ID,
    over.dealerId,
  );
  c.prepare(
    "INSERT INTO dealer_contacts (contact_id, dealer_id, normalized_email, display_name) VALUES (?, ?, ?, ?)",
  ).run(`seed-${over.dealerId}`, over.dealerId, over.email.toLowerCase(), over.name);
}

/** A dealer bound to the profile with a WEBSITE but NO contact row — the
 *  dealer-domain (rung 2.5) routing case (no exact contact to match on). */
function seedDealerWithWebsiteOnly(over: {
  dealerId: string;
  name: string;
  website: string;
  profileId?: string;
}): void {
  const c = db.$client;
  c.prepare("INSERT INTO dealers (dealer_id, name, country, website) VALUES (?, ?, 'US', ?)").run(
    over.dealerId,
    over.name,
    over.website,
  );
  c.prepare("INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'candidate')").run(
    over.profileId ?? PROFILE_ID,
    over.dealerId,
  );
}

/** A successful lead-submission row (the inbox anchor floor). `submitted_at` is
 *  an ISO string (the codebase convention; the reader Date.parse-es it). The XOR
 *  check requires submission_channel='web_form' for a 'submitted' outcome. */
function seedLeadSubmission(over: {
  dealerId: string;
  submittedAtMs: number;
  profileId?: string;
  submissionId?: string;
}): void {
  db.$client
    .prepare(
      "INSERT INTO lead_submissions (submission_id, dealer_id, search_profile_id, " +
        "submitted_at, outcome, submission_channel) " +
        "VALUES (?, ?, ?, ?, 'submitted', 'web_form')",
    )
    .run(
      over.submissionId ?? `lead-${over.dealerId}`,
      over.dealerId,
      over.profileId ?? PROFILE_ID,
      new Date(over.submittedAtMs).toISOString(),
    );
}

function count(table: string): number {
  const r = db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return r.n;
}

function watermark(profileId: string): string | null {
  const row = db.$client
    .prepare("SELECT value FROM pipeline_state WHERE key = ?")
    .get(`inbox.last_check_at.${profileId}`) as { value: string | null } | undefined;
  return row?.value ?? null;
}

/** Write the per-profile inbox watermark directly (the "subsequent run" setup). */
function setWatermark(profileId: string, iso: string): void {
  db.$client
    .prepare(
      "INSERT INTO pipeline_state (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(`inbox.last_check_at.${profileId}`, iso);
}

// ---------------------------------------------------------------------------
// the deterministic GmailAdapter stub — an in-memory thread corpus
// ---------------------------------------------------------------------------

interface StubMessage {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  internalDateMs: number;
}
interface StubThread {
  threadId: string;
  messages: StubMessage[];
}

/** A spy adapter that records the query strings each search ran (the window
 *  assertions inspect `searchQueries`). */
function makeAdapter(threads: StubThread[]): GmailAdapter & { searchQueries: string[] } {
  const searchQueries: string[] = [];
  const hydrate = (t: StubThread): Thread => ({
    threadId: t.threadId,
    messages: t.messages.map((m) => ({
      messageId: m.messageId,
      threadId: t.threadId,
      direction: "inbound" as const,
      from: m.from,
      to: m.to,
      subject: m.subject,
      rfcMessageId: `<${m.messageId}@dealer.test>`,
      bodyText: m.bodyText,
      bodyHtml: "",
      internalDateMs: m.internalDateMs,
      attachments: [],
    })),
  });
  return {
    kind: "fake",
    searchQueries,
    // Every search returns every thread (the workflow dedupes first-pass-wins).
    search: (query: string, _max?: number): Promise<ThreadRef[]> => {
      searchQueries.push(query);
      return Promise.resolve(
        threads.map((t) => ({ threadId: t.threadId, messageIds: t.messages.map((m) => m.messageId) })),
      );
    },
    getThread: (threadId: string): Promise<Thread> => {
      const t = threads.find((x) => x.threadId === threadId);
      return Promise.resolve(t === undefined ? { threadId, messages: [] } : hydrate(t));
    },
    getMessage: () => Promise.reject(new Error("not used")),
    downloadAttachment: () => Promise.reject(new Error("not used")),
    historyList: (_start: string) => Promise.resolve({ expired: false, records: [], newHistoryId: "1" }),
    getCurrentHistoryId: () => Promise.resolve("1"),
    send: () => Promise.reject(new Error("send must never be called in inbox_check")),
    health: () => Promise.resolve({ ok: true, detail: "stub" }),
  };
}

/** Two dealer-reply threads from the two seeded dealers. */
function twoReplyThreads(): StubThread[] {
  return [
    {
      threadId: "g-thread-1",
      messages: [
        {
          messageId: "g-msg-1",
          from: "Sam <sam@dealer-a.com>",
          to: "buyer@example.com",
          subject: "Re: 2026 Tucson availability",
          bodyText: "We have one in stock. Sale price 33,995 before tax.",
          internalDateMs: 1_711_900_000_000,
        },
      ],
    },
    {
      threadId: "g-thread-2",
      messages: [
        {
          messageId: "g-msg-2",
          from: "Pat <pat@dealer-b.com>",
          to: "buyer@example.com",
          subject: "Re: Tucson quote",
          bodyText: "Thanks for reaching out — happy to help!",
          internalDateMs: 1_711_900_060_000,
        },
      ],
    },
  ];
}

/** The latest day-fraction of the relative window any search ran, parsed back to
 *  a number of days (e.g. "31d" → 31, "5h" → 5/24). Asserts the anchor floor. */
function windowDaysOf(queries: string[]): number {
  let maxDays = 0;
  for (const q of queries) {
    const m = /newer_than:(\d+)([hd])/.exec(q);
    if (m === null) continue;
    const n = Number(m[1]);
    const days = m[2] === "d" ? n : n / 24;
    if (days > maxDays) maxDays = days;
  }
  return maxDays;
}

// ---------------------------------------------------------------------------
// run/resume drivers
// ---------------------------------------------------------------------------

function inboxWorkflow() {
  const mastra = createMastraInstance({
    workflows: { [DEALER_INBOX_CHECK_WORKFLOW_ID]: dealerInboxCheckWorkflow as never },
  });
  return mastra.getWorkflow(DEALER_INBOX_CHECK_WORKFLOW_ID);
}

async function startRun(runId: string, searchProfileId: string | null = null) {
  const wf = inboxWorkflow();
  const run = await wf.createRun({ runId });
  const result = await run.start({ inputData: { search_profile_id: searchProfileId } });
  return { run, result };
}

function suspendPayloadOf(result: unknown): Record<string, unknown> {
  const steps = (result as { steps?: Record<string, { suspendPayload?: Record<string, unknown> }> }).steps;
  const payload = steps?.["batchReview"]?.suspendPayload;
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
// case — explicit-pin REQUIRED (the resolve step never infers)
// ---------------------------------------------------------------------------

describe("dealer_inbox_check — explicit pin required", () => {
  it("STOPs with pin_required (NOT a run) on a pin-less input with exactly 1 active profile", async () => {
    seedProfile(); // single active
    __setDealerInboxCheckDepsForTests({ createAdapter: () => makeAdapter(twoReplyThreads()) });
    const { result } = await startRun("inbox-pinless-1", null);
    expect(result.status).toBe("failed");
    const msg = errorMessageOf(result);
    expect(msg).toContain("Pin a search first");
    expect(msg).toContain("Tucson"); // the candidate vehicle label
    expect(count("messages")).toBe(0);
  });

  it("STOPs with no_active_profile on a pin-less input with 0 active profiles", async () => {
    __setDealerInboxCheckDepsForTests({ createAdapter: () => makeAdapter([]) });
    const { result } = await startRun("inbox-none-1", null);
    expect(result.status).toBe("failed");
    expect(errorMessageOf(result)).toContain("No active search profile");
  });

  it("STOPs with pin_required on a pin-less input with 2+ active profiles (candidates listed)", async () => {
    seedProfile({ id: "prof-x", make: "Hyundai", model: "Tucson", brand: "Hyundai" });
    seedProfile({ id: "prof-y", make: "Toyota", model: "RAV4", brand: "Toyota" });
    __setDealerInboxCheckDepsForTests({ createAdapter: () => makeAdapter([]) });
    const { result } = await startRun("inbox-ambig-1", null);
    expect(result.status).toBe("failed");
    const msg = errorMessageOf(result);
    expect(msg).toContain("Pin a search first");
    expect(msg).toContain("Tucson");
    expect(msg).toContain("RAV4");
  });

  it("STOPs with pin_required when the supplied pin is no longer active (stale/closed)", async () => {
    seedProfile(); // active, then closed below
    closeProfile(PROFILE_ID);
    __setDealerInboxCheckDepsForTests({ createAdapter: () => makeAdapter([]) });
    const { result } = await startRun("inbox-stale-1", PROFILE_ID);
    expect(result.status).toBe("failed");
    expect(errorMessageOf(result)).toContain("no longer active");
    expect(count("messages")).toBe(0);
  });

  it("runs with resolution 'pinned' when a valid pin is supplied", async () => {
    seedProfile();
    seedDealerWithContact({ dealerId: DEALER_A, name: "Dealer A", email: "sam@dealer-a.com" });
    seedLeadSubmission({ dealerId: DEALER_A, submittedAtMs: Date.now() - 3 * DAY_MS });
    __setDealerInboxCheckDepsForTests({
      createAdapter: () => makeAdapter([twoReplyThreads()[0]!]),
    });

    const { run, result } = await startRun("inbox-pinned-1", PROFILE_ID);
    expect(result.status).toBe("suspended");
    const final = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [DEALER_A] },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    const out = final.result as Record<string, unknown>;
    expect(out["outcome"]).toBe("checked");
    expect(out["resolution"]).toBe("pinned");
  });
});

// ---------------------------------------------------------------------------
// case — lead-submit anchoring + no-lead STOP
// ---------------------------------------------------------------------------

describe("dealer_inbox_check — window anchoring", () => {
  it("anchors the first-run window to the earliest lead-submit (≈ (N+1)d), not a blind 2d", async () => {
    seedProfile();
    seedDealerWithContact({ dealerId: DEALER_A, name: "Dealer A", email: "sam@dealer-a.com" });
    // Lead submitted 30 days ago → window ≈ 31d (30d delta + 1h buffer, ceil-to-days).
    seedLeadSubmission({ dealerId: DEALER_A, submittedAtMs: Date.now() - 30 * DAY_MS });
    const adapter = makeAdapter([twoReplyThreads()[0]!]);
    __setDealerInboxCheckDepsForTests({ createAdapter: () => adapter });

    const { run, result } = await startRun("inbox-anchor-1", PROFILE_ID);
    expect(result.status).toBe("suspended");
    // The window is anchored to the submit floor, NOT the blind 2d default.
    const days = windowDaysOf(adapter.searchQueries);
    expect(days).toBeGreaterThanOrEqual(30);
    expect(days).toBeLessThanOrEqual(32);
    // Drain the suspend so the run finishes cleanly.
    await run.resume({ step: "batchReview", resumeData: { action: "decline" } });
  });

  it("STOPs with no_lead_submitted (zero writes) on the first run when no lead was submitted", async () => {
    seedProfile();
    seedDealerWithContact({ dealerId: DEALER_A, name: "Dealer A", email: "sam@dealer-a.com" });
    // No lead_submissions row at all.
    __setDealerInboxCheckDepsForTests({ createAdapter: () => makeAdapter(twoReplyThreads()) });

    const { result } = await startRun("inbox-nolead-1", PROFILE_ID);
    expect(result.status).toBe("failed");
    expect(errorMessageOf(result)).toContain("Submit a lead");
    expect(count("messages")).toBe(0);
    expect(count("threads")).toBe(0);
    expect(watermark(PROFILE_ID)).toBeNull();
  });

  it("uses the watermark (ignoring the lead floor) on a subsequent run", async () => {
    seedProfile();
    seedDealerWithContact({ dealerId: DEALER_A, name: "Dealer A", email: "sam@dealer-a.com" });
    // A far-back lead floor that would force a ~100d window if it were used...
    seedLeadSubmission({ dealerId: DEALER_A, submittedAtMs: Date.now() - 100 * DAY_MS });
    // ...but a recent watermark (2 days ago) must win → a small window (~3d).
    setWatermark(PROFILE_ID, new Date(Date.now() - 2 * DAY_MS).toISOString());
    const adapter = makeAdapter([twoReplyThreads()[0]!]);
    __setDealerInboxCheckDepsForTests({ createAdapter: () => adapter });

    const { run, result } = await startRun("inbox-watermark-1", PROFILE_ID);
    expect(result.status).toBe("suspended");
    const days = windowDaysOf(adapter.searchQueries);
    expect(days).toBeLessThanOrEqual(4); // ~3d from the watermark, NOT ~100d
    await run.resume({ step: "batchReview", resumeData: { action: "decline" } });
  });
});

// ---------------------------------------------------------------------------
// case — dealer-domain routing (rung 2.5) end to end
// ---------------------------------------------------------------------------

describe("dealer_inbox_check — dealer-domain routing", () => {
  it("routes a reply from a NEW sender whose host matches a bound dealer's website", async () => {
    seedProfile();
    // Dealer bound with a WEBSITE but NO contact row → only the host rung can fire.
    seedDealerWithWebsiteOnly({
      dealerId: DEALER_A,
      name: "Tucson Hyundai",
      website: "https://www.tucson-hyundai.com",
    });
    seedLeadSubmission({ dealerId: DEALER_A, submittedAtMs: Date.now() - 3 * DAY_MS });
    const newRepThread: StubThread = {
      threadId: "g-thread-newrep",
      messages: [
        {
          messageId: "g-msg-newrep",
          from: "New Rep <newrep@tucson-hyundai.com>", // unknown mailbox, known host
          to: "buyer@example.com",
          subject: "Re: 2026 Tucson",
          bodyText: "Hi, following up on your Tucson inquiry.",
          internalDateMs: 1_711_900_000_000,
        },
      ],
    };
    __setDealerInboxCheckDepsForTests({ createAdapter: () => makeAdapter([newRepThread]) });

    const { result } = await startRun("inbox-domain-routed-1", PROFILE_ID);
    expect(result.status).toBe("suspended");
    const payload = suspendPayloadOf(result);
    // Routed → it is a target, not unrouted.
    expect((payload["targets"] as unknown[]).length).toBe(1);
    expect((payload["unrouted"] as unknown[]).length).toBe(0);
    expect((payload["targets"] as Array<{ dealer_id: string }>)[0]?.dealer_id).toBe(DEALER_A);
  });

  it("leaves a reply unrouted (with sender_email) when no bound dealer's host matches", async () => {
    seedProfile();
    seedDealerWithWebsiteOnly({
      dealerId: DEALER_A,
      name: "Tucson Hyundai",
      website: "https://www.tucson-hyundai.com",
    });
    seedLeadSubmission({ dealerId: DEALER_A, submittedAtMs: Date.now() - 3 * DAY_MS });
    const strangerThread: StubThread = {
      threadId: "g-thread-stranger",
      messages: [
        {
          messageId: "g-msg-stranger",
          from: "Someone <someone@unrelated-host.com>", // no bound dealer's host
          to: "buyer@example.com",
          subject: "Re: 2026 Tucson",
          bodyText: "Are you still looking for a Tucson?",
          internalDateMs: 1_711_900_000_000,
        },
      ],
    };
    __setDealerInboxCheckDepsForTests({ createAdapter: () => makeAdapter([strangerThread]) });

    const { result } = await startRun("inbox-domain-unrouted-1", PROFILE_ID);
    expect(result.status).toBe("suspended");
    const payload = suspendPayloadOf(result);
    expect((payload["targets"] as unknown[]).length).toBe(0);
    const unrouted = payload["unrouted"] as Array<{ thread_id: string; sender_email: string }>;
    expect(unrouted.length).toBe(1);
    expect(unrouted[0]?.sender_email).toBe("someone@unrelated-host.com");
  });
});

// ---------------------------------------------------------------------------
// case — approve writes pending messages + advances the watermark
// ---------------------------------------------------------------------------

describe("dealer_inbox_check — approve", () => {
  it("ingests the approved dealers' replies (pending, profile-scoped) and advances the watermark", async () => {
    seedProfile();
    seedDealerWithContact({ dealerId: DEALER_A, name: "Dealer A", email: "sam@dealer-a.com" });
    seedDealerWithContact({ dealerId: DEALER_B, name: "Dealer B", email: "pat@dealer-b.com" });
    seedLeadSubmission({ dealerId: DEALER_A, submittedAtMs: Date.now() - 3 * DAY_MS });
    __setDealerInboxCheckDepsForTests({ createAdapter: () => makeAdapter(twoReplyThreads()) });

    const { run, result } = await startRun("inbox-approve-1", PROFILE_ID);
    expect(result.status).toBe("suspended");
    const payload = suspendPayloadOf(result);
    expect(payload["kind"]).toBe("batch_review");
    expect((payload["targets"] as unknown[]).length).toBe(2);

    const final = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [DEALER_A, DEALER_B] },
    });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;

    const out = final.result as Record<string, unknown>;
    expect(out["outcome"]).toBe("checked");
    expect(out["new_messages_count"]).toBe(2);
    expect(out["unique_dealers_replied"]).toBe(2);

    // Two inbound, pending, profile-scoped messages.
    expect(count("messages")).toBe(2);
    const pending = db.$client
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE direction='inbound' AND quote_extraction_status='pending' AND search_profile_id = ?")
      .get(PROFILE_ID) as { n: number };
    expect(pending.n).toBe(2);

    // The per-profile watermark advanced.
    expect(watermark(PROFILE_ID)).not.toBeNull();
  });

  it("approves a SUBSET — only the approved dealer's reply is written", async () => {
    seedProfile();
    seedDealerWithContact({ dealerId: DEALER_A, name: "Dealer A", email: "sam@dealer-a.com" });
    seedDealerWithContact({ dealerId: DEALER_B, name: "Dealer B", email: "pat@dealer-b.com" });
    seedLeadSubmission({ dealerId: DEALER_A, submittedAtMs: Date.now() - 3 * DAY_MS });
    __setDealerInboxCheckDepsForTests({ createAdapter: () => makeAdapter(twoReplyThreads()) });

    const { run, result } = await startRun("inbox-subset-1", PROFILE_ID);
    expect(result.status).toBe("suspended");
    const final = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [DEALER_A] },
    });
    expect(final.status).toBe("success");
    expect(count("messages")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// case — decline → ZERO writes, watermark NOT advanced, outcome "declined"
// ---------------------------------------------------------------------------

describe("dealer_inbox_check — decline", () => {
  it("writes NOTHING and leaves the watermark untouched", async () => {
    seedProfile();
    seedDealerWithContact({ dealerId: DEALER_A, name: "Dealer A", email: "sam@dealer-a.com" });
    seedDealerWithContact({ dealerId: DEALER_B, name: "Dealer B", email: "pat@dealer-b.com" });
    seedLeadSubmission({ dealerId: DEALER_A, submittedAtMs: Date.now() - 3 * DAY_MS });
    __setDealerInboxCheckDepsForTests({ createAdapter: () => makeAdapter(twoReplyThreads()) });

    const { run, result } = await startRun("inbox-decline-1", PROFILE_ID);
    expect(result.status).toBe("suspended");
    const final = await run.resume({ step: "batchReview", resumeData: { action: "decline" } });
    expect(final.status).toBe("success");
    if (final.status !== "success") return;
    expect((final.result as { outcome: string }).outcome).toBe("declined");

    expect(count("messages")).toBe(0);
    expect(count("threads")).toBe(0);
    expect(count("thread_suppression")).toBe(0);
    expect(count("thread_routing")).toBe(0);
    expect(watermark(PROFILE_ID)).toBeNull(); // NOT advanced
  });
});

// ---------------------------------------------------------------------------
// case — zero discovered threads → no_replies success
// ---------------------------------------------------------------------------

describe("dealer_inbox_check — no replies", () => {
  it("returns no_replies (a valid success) when the sweep finds nothing", async () => {
    seedProfile();
    seedDealerWithContact({ dealerId: DEALER_A, name: "Dealer A", email: "sam@dealer-a.com" });
    seedLeadSubmission({ dealerId: DEALER_A, submittedAtMs: Date.now() - 3 * DAY_MS });
    __setDealerInboxCheckDepsForTests({ createAdapter: () => makeAdapter([]) });

    const { result } = await startRun("inbox-empty-1", PROFILE_ID);
    // Empty corpus → batchReview passes through (no suspend) → confirm.
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect((result.result as { outcome: string }).outcome).toBe("no_replies");
    expect(count("messages")).toBe(0);
    expect(watermark(PROFILE_ID)).not.toBeNull(); // a clean sweep still advances
  });
});

// ---------------------------------------------------------------------------
// case — re-run dedup no-op
// ---------------------------------------------------------------------------

describe("dealer_inbox_check — re-run dedup", () => {
  it("a second approve over the same corpus writes nothing new", async () => {
    seedProfile();
    seedDealerWithContact({ dealerId: DEALER_A, name: "Dealer A", email: "sam@dealer-a.com" });
    seedDealerWithContact({ dealerId: DEALER_B, name: "Dealer B", email: "pat@dealer-b.com" });
    seedLeadSubmission({ dealerId: DEALER_A, submittedAtMs: Date.now() - 3 * DAY_MS });
    __setDealerInboxCheckDepsForTests({ createAdapter: () => makeAdapter(twoReplyThreads()) });

    const first = await startRun("inbox-rerun-1", PROFILE_ID);
    await first.run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [DEALER_A, DEALER_B] },
    });
    expect(count("messages")).toBe(2);

    // Second sweep: the same backend messages are now already ingested → the
    // discovery dedup-vs-ingested filters every thread → no_replies, zero new.
    const second = await startRun("inbox-rerun-2", PROFILE_ID);
    expect(second.result.status).toBe("success");
    if (second.result.status !== "success") return;
    expect((second.result.result as { outcome: string }).outcome).toBe("no_replies");
    expect(count("messages")).toBe(2); // unchanged
  });
});

// ---------------------------------------------------------------------------
// case — HTML-only dealer reply recovers its body through to the product DB
// ---------------------------------------------------------------------------

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** A GmailApiClient stub whose single dealer reply is an HTML-ONLY message (a
 *  text/html part with NO text/plain part). Driving it through the REAL
 *  RealGmailAdapter exercises mapMessage's html→text recovery end to end — the
 *  fix that stops an HTML-only quote being silently persisted as a NULL body. */
function htmlOnlyGmailClient(): GmailApiClient {
  const html = "<html><body><p>Your out-the-door price is $31,250.</p></body></html>";
  const wireMessage = {
    id: "g-msg-html",
    threadId: "g-thread-html",
    internalDate: "1711900000000",
    labelIds: ["INBOX"],
    payload: {
      mimeType: "text/html",
      headers: [
        { name: "From", value: "Sam <sam@dealer-a.com>" },
        { name: "To", value: "buyer@example.com" },
        { name: "Subject", value: "Re: 2026 Tucson quote" },
      ],
      body: { data: b64url(html) },
    },
  };
  return {
    users: {
      getProfile: async () => ({ data: { historyId: "1", messagesTotal: 1 } }),
      messages: {
        list: async () => ({ data: { messages: [{ id: "g-msg-html", threadId: "g-thread-html" }] } }),
        get: async () => ({ data: wireMessage }),
        send: async () => ({ data: { id: "x" } }),
        attachments: { get: async () => ({ data: { data: "" } }) },
      },
      threads: { get: async () => ({ data: { messages: [wireMessage] } }) },
      history: { list: async () => ({ data: { historyId: "1", history: [] } }) },
    },
  } as unknown as GmailApiClient;
}

describe("dealer_inbox_check — HTML-only body recovery (end to end)", () => {
  it("persists a NON-empty body_text for an HTML-only dealer reply (no silent data loss)", async () => {
    seedProfile();
    seedDealerWithContact({ dealerId: DEALER_A, name: "Dealer A", email: "sam@dealer-a.com" });
    seedLeadSubmission({ dealerId: DEALER_A, submittedAtMs: Date.now() - 3 * DAY_MS });
    // Inject the REAL adapter so mapMessage (and its html→text fallback) runs.
    __setDealerInboxCheckDepsForTests({
      createAdapter: () => new RealGmailAdapter({ client: htmlOnlyGmailClient() }),
    });

    const { run, result } = await startRun("inbox-htmlonly-1", PROFILE_ID);
    expect(result.status).toBe("suspended");
    const final = await run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [DEALER_A] },
    });
    expect(final.status).toBe("success");

    const row = db.$client
      .prepare("SELECT body_text FROM messages WHERE gmail_message_id = ?")
      .get("g-msg-html") as { body_text: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row?.body_text).not.toBeNull();
    expect(row?.body_text ?? "").toContain("31,250");
    expect(row?.body_text ?? "").toContain("out-the-door");
  });
});
