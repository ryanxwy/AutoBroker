/**
 * THE Phase-2 headline verify (deterministic, no live LLM): three DIFFERENT-BRAND
 * profiles run three DIFFERENT irreversible-send skills CONCURRENTLY through the real
 * SkillRunService + a real Mastra, each parking its own batch_review gate:
 *   A → dealer_web_lead_submit, B → negotiation_followup, C → dealer_closeout_email.
 *
 * Asserts the Phase-2 contract:
 *   - each suspends INDEPENDENTLY (three parked gates, one per run/profile);
 *   - the ApprovalInbox lists all three, keyed (profileId, runId, decisionId), reason-
 *     tagged, action-required (the 3 sends);
 *   - declining ONE (B) is zero-write FOR THAT profile and a NO-OP for the others
 *     (A and C stay parked, untouched);
 *   - the portfolio keystone (no_external_mutation, partitioned) == 0 in test mode.
 *
 * AUTOBROKER_TEST_AUTO_APPROVE stays UNSET — approval is exercised via the gate.
 * Migrations 0000-0003 (0003 carries the dealership-exclusivity constraints); each
 * profile uses globally-distinct dealer ids (the bound partial-unique index is global).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openDb, closeDb, type Db } from "@autobroker/tools";
import {
  createMastraInstance,
  REGISTERED_WORKFLOWS,
  resetRuntimeGlueForTests,
  __setDealerWebLeadSubmitDepsForTests,
  __resetDealerWebLeadSubmitDepsForTests,
  __setNegotiationFollowupDepsForTests,
  __resetNegotiationFollowupDepsForTests,
  __setDealerCloseoutEmailDepsForTests,
  __resetDealerCloseoutEmailDepsForTests,
  type DealerWebLeadSubmitWorkflowDeps,
  type NegotiationFollowupWorkflowDeps,
  type DealerCloseoutEmailWorkflowDeps,
} from "@autobroker/workflows";

import { SkillRunService } from "../skillRuns.js";
import { RunPubSub } from "../runPubSub.js";
import { ApprovalInbox } from "./approvalInbox.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQLS = [
  "0000_military_red_skull.sql",
  "0001_redundant_ozymandias.sql",
  "0002_pale_thunderball.sql",
  "0003_salty_jocasta.sql",
].map((f) => join(here, "..", "..", "..", "..", "packages", "db", "drizzle", f));

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";

let tmpDir: string;
let db: Db;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

// --- profile A: lead_submit ---
const A = "verify-A-lead";
const A_DEALER = "ls-dealer-jim";
// --- profile B: negotiation ---
const B = "verify-B-nego";
const B_DEALER = "nf-dealer-jim";
const B_DEALER_COMPETE = "nf-dealer-kia";
const B_THREAD = "nf-thread-jim";
// --- profile C: closeout ---
const C = "verify-C-close";
const C_DEALER = "co-dealer-jim";
const C_THREAD = "co-thread-jim";

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-verify-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
  db = openDb();
  for (const sql of MIGRATION_SQLS) db.$client.exec(readFileSync(sql, "utf8"));
  resetRuntimeGlueForTests();
  installDeps();
  seedAll();
});

afterEach(() => {
  __resetDealerWebLeadSubmitDepsForTests();
  __resetNegotiationFollowupDepsForTests();
  __resetDealerCloseoutEmailDepsForTests();
  resetRuntimeGlueForTests();
  db.$client.close();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

// --- dependency stubs: reach each first suspend WITHOUT a real browser/gmail/LLM ----
function installDeps(): void {
  const WEB_FORM_SHAPE = {
    form: { url: "https://ls-jim.example.com/contact.htm", submitSelector: "button[type=submit]" },
    platform: "dealerfire" as const,
    fieldMap: [
      { name: "Email", role: "email" as const },
      { name: "Comments", role: "comment" as const },
    ],
    formSnapshot: null,
    contactEmail: null,
    captcha: false,
  };
  const scoutForms: DealerWebLeadSubmitWorkflowDeps["scoutForms"] = async (args) =>
    args.dealers.map((d) => ({ dealerId: d.dealerId, name: d.name, website: d.website, ...WEB_FORM_SHAPE }));
  __setDealerWebLeadSubmitDepsForTests({
    scoutForms,
    submitOne: (async () => {
      throw new Error("submitOne must not fire on a suspend/decline path");
    }) as unknown as DealerWebLeadSubmitWorkflowDeps["submitOne"],
    sendAndRecord: (async () => {
      throw new Error("sendAndRecord must not fire on a suspend/decline path");
    }) as unknown as DealerWebLeadSubmitWorkflowDeps["sendAndRecord"],
    harnessGenerate: (async () => {
      throw new Error("harness.generate must not fire on a suspend/decline path");
    }) as unknown as DealerWebLeadSubmitWorkflowDeps["harnessGenerate"],
  });

  const draftProse: NegotiationFollowupWorkflowDeps["draftProse"] = (async () => ({
    text:
      "Thanks for the quote. Another dealer is at 31,200 out-the-door on the same trim — " +
      "can you match or beat that? Happy to move quickly if the numbers work.",
    usage: {
      costUsd: null,
      durationMs: 1,
      pricingSource: "unavailable" as const,
      promptTokens: null,
      completionTokens: null,
    },
  })) as unknown as NegotiationFollowupWorkflowDeps["draftProse"];
  __setNegotiationFollowupDepsForTests({
    draftProse,
    sendAndRecord: (async () => {
      throw new Error("sendAndRecord must not fire on a suspend/decline path");
    }) as unknown as NegotiationFollowupWorkflowDeps["sendAndRecord"],
  });

  __setDealerCloseoutEmailDepsForTests({
    closeAndSuppressDealer: (async () => {
      throw new Error("closeAndSuppressDealer must not fire on a suspend/decline path");
    }) as unknown as DealerCloseoutEmailWorkflowDeps["closeAndSuppressDealer"],
  });
}

// --- seeds (parameterized; globally-unique dealer ids; distinct brands) -------------
function seedProfile(id: string, make: string, brand: string, model: string): void {
  db.$client
    .prepare(
      "INSERT INTO search_profiles (search_profile_id, year, make, model, trim, " +
        "search_radius_miles, location_query, postal_code, follow_up_email, " +
        "financing_preference, status, brand, account_id) " +
        "VALUES (?, 2026, ?, ?, 'Limited', 50, 'Tucson, AZ 85704', '92614', " +
        "'jordan.buyer@example.com', 'finance', 'active', ?, 'acct-verify-1')",
    )
    .run(id, make, model, brand);
}

function seedDealer(dealerId: string, name: string, contactEmail: string | null, profileId: string): void {
  const c = db.$client;
  c.prepare(
    "INSERT INTO dealers (dealer_id, name, country, website, contact_email) VALUES (?, ?, 'US', ?, ?)",
  ).run(dealerId, name, `https://${dealerId}.example.com`, contactEmail);
  c.prepare(
    "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound')",
  ).run(profileId, dealerId);
}

function seedThread(threadId: string, dealerId: string, profileId: string, withGmailThread: boolean): void {
  const c = db.$client;
  c.prepare(
    "INSERT INTO threads (thread_id, dealer_id, gmail_thread_id, subject, state, search_profile_id) " +
      "VALUES (?, ?, ?, 'Quote request', 'replied', ?)",
  ).run(threadId, dealerId, withGmailThread ? `gmail-${threadId}` : null, profileId);
  const recent = Date.now() - 3 * 24 * 60 * 60 * 1000; // 3 days ago -> within the 7-day "ready" window
  c.prepare(
    "INSERT INTO messages (message_id, thread_id, gmail_message_id, direction, sender, recipient, " +
      "subject, body_text, received_at, processed_at, contact_id, sender_email, sender_name, " +
      "search_profile_id, quote_extraction_status) " +
      "VALUES (?, ?, ?, 'inbound', ?, 'jordan.buyer@example.com', 'Quote request', " +
      "'Here is our quote on the Limited.', ?, ?, NULL, ?, 'Sales Team', ?, 'pending')",
  ).run(
    `msg-in-${threadId}`,
    threadId,
    `gmail-${threadId}`,
    "sales@" + dealerId + ".example.com",
    recent,
    recent,
    "sales@" + dealerId + ".example.com",
    profileId,
  );
}

function seedQuote(dealerId: string, profileId: string, otdTotal: number): void {
  db.$client
    .prepare(
      "INSERT INTO dealer_quotes (quote_id, dealer_id, message_id, source_gmail_message_id, " +
        "search_profile_id, financing_mode, selling_price, doc_fee, dealer_fee, sales_tax, " +
        "otd_total, quote_received_at, quote_expires_at) " +
        "VALUES (?, ?, ?, ?, ?, 'cash', ?, 85, 499, 1900, ?, ?, NULL)",
    )
    .run(
      `quote-${dealerId}`,
      dealerId,
      `qmsg-${dealerId}`,
      `qgmail-${dealerId}`,
      profileId,
      otdTotal - 2500,
      otdTotal,
      Date.now(),
    );
}

function seedContact(contactId: string, dealerId: string, email: string): void {
  db.$client
    .prepare(
      "INSERT INTO dealer_contacts (contact_id, dealer_id, email, normalized_email, " +
        "display_name, role, is_primary_reply_target) VALUES (?, ?, ?, ?, 'Sales Rep', 'sales', 1)",
    )
    .run(contactId, dealerId, email, email.toLowerCase());
}

function seedAll(): void {
  // A — lead_submit: a bound web-form dealer.
  seedProfile(A, "Hyundai", "Hyundai", "Tucson");
  seedDealer(A_DEALER, "Jim Click Hyundai", null, A);

  // B — negotiation: an open thread + an itemized quote + a competing cheaper quote + a primary contact.
  seedProfile(B, "Toyota", "Toyota", "Camry");
  seedDealer(B_DEALER, "Jim Click Toyota", null, B);
  seedDealer(B_DEALER_COMPETE, "Tucson Toyota", null, B);
  seedThread(B_THREAD, B_DEALER, B, false);
  seedQuote(B_DEALER, B, 33_900);
  seedQuote(B_DEALER_COMPETE, B, 31_200);
  seedContact("ct-B-1", B_DEALER, "rep@" + B_DEALER + ".example.com");

  // C — closeout: a bound addressable dealer with an open thread.
  seedProfile(C, "Honda", "Honda", "Accord");
  seedDealer(C_DEALER, "Jim Click Honda", "sales@" + C_DEALER + ".example.com", C);
  seedThread(C_THREAD, C_DEALER, C, true);
}

async function waitForPending(svc: SkillRunService, runId: string): Promise<string> {
  for (let i = 0; i < 240; i += 1) {
    const pending = svc.pendingOf(runId);
    if (pending !== null) return pending.decisionId;
    if (svc.isTerminal(runId)) throw new Error(`run ${runId} went terminal before parking a gate`);
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${runId} never parked a gate`);
}

/** The portfolio no_external_mutation keystone, inline (mirrors harness/dbReads
 *  externalMutationByProfile.portfolioTotal — unit-tested there). */
