/**
 * In-stack tests — the dealer_hygiene flat 3-suspend workflow.
 *
 * These drive the REAL flat Mastra createWorkflow → REAL createRun/start/resume
 * chain (in-process against a tmp mastra.db) → REAL step closures, with the REAL
 * detect/commit tools running against an ISOLATED tmp autobroker.db (the
 * committed migrations applied). NO LLM, no network.
 *
 * THE KEYSTONE — decline at EACH stage = ZERO writes for the WHOLE run (shape A,
 * deferred single-transaction commit). Acceptance (the 8 cases):
 *   1. approve all three → counts match;
 *   2. decline at 5a → ALL three tables Δ=0, outcome "declined";
 *   3. decline at 5b (after 5a staged) → ALL Δ=0;
 *   4. decline at 5c → ALL Δ=0;
 *   5. empty 5a → its suspend skipped, 5b/5c still run;
 *   6. all-empty → nothing_to_clean;
 *   7. re-run after a clean → no-op;
 *   8. a quote-owning contact in approved_ids → HygieneRejectedError rolls back
 *      the whole tx.
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
  dealerHygieneWorkflow,
  DEALER_HYGIENE_WORKFLOW_ID,
  __resetDealerHygieneDepsForTests,
  __setDealerHygieneDepsForTests,
} from "./dealerHygiene.js";

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

const DEALER_A = "dealer-a";

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-hygiene-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
  db.$client.prepare("INSERT INTO dealers (dealer_id, name, country) VALUES (?, ?, 'US')").run(DEALER_A, "Dealer A");
});

afterEach(() => {
  __resetDealerHygieneDepsForTests();
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

// ---------------------------------------------------------------------------
// seed helpers — one orphan + one CRM-noise thread + one CRM contact
// ---------------------------------------------------------------------------

function seedProfile(id = "prof-hyg"): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, status, brand, account_id) " +
        "VALUES (?, 2026, 'Hyundai', 'Tucson', 'active', 'Hyundai', 'acct-1')",
    )
    .run(id);
}

/** Seed all three candidate kinds. Returns the candidate ids. */
function seedAllCandidates(): { orphan: string; crmThread: string; contact: string } {
  const c = db.$client;
  // orphan: zero messages, gmail_thread_id is a real message-id (gm-1)
  c.prepare("INSERT INTO threads (thread_id, dealer_id, gmail_thread_id) VALUES ('t-real', ?, 'gm-x')").run(DEALER_A);
  c.prepare("INSERT INTO messages (message_id, thread_id, gmail_message_id, direction) VALUES ('m-real', 't-real', 'gm-1', 'inbound')").run();
  c.prepare("INSERT INTO threads (thread_id, dealer_id, gmail_thread_id) VALUES ('t-orphan', ?, 'gm-1')").run(DEALER_A);
  // crm-only thread: inbound nurture, sibling outbound exists (t-real has m-real inbound;
  // we need an outbound sibling), no offer, state<>agreed
  c.prepare("INSERT INTO messages (message_id, thread_id, direction) VALUES ('m-out', 't-real', 'outbound')").run();
  c.prepare("INSERT INTO threads (thread_id, dealer_id, gmail_thread_id, subject) VALUES ('t-crm', ?, 'real-thread', 'Still shopping?')").run(DEALER_A);
  c.prepare("INSERT INTO messages (message_id, thread_id, direction) VALUES ('m-crm', 't-crm', 'inbound')").run();
  c.prepare("INSERT INTO message_analysis (analysis_id, message_id, analysis_version, is_current, intent) VALUES ('a-crm', 'm-crm', 1, 1, 'nurture')").run();
  // crm contact
  c.prepare(
    "INSERT INTO dealer_contacts (contact_id, dealer_id, normalized_email, is_crm_platform_sender) VALUES ('c-crm', ?, 'x@podium.email', 1)",
  ).run(DEALER_A);
  return { orphan: "t-orphan", crmThread: "t-crm", contact: "c-crm" };
}

