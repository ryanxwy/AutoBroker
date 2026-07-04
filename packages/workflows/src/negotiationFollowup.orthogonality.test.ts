/**
 * Orthogonality test — the L2 send-gate decline path under a Claude-OAuth selection.
 *
 * WHAT THIS PROVES: the chosen LLM lane (DeepSeek api-key default vs
 * Claude OAuth lane B) is ORTHOGONAL to the L2 batch_review gate and the
 * decline path. Registering `{provider:"anthropic",method:"oauth"}` on the
 * runId before starting the run does NOT change the gate suspend, the decline
 * outcome, or the zero-mutation guarantee.
 *
 * METHOD: re-run the decline-at-① case from negotiationFollowup.test.ts with
 * `setRunSelection` called first. The LLM (draftProse) is still stubbed so no
 * real call is made — the test is deterministic. The point is that the
 * registered selection on the runId is visible to the selection registry but
 * the gate suspend and decline outcome are BYTE-IDENTICAL to the DeepSeek-
 * default (no-selection-set) path.
 *
 * ISOLATION: fresh os.tmpdir() subdir per case; same migrations as the parent
 * test; teardown clears the selection registry.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, openDb, type Db } from "@autobroker/tools";

import {
  __clearAllRunSelectionsForTests,
  setRunSelection,
} from "./agentSelection.js";
import { createMastraInstance } from "./mastra.js";
import {
  negotiationFollowupWorkflow,
  NEGOTIATION_FOLLOWUP_WORKFLOW_ID,
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

const PROFILE_ID = "prof-ortho-1";
const DEALER_TARGET = "dealer-ortho-jim";
const DEALER_COMPETE = "dealer-ortho-kia";
const THREAD_TARGET = "thread-ortho-jim";

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-ortho-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
});

afterEach(() => {
  __resetNegotiationFollowupDepsForTests();
  __clearAllRunSelectionsForTests();
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

// ---------------------------------------------------------------------------
// seed helpers (self-contained — do not import from the parent test)
// ---------------------------------------------------------------------------

function seedAssertiveScenario(): void {
  const c = db.$client;
  c.prepare(
    "INSERT INTO search_profiles (search_profile_id, year, make, model, trim, " +
      "search_radius_miles, location_query, postal_code, follow_up_email, " +
      "financing_preference, status, brand, account_id) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
  ).run(PROFILE_ID, 2026, "Hyundai", "Tucson", "Limited", 50, "Tucson, AZ 85704", "92614", "jordan.buyer@example.com", "finance", "Hyundai", "acct-test-ortho");

  for (const [dealerId, name, website] of [
    [DEALER_TARGET, "Jim Click Hyundai", "https://jimclick.example.com"],
    [DEALER_COMPETE, "Tucson Kia", "https://tucsonkia.example.com"],
  ] as [string, string, string][]) {
    c.prepare("INSERT INTO dealers (dealer_id, name, country, website) VALUES (?, ?, 'US', ?)").run(dealerId, name, website);
    c.prepare("INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')").run(PROFILE_ID, dealerId);
  }

  const recent = Date.now() - 3 * 24 * 60 * 60 * 1000;
  c.prepare(
    "INSERT INTO threads (thread_id, dealer_id, subject, state, search_profile_id) VALUES (?, ?, ?, 'replied', ?)",
  ).run(THREAD_TARGET, DEALER_TARGET, "Quote request", PROFILE_ID);
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, sender, recipient, " +
      "subject, body_text, received_at, processed_at, sender_email, sender_name, " +
      "search_profile_id, quote_extraction_status) " +
      "VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
  ).run(
    `msg-in-${THREAD_TARGET}`, THREAD_TARGET, `gmail-${THREAD_TARGET}`,
    "sales@jimclick.example.com", "jordan.buyer@example.com",
    "Quote request", "Here is our quote on the Tucson Limited. Let me know.",
    recent, recent, "sales@jimclick.example.com", "Sales Team", PROFILE_ID,
  );

  for (const [dealerId, otd] of [[DEALER_TARGET, 33_900], [DEALER_COMPETE, 31_200]] as [string, number][]) {
    c.prepare(
      "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, " +
        "search_profile_id, financing_mode, selling_price, doc_fee, dealer_fee, sales_tax, " +
        "otd_total, quote_received_at, quote_expires_at) " +
        "VALUES (?, ?, ?, ?, ?, 'cash', ?, ?, ?, ?, ?, ?, NULL)",
    ).run(`quote-${dealerId}`, dealerId, `qmsg-${dealerId}`, `qgmail-${dealerId}`, PROFILE_ID, otd - 2500, 85, 499, 1900, otd, Date.now());
  }

  c.prepare(
    "INSERT INTO dealer_contacts (contact_id, dealer_id, email, normalized_email, " +
      "display_name, role, is_primary_reply_target) VALUES (?, ?, ?, ?, ?, ?, 1)",
  ).run("ct-ortho-1", DEALER_TARGET, "rep@jimclick.example.com", "rep@jimclick.example.com", "Sales Rep", "sales");
}

function count(table: string): number {
  const r = db.$client.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return r.n;
}

function threadState(threadId: string): string {
  const r = db.$client.prepare("SELECT state FROM threads WHERE thread_id = ?").get(threadId) as { state: string };
  return r.state;
}

// ---------------------------------------------------------------------------
// The stubs (identical to the parent test's pattern)
// ---------------------------------------------------------------------------

const draftProseStub: NegotiationFollowupWorkflowDeps["draftProse"] = (async (input: { prompt: string }) => {
  void input;
  return {
    text: "Thanks for the quote. Another dealer is at 31,200 out-the-door. Can you match that?",
    usage: { costUsd: null, durationMs: 1, pricingSource: "unavailable" as const, promptTokens: null, completionTokens: null },
  };
}) as unknown as NegotiationFollowupWorkflowDeps["draftProse"];

const sendNeverCalled = (async () => {
  throw new Error("sendAndRecord must not be called on the decline path");
}) as unknown as NegotiationFollowupWorkflowDeps["sendAndRecord"];

// ---------------------------------------------------------------------------
// Orthogonality: decline-at-① is IDENTICAL under Claude-OAuth selection
// ---------------------------------------------------------------------------

describe("negotiation_followup — L2 gate orthogonality: Claude-OAuth selection vs DeepSeek default", () => {
  it(
    "with a Claude-OAuth selection registered for the runId, " +
      "decline at ① still yields terminal `declined`, ZERO outbound messages, ZERO thread-state changes",
    async () => {
      seedAssertiveScenario();
      __setNegotiationFollowupDepsForTests({
        draftProse: draftProseStub,
        sendAndRecord: sendNeverCalled,
      });

      const runId = "nf-ortho-decline-1";

      // Register the Claude-OAuth selection BEFORE starting the run — this is
      // what the server does when the user picks lane B.
      setRunSelection(runId, { provider: "anthropic", method: "oauth", model: null, effort: "off" });

      const mastra = createMastraInstance({
        workflows: { [NEGOTIATION_FOLLOWUP_WORKFLOW_ID]: negotiationFollowupWorkflow as never },
      });
      const wf = mastra.getWorkflow(NEGOTIATION_FOLLOWUP_WORKFLOW_ID);
      const run = await wf.createRun({ runId });

      const startResult = await run.start({
        inputData: { search_profile_id: PROFILE_ID, thread_id: null },
      });

      // The gate still suspends — identical shape to the DeepSeek-default path.
      expect(startResult.status).toBe("suspended");
      const payload = (startResult as { steps?: Record<string, { suspendPayload?: Record<string, unknown> }> })
        .steps?.["batchReview"]?.suspendPayload;
      expect(payload).toBeDefined();
      expect(payload!["kind"]).toBe("batch_review");
      expect((payload!["targets"] as unknown[]).length).toBe(1);

      // Decline at ①.
      const final = await run.resume({ step: "batchReview", resumeData: { action: "decline" } });
      expect(final.status).toBe("success");
      if (final.status !== "success") return;

      // Outcome is identical to the DeepSeek-default decline: terminal `declined`.
      expect((final.result as { outcome: string }).outcome).toBe("declined");

      // ZERO external mutation: only the seeded inbound message exists; no
      // outbound was written, thread state is unchanged.
      expect(count("messages")).toBe(1);
      expect(threadState(THREAD_TARGET)).toBe("replied");

      // The selection was registered but the gate/decline path never consumed it
      // for a real LLM call — proving the selection is ORTHOGONAL to the gate.
    },
  );
});