function portfolioExternalMutationTotal(): number {
  const c = db.$client;
  const submitted = (
    c.prepare("SELECT COUNT(*) AS n FROM lead_submissions WHERE outcome = 'submitted'").get() as { n: number }
  ).n;
  const audits = (
    c
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action IN " +
          "('gmail_send','dealer_web_lead_submit','lead_submit','send','submit','dealer_closeout_email','negotiation_followup')",
      )
      .get() as { n: number }
  ).n;
  const outbound = (
    c
      .prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE direction = 'outbound' AND gmail_message_id IS NOT NULL " +
          "AND gmail_message_id NOT LIKE 'sandbox-out-%'",
      )
      .get() as { n: number }
  ).n;
  return submitted + audits + outbound;
}

function outboundCountFor(profileId: string): number {
  return (
    db.$client
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE search_profile_id = ? AND direction = 'outbound'")
      .get(profileId) as { n: number }
  ).n;
}

describe("Phase 2 — concurrent multi-profile suspend + inbox + decline isolation + keystone", () => {
  it("drives A/B/C concurrently to independent gates, lists them in the inbox, declines B with zero cross-profile effect, keystone == 0", async () => {
    const svc = new SkillRunService(createMastraInstance({ workflows: REGISTERED_WORKFLOWS }), new RunPubSub());
    const inbox = new ApprovalInbox(svc);

    // Start three independent pipelines CONCURRENTLY.
    await svc.start({
      skill: "dealer_web_lead_submit",
      runId: "A-lead",
      input: { search_profile_id: A, target_listing_id: null, force_retry: false },
    });
    await svc.start({
      skill: "negotiation_followup",
      runId: "B-nego",
      input: { search_profile_id: B, thread_id: null },
    });
    await svc.start({
      skill: "dealer_closeout_email",
      runId: "C-close",
      input: { search_profile_id: C },
    });

    // Each parks its OWN gate, independently.
    const aDecision = await waitForPending(svc, "A-lead");
    const bDecision = await waitForPending(svc, "B-nego");
    const cDecision = await waitForPending(svc, "C-close");
    expect(aDecision).toBeTruthy();
    expect(bDecision).toBeTruthy();
    expect(cDecision).toBeTruthy();

    // The inbox lists all three, keyed (profileId, runId, decisionId), reason-tagged, action-required.
    const items = inbox.list();
    const byProfile = Object.fromEntries(items.map((i) => [i.profileId, i]));
    expect(items).toHaveLength(3);
    expect(byProfile[A]).toMatchObject({ runId: "A-lead", reason: "lead_submit", actionRequired: true });
    expect(byProfile[A]!.decisionId).toBe(aDecision);
    expect(byProfile[B]).toMatchObject({ runId: "B-nego", reason: "negotiation", actionRequired: true });
    expect(byProfile[C]).toMatchObject({ runId: "C-close", reason: "closeout", actionRequired: true });

    // No external mutation reached any profile at the gate (test mode).
    expect(portfolioExternalMutationTotal()).toBe(0);

    // Decline B through the idempotent formDecision (the same three-phase claim the
    // POST /api/skill-runs/:id/form-decision route drives).
    await svc.formDecision("B-nego", { decision_id: bDecision, decision: { action: "decline" } });

    // B is terminal + zero-write for B; A and C are a NO-OP (still parked).
    expect(svc.isTerminal("B-nego")).toBe(true);
    expect(outboundCountFor(B)).toBe(0); // decline wrote no outbound for B
    expect(svc.pendingOf("A-lead")).not.toBeNull();
    expect(svc.pendingOf("C-close")).not.toBeNull();

    // The inbox now lists only the two still-parked gates.
    const after = inbox.list();
    expect(after.map((i) => i.profileId).sort()).toEqual([A, C].sort());

    // The portfolio keystone is still clean after the decline.
    expect(portfolioExternalMutationTotal()).toBe(0);
  });
});