function count(table: string): number {
  return (db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function snapshot() {
  return {
    threads: count("threads"),
    suppression: count("thread_suppression"),
    contactsDemoted: (
      db.$client.prepare("SELECT COUNT(*) AS n FROM dealer_contacts WHERE is_crm_platform_sender = 1").get() as {
        n: number;
      }
    ).n,
  };
}

// ---------------------------------------------------------------------------
// run drivers
// ---------------------------------------------------------------------------

function hygieneWorkflow() {
  const mastra = createMastraInstance({
    workflows: { [DEALER_HYGIENE_WORKFLOW_ID]: dealerHygieneWorkflow as never },
  });
  return mastra.getWorkflow(DEALER_HYGIENE_WORKFLOW_ID);
}

async function startRun(runId: string, searchProfileId: string | null = null) {
  const wf = hygieneWorkflow();
  const run = await wf.createRun({ runId });
  const result = await run.start({ inputData: { search_profile_id: searchProfileId } });
  return { run, result };
}

type HygieneRun = Awaited<ReturnType<typeof startRun>>["run"];

/** Read `.result` off any workflow result without TS narrowing the union away. */
function resultOf(result: unknown): Record<string, unknown> {
  return (result as { result?: Record<string, unknown> }).result ?? {};
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

function suspendedStep(result: unknown): string | null {
  const steps = (result as { steps?: Record<string, { status?: string }> }).steps;
  if (steps === undefined) return null;
  for (const [id, s] of Object.entries(steps)) {
    if (s.status === "suspended") return id;
  }
  return null;
}

function suspendPayloadOf(result: unknown, step: string): Record<string, unknown> {
  const steps = (result as { steps?: Record<string, { suspendPayload?: Record<string, unknown> }> }).steps;
  const payload = steps?.[step]?.suspendPayload;
  expect(payload).toBeDefined();
  return payload!;
}

/** Approve every shown id at the current suspended stage; returns the next result. */
async function approveAll(run: HygieneRun, result: unknown) {
  const step = suspendedStep(result)!;
  const payload = suspendPayloadOf(result, step);
  const ids = (payload["targets"] as Array<{ id: string }>).map((t) => t.id);
  return (await run.resume({ step, resumeData: { action: "approve", approved_ids: ids } })) as {
    status: string;
    result?: unknown;
    steps?: unknown;
  };
}

// ---------------------------------------------------------------------------
// case 1 — approve all three stages → counts match
// ---------------------------------------------------------------------------

describe("dealer_hygiene — approve all three stages", () => {
  it("deletes the orphan, suppresses the CRM thread, demotes the contact; counts match", async () => {
    seedProfile();
    seedAllCandidates();

    const start = await startRun("hyg-approve-1");
    expect(start.result.status).toBe("suspended");
    expect(suspendedStep(start.result)).toBe("suspend5a");

    const after5a = await approveAll(start.run, start.result);
    expect(after5a.status).toBe("suspended");
    expect(suspendedStep(after5a)).toBe("suspend5b");

    const after5b = await approveAll(start.run, after5a);
    expect(after5b.status).toBe("suspended");
    expect(suspendedStep(after5b)).toBe("suspend5c");

    const final = await approveAll(start.run, after5b);
    expect(final.status).toBe("success");
    const out = final.result as Record<string, unknown>;
    expect(out["outcome"]).toBe("cleaned");
    expect(out["orphans_deleted"]).toBe(1);
    expect(out["crm_threads_suppressed"]).toBe(1);
    expect(out["crm_contacts_suppressed"]).toBe(1);

    // orphan deleted; t-crm suppressed (still present); contact demoted
    expect(db.$client.prepare("SELECT 1 FROM threads WHERE thread_id='t-orphan'").get()).toBeUndefined();
    const st = db.$client.prepare("SELECT state FROM threads WHERE thread_id='t-crm'").get() as { state: string };
    expect(st.state).toBe("suppressed");
    // red-line: the orphan's gmail_thread_id never landed in a suppression row
    const leaked = db.$client.prepare("SELECT COUNT(*) AS n FROM thread_suppression WHERE gmail_thread_id='gm-1'").get() as { n: number };
    expect(leaked.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cases 2/3/4 — decline at EACH stage = ZERO writes for the WHOLE run
// ---------------------------------------------------------------------------

describe("dealer_hygiene — decline at any stage = ZERO writes (the keystone)", () => {
  it("decline at 5a → ALL tables Δ=0, outcome declined", async () => {
    seedProfile();
    seedAllCandidates();
    const before = snapshot();

    const start = await startRun("hyg-decline-5a");
    expect(suspendedStep(start.result)).toBe("suspend5a");
    const final = (await start.run.resume({ step: "suspend5a", resumeData: { action: "decline" } })) as {
      status: string;
      result?: unknown;
    };
    expect(final.status).toBe("success");
    expect((final.result as { outcome: string }).outcome).toBe("declined");
    expect(snapshot()).toEqual(before); // EXACT Δ=0
  });

  it("decline at 5b (after 5a already staged) → ALL tables Δ=0 (deferred-commit proof)", async () => {
    seedProfile();
    seedAllCandidates();
    const before = snapshot();

    const start = await startRun("hyg-decline-5b");
    const after5a = await approveAll(start.run, start.result); // STAGE the orphan
    expect(suspendedStep(after5a)).toBe("suspend5b");
    const final = (await start.run.resume({ step: "suspend5b", resumeData: { action: "decline" } })) as {
      status: string;
      result?: unknown;
    };
    expect(final.status).toBe("success");
    expect((final.result as { outcome: string }).outcome).toBe("declined");
    // the orphan staged at 5a was NEVER committed:
    expect(snapshot()).toEqual(before); // EXACT Δ=0
    expect(db.$client.prepare("SELECT 1 FROM threads WHERE thread_id='t-orphan'").get()).toBeDefined();
  });

  it("decline at 5c (after 5a+5b staged) → ALL tables Δ=0", async () => {
    seedProfile();
    seedAllCandidates();
    const before = snapshot();

    const start = await startRun("hyg-decline-5c");
    const after5a = await approveAll(start.run, start.result);
    const after5b = await approveAll(start.run, after5a);
    expect(suspendedStep(after5b)).toBe("suspend5c");
    const final = (await start.run.resume({ step: "suspend5c", resumeData: { action: "decline" } })) as {
      status: string;
      result?: unknown;
    };
    expect(final.status).toBe("success");
    expect((final.result as { outcome: string }).outcome).toBe("declined");
    expect(snapshot()).toEqual(before); // EXACT Δ=0
  });
});

// ---------------------------------------------------------------------------
// case 5 — empty 5a → its suspend skipped, 5b/5c still run
// ---------------------------------------------------------------------------

describe("dealer_hygiene — empty stage skips its suspend", () => {
  it("with no orphans, the first suspend is 5b (orphans skipped)", async () => {
    seedProfile();
    const c = db.$client;
    // only a CRM thread + contact (no orphan)
    c.prepare("INSERT INTO threads (thread_id, dealer_id) VALUES ('t-out', ?)").run(DEALER_A);
    c.prepare("INSERT INTO messages (message_id, thread_id, direction) VALUES ('m-out', 't-out', 'outbound')").run();
    c.prepare("INSERT INTO threads (thread_id, dealer_id, subject) VALUES ('t-crm', ?, 'Still shopping?')").run(DEALER_A);
    c.prepare("INSERT INTO messages (message_id, thread_id, direction) VALUES ('m-crm', 't-crm', 'inbound')").run();
    c.prepare("INSERT INTO message_analysis (analysis_id, message_id, analysis_version, is_current, intent) VALUES ('a-crm', 'm-crm', 1, 1, 'marketing')").run();
    c.prepare("INSERT INTO dealer_contacts (contact_id, dealer_id, normalized_email, is_crm_platform_sender) VALUES ('c-crm', ?, 'x@podium.email', 1)").run(DEALER_A);

    const start = await startRun("hyg-empty5a");
    expect(start.result.status).toBe("suspended");
    expect(suspendedStep(start.result)).toBe("suspend5b"); // 5a was skipped
  });
});

// ---------------------------------------------------------------------------
// case 6 — all-empty → nothing_to_clean
// ---------------------------------------------------------------------------

describe("dealer_hygiene — nothing to clean", () => {
  it("a clean mailbox → cleaned with nothing_to_clean (no suspends)", async () => {
    seedProfile();
    const start = await startRun("hyg-empty");
    expect(start.result.status).toBe("success");
    const out = resultOf(start.result);
    expect(out["outcome"]).toBe("cleaned");
    expect(out["nothing_to_clean"]).toBe(true);
    expect(out["orphans_deleted"]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// case 7 — re-run after a clean → no-op (idempotent)
// ---------------------------------------------------------------------------

describe("dealer_hygiene — re-run idempotent", () => {
  it("a second run after a full clean surfaces nothing → nothing_to_clean", async () => {
    seedProfile();
    seedAllCandidates();

    const first = await startRun("hyg-rerun-1");
    let r: unknown = first.result;
    r = await approveAll(first.run, r);
    r = await approveAll(first.run, r);
    r = await approveAll(first.run, r);
    expect((r as { status: string }).status).toBe("success");

    const second = await startRun("hyg-rerun-2");
    expect(second.result.status).toBe("success");
    const out = resultOf(second.result);
    expect(out["outcome"]).toBe("cleaned");
    expect(out["nothing_to_clean"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// case 8 — a quote-owning contact in approved_ids → guard rolls back the whole tx
// ---------------------------------------------------------------------------

describe("dealer_hygiene — typed-guard reject rolls back the whole tx", () => {
  it("a quote-owning contact slipped into the approved set fails the run, ZERO writes", async () => {
    seedProfile();
    const seeded = seedAllCandidates();
    // make c-crm own a quote so the demote guard throws at commit time. The
    // contact still surfaces (detection sees zero quotes BEFORE we add it here —
    // so add the quote AFTER detect runs is not possible; instead bypass the
    // detection gate by injecting the contact target directly is overkill).
    // Simpler: seed the quote now and stub findCrmPlatformContacts to still
    // surface the contact (simulating a stale read / a concurrent quote).
    const c = db.$client;
    c.prepare("INSERT INTO messages (message_id, thread_id, direction, contact_id) VALUES ('m-own', 't-crm', 'inbound', 'c-crm')").run();
    c.prepare(
      "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, search_profile_id, financing_mode) VALUES ('q1', ?, 'm-own', 'g-own', 'p', 'finance')",
    ).run(DEALER_A);
    __setDealerHygieneDepsForTests({
      findCrmPlatformContacts: () => [
        {
          contact_id: seeded.contact,
          display_name: null,
          normalized_email: "x@podium.email",
          dealer_name: "Dealer A",
          reason: "stale",
        },
      ],
    });

    const before = snapshot();
    const start = await startRun("hyg-guard-1");
    let r: unknown = start.result;
    r = await approveAll(start.run, r); // 5a orphan
    r = await approveAll(start.run, r); // 5b crm thread
    // 5c: approve the quote-owning contact → commit throws → run fails
    const step = suspendedStep(r)!;
    expect(step).toBe("suspend5c");
    const final = (await start.run.resume({
      step: "suspend5c",
      resumeData: { action: "approve", approved_ids: [seeded.contact] },
    })) as { status: string; error?: unknown };
    expect(final.status).toBe("failed");
    expect(errorMessageOf(final).toLowerCase()).toContain("quote");

    // the WHOLE tx rolled back — the orphan + thread staged at 5a/5b are intact
    expect(snapshot()).toEqual(before);
    expect(db.$client.prepare("SELECT 1 FROM threads WHERE thread_id='t-orphan'").get()).toBeDefined();
  });
});
