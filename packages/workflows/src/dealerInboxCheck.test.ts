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
 * Acceptance (the 6 cases):
 *   1. approve → inbound messages written `pending`, watermark advanced;
 *   2. decline → ZERO writes, watermark NOT advanced, outcome "declined";
 *   3. zero threads → no_replies success;
 *   4. none profile → STOP;
 *   5. ambiguous → STOP;
 *   6. re-run dedup no-op.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR (saved/restored);
 * mastra.db + autobroker.db both live there; NEVER ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db, type GmailAdapter, type Thread, type ThreadRef } from "@autobroker/tools";

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
].map((f) => join(here, "..", "..", "db", "drizzle", f));

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

const PROFILE_ID = "prof-inbox-1";
const DEALER_A = "dealer-a";
const DEALER_B = "dealer-b";

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

function seedDealerWithContact(over: {
  dealerId: string;
  name: string;
  email: string;
  profileId?: string;
}): void {
  const c = db.$client;
  c.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')").run(over.dealerId, over.name);
  c.prepare("INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'candidate')").run(
    over.profileId ?? PROFILE_ID,
    over.dealerId,
  );
  c.prepare(
    "INSERT INTO dealer_contacts (contact_id, dealer_id, normalized_email, display_name) VALUES (?, ?, ?, ?)",
  ).run(`seed-${over.dealerId}`, over.dealerId, over.email.toLowerCase(), over.name);
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

function makeAdapter(threads: StubThread[]): GmailAdapter {
  const hydrate = (t: StubThread): Thread => ({
    threadId: t.threadId,
    messages: t.messages.map((m) => ({
      messageId: m.messageId,
      threadId: t.threadId,
      direction: "inbound" as const,
      from: m.from,
      to: m.to,
      subject: m.subject,
      bodyText: m.bodyText,
      bodyHtml: "",
      internalDateMs: m.internalDateMs,
      attachments: [],
    })),
  });
  return {
    kind: "fake",
    // Every search returns every thread (the workflow dedupes first-pass-wins).
    search: (_query: string, _max?: number): Promise<ThreadRef[]> =>
      Promise.resolve(
        threads.map((t) => ({ threadId: t.threadId, messageIds: t.messages.map((m) => m.messageId) })),
      ),
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
// case 1 — approve writes pending messages + advances the watermark
// ---------------------------------------------------------------------------

describe("dealer_inbox_check — approve", () => {
  it("ingests the approved dealers' replies (pending, profile-scoped) and advances the watermark", async () => {
    seedProfile();
    seedDealerWithContact({ dealerId: DEALER_A, name: "Dealer A", email: "sam@dealer-a.com" });
    seedDealerWithContact({ dealerId: DEALER_B, name: "Dealer B", email: "pat@dealer-b.com" });
    __setDealerInboxCheckDepsForTests({ createAdapter: () => makeAdapter(twoReplyThreads()) });

    const { run, result } = await startRun("inbox-approve-1");
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
    __setDealerInboxCheckDepsForTests({ createAdapter: () => makeAdapter(twoReplyThreads()) });

    const { run, result } = await startRun("inbox-subset-1");
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
// case 2 — decline → ZERO writes, watermark NOT advanced, outcome "declined"
// ---------------------------------------------------------------------------

describe("dealer_inbox_check — decline", () => {
  it("writes NOTHING and leaves the watermark untouched", async () => {
    seedProfile();
    seedDealerWithContact({ dealerId: DEALER_A, name: "Dealer A", email: "sam@dealer-a.com" });
    seedDealerWithContact({ dealerId: DEALER_B, name: "Dealer B", email: "pat@dealer-b.com" });
    __setDealerInboxCheckDepsForTests({ createAdapter: () => makeAdapter(twoReplyThreads()) });

    const { run, result } = await startRun("inbox-decline-1");
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
// case 3 — zero discovered threads → no_replies success
// ---------------------------------------------------------------------------

describe("dealer_inbox_check — no replies", () => {
  it("returns no_replies (a valid success) when the sweep finds nothing", async () => {
    seedProfile();
    seedDealerWithContact({ dealerId: DEALER_A, name: "Dealer A", email: "sam@dealer-a.com" });
    __setDealerInboxCheckDepsForTests({ createAdapter: () => makeAdapter([]) });

    const { result } = await startRun("inbox-empty-1");
    // Empty corpus → batchReview passes through (no suspend) → confirm.
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect((result.result as { outcome: string }).outcome).toBe("no_replies");
    expect(count("messages")).toBe(0);
    expect(watermark(PROFILE_ID)).not.toBeNull(); // a clean sweep still advances
  });
});

// ---------------------------------------------------------------------------
// case 4 / 5 — the resolver STOPs
// ---------------------------------------------------------------------------

describe("dealer_inbox_check — resolver STOPs", () => {
  it("STOPs with no_active_profile when there is no active profile", async () => {
    __setDealerInboxCheckDepsForTests({ createAdapter: () => makeAdapter([]) });
    const { result } = await startRun("inbox-none-1");
    expect(result.status).toBe("failed");
    expect(errorMessageOf(result)).toContain("No active search profile");
  });

  it("STOPs with multiple_active_profiles when 2+ active profiles exist", async () => {
    seedProfile({ id: "prof-x", make: "Hyundai", brand: "Hyundai" });
    seedProfile({ id: "prof-y", make: "Toyota", brand: "Toyota" });
    __setDealerInboxCheckDepsForTests({ createAdapter: () => makeAdapter([]) });
    const { result } = await startRun("inbox-ambig-1"); // null pin → ambiguous
    expect(result.status).toBe("failed");
    expect(errorMessageOf(result)).toContain("Multiple active search profiles");
  });
});

// ---------------------------------------------------------------------------
// case 6 — re-run dedup no-op
// ---------------------------------------------------------------------------

describe("dealer_inbox_check — re-run dedup", () => {
  it("a second approve over the same corpus writes nothing new", async () => {
    seedProfile();
    seedDealerWithContact({ dealerId: DEALER_A, name: "Dealer A", email: "sam@dealer-a.com" });
    seedDealerWithContact({ dealerId: DEALER_B, name: "Dealer B", email: "pat@dealer-b.com" });
    __setDealerInboxCheckDepsForTests({ createAdapter: () => makeAdapter(twoReplyThreads()) });

    const first = await startRun("inbox-rerun-1");
    await first.run.resume({
      step: "batchReview",
      resumeData: { action: "approve", approved_dealer_ids: [DEALER_A, DEALER_B] },
    });
    expect(count("messages")).toBe(2);

    // Second sweep: the same backend messages are now already ingested → the
    // discovery dedup-vs-ingested filters every thread → no_replies, zero new.
    const second = await startRun("inbox-rerun-2");
    expect(second.result.status).toBe("success");
    if (second.result.status !== "success") return;
    expect((second.result.result as { outcome: string }).outcome).toBe("no_replies");
    expect(count("messages")).toBe(2); // unchanged
  });
});
