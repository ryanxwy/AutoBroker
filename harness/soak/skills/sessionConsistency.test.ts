/**
 * skills/sessionConsistency.test.ts — the PURE plan-3 session-consistency
 * assertion lib over a REAL isolated migrated tmp DB (mirrors
 * skills/intake.test.ts + skills/dealerReplyExtract.test.ts: mkdtemp + openDb +
 * exec the 3 drizzle migrations). NO live LLM, NO server boot, NO Playwright —
 * only the pure assertion functions + the read-only DB reads that feed them.
 *
 * Covered (INV-1..INV-7 + projection + scrape-reap + journey-wide
 * no_external_mutation + budget + NL routing-accuracy):
 *  - readPipelineCompletionRows / readProfileMessageBodies / countRealOutboundMessages
 *    over real audit_log / messages rows.
 *  - INV-1 lastRunId coherence + monotonicity + survives-restart.
 *  - INV-1b the FIXED freeform-while-suspended (no-fork) shape (blocker).
 *  - INV-2 pinnedProfileId stability + forked-session-unpinned.
 *  - INV-3 decline zero-write (blocker).
 *  - INV-4 single completion row + idempotent re-run.
 *  - INV-5 suspend-payload resume contract (blocker) + batch-resume ⊆ targets.
 *  - INV-6 idempotent form-decision (200/409/410).
 *  - INV-7 restart re-attach.
 *  - INV-projection (snapshot → product status).
 *  - INV-scrape-reap (child canceled, scrape excluded, partial, /incentive_scrape).
 *  - INV-no-external-mutation journey-wide (keystone) + INV-budget-redaction (blocker).
 *  - NL routing-accuracy.
 *  - combineSoakVerdict folding: a journey-keystone / blocker failure → BLOCKER;
 *    a session-consistency invariant failure → RED; all clean → GREEN.
 *
 * ISOLATION: a throwaway tmp DB at an EXPLICIT path; never ~/.autobroker*.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDb, type Db } from "@autobroker/db";

import { externalMutationDbCount, snapshotCounts } from "../../dbReads.js";
import { combineSoakVerdict, type DeterministicResult } from "../verdict.js";
import {
  assertBatchResumeSubsetOfTargets,
  assertBudgetRedacted,
  assertDeclineZeroWrite,
  assertForkedSessionUnpinned,
  assertFreeformWhileSuspendedFixed,
  assertIdempotentFormDecision,
  assertIdempotentReRun,
  assertJourneyNoExternalMutation,
  assertLastRunIdCoherent,
  assertLastRunIdSurvivesRestart,
  assertPinnedProfileStable,
  assertProjectionMatchesSnapshot,
  assertRestartReattach,
  assertRoutingAccuracy,
  assertScrapeChildReaped,
  assertSingleCompletionRow,
  assertSuspendPayloadResumeContract,
  countRealOutboundMessages,
  PIPELINE_COMPLETE_ACTION,
  readPipelineCompletionRows,
  readProfileMessageBodies,
  type PipelineCompletionRow,
} from "./sessionConsistency.assertions.js";

const here = dirname(fileURLToPath(import.meta.url));
const DRIZZLE_DIR = join(here, "..", "..", "..", "packages", "db", "drizzle");

let tmpDir: string;
let db: Db;

const PROFILE = "soak-sc-profile";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-soak-sc-"));
  db = openDb(join(tmpDir, "autobroker.db"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0000_military_red_skull.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0001_redundant_ozymandias.sql"), "utf8"));
  db.$client.exec(readFileSync(join(DRIZZLE_DIR, "0002_pale_thunderball.sql"), "utf8"));
});

afterAll(() => {
  db.$client.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Insert one quote_pipeline.complete audit_log row with a structured payload. */
function insertCompletion(
  auditId: string,
  profileId: string,
  body: { pipeline_run_id?: string; completed_steps?: string[]; final_state?: string; next_action?: string },
): void {
  db.$client
    .prepare(
      "INSERT INTO audit_log (audit_id, action, target_table, search_profile_id, payload_json) VALUES (?, ?, ?, ?, ?)",
    )
    .run(auditId, PIPELINE_COMPLETE_ACTION, "audit_log", profileId, JSON.stringify(body));
}

/** Insert one messages row (direction + body + optional gmail id) for a profile. */
function insertMessage(
  messageId: string,
  profileId: string,
  cols: { direction?: string; body?: string | null; gmailMessageId?: string | null },
): void {
  db.$client
    .prepare(
      "INSERT INTO messages (message_id, direction, body_text, gmail_message_id, search_profile_id) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      messageId,
      cols.direction ?? "inbound",
      cols.body ?? null,
      cols.gmailMessageId ?? null,
      profileId,
    );
}

// ===========================================================================
// the read-only DB read channel (real audit_log / messages rows)
// ===========================================================================

describe("readPipelineCompletionRows (parses payload_json)", () => {
  it("reads + parses a completion row's structured body", () => {
    insertCompletion("c-1", PROFILE, {
      pipeline_run_id: "run-1",
      completed_steps: ["extract", "audit", "compare"],
      final_state: "complete",
      next_action: "review the quotes",
    });
    const rows = readPipelineCompletionRows(db, PROFILE);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pipelineRunId).toBe("run-1");
    expect(rows[0]!.completedSteps).toEqual(["extract", "audit", "compare"]);
    expect(rows[0]!.finalState).toBe("complete");
    expect(rows[0]!.nextAction).toBe("review the quotes");
  });
  it("returns [] for a profile with no completion row", () => {
    expect(readPipelineCompletionRows(db, "no-such-profile")).toEqual([]);
  });
  it("surfaces an unparseable payload_json as an empty-steps row, never drops it", () => {
    db.$client
      .prepare(
        "INSERT INTO audit_log (audit_id, action, target_table, search_profile_id, payload_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run("c-bad", PIPELINE_COMPLETE_ACTION, "audit_log", "corrupt-profile", "{not json");
    const rows = readPipelineCompletionRows(db, "corrupt-profile");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.completedSteps).toEqual([]);
    expect(rows[0]!.finalState).toBeNull();
  });
});

describe("readProfileMessageBodies + countRealOutboundMessages", () => {
  const P = "msg-profile";
  beforeAll(() => {
    insertMessage("m-in", P, { direction: "inbound", body: "Here is your quote, OTD $35,500.", gmailMessageId: "real-inbound-123" });
    insertMessage("m-out-fake", P, { direction: "outbound", body: "Thanks, looking forward to it.", gmailMessageId: "sandbox-out-abc" });
    insertMessage("m-blank", P, { direction: "outbound", body: null, gmailMessageId: null });
  });
  it("reads non-empty bodies only", () => {
    const bodies = readProfileMessageBodies(db, P);
    expect(bodies).toHaveLength(2);
    expect(bodies.some((b) => b.includes("OTD $35,500"))).toBe(true);
  });
  it("counts ZERO real outbound when the only outbound is sandbox-shaped (fuse-blocked)", () => {
    expect(countRealOutboundMessages(db, P)).toBe(0);
  });
  it("counts a real (non-sandbox) outbound message as an escape", () => {
    insertMessage("m-out-real", P, { direction: "outbound", body: "escaped", gmailMessageId: "real-gmail-xyz" });
    expect(countRealOutboundMessages(db, P)).toBe(1);
  });
});

// ===========================================================================
// INV-1 — lastRunId coherence + monotonic + survives-restart
// ===========================================================================

describe("assertLastRunIdCoherent (INV-1)", () => {
  it("clean when each launch's last_run_id == the runId and advances monotonically", () => {
    const r = assertLastRunIdCoherent([
      { runId: "r1", lastRunIdAfter: "r1" },
      { runId: "r2", lastRunIdAfter: "r2" },
      { runId: "r3", lastRunIdAfter: "r3" },
    ]);
    expect(r.assertionId).toBe("inv_last_run_id_coherent");
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("red");
  });
  it("FAILS when a launch's last_run_id did not track its runId", () => {
    const r = assertLastRunIdCoherent([
      { runId: "r1", lastRunIdAfter: "r1" },
      { runId: "r2", lastRunIdAfter: "r1" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/lastRunId/);
  });
  it("FAILS when two consecutive launches carry the same last_run_id (no advance)", () => {
    // Both reads say "r1" — recordRun stalled; runId tracked but not monotonic.
    const r = assertLastRunIdCoherent([
      { runId: "r1", lastRunIdAfter: "r1" },
      { runId: "r1", lastRunIdAfter: "r1" },
    ]);
    expect(r.ok).toBe(false);
  });
  it("FAILS on zero launches (a vacuous-pass guard)", () => {
    expect(assertLastRunIdCoherent([]).ok).toBe(false);
  });
});

describe("assertLastRunIdSurvivesRestart (INV-1 durable bridge)", () => {
  it("clean when last_run_id is identical before/after the restart", () => {
    const r = assertLastRunIdSurvivesRestart({ beforeRestart: "r5", afterRestart: "r5" });
    expect(r.ok).toBe(true);
  });
  it("FAILS when last_run_id changed across the restart", () => {
    expect(assertLastRunIdSurvivesRestart({ beforeRestart: "r5", afterRestart: "r6" }).ok).toBe(false);
  });
  it("FAILS when last_run_id was null before the restart (nothing durable)", () => {
    expect(assertLastRunIdSurvivesRestart({ beforeRestart: null, afterRestart: null }).ok).toBe(false);
  });
});

// ===========================================================================
// INV-1b — the FIXED freeform-while-suspended (no-fork) shape (BLOCKER)
// ===========================================================================

describe("assertFreeformWhileSuspendedFixed (INV-1b — the FIXED behavior, commit 8863d11)", () => {
  it("clean: rail disabled, no fork, run still suspended, last_run_id unchanged", () => {
    const r = assertFreeformWhileSuspendedFixed({
      railDisabledAtInjection: true,
      runCountBeforeInjection: 3,
      runCountAfterInjection: 3,
      suspendedRunStatus: "suspended",
      lastRunIdAfterInjection: "susp-run",
      suspendedRunId: "susp-run",
    });
    expect(r.assertionId).toBe("inv_freeform_while_suspended_fixed");
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("blocker");
  });
  it("accepts awaiting_approval as the suspended status", () => {
    const r = assertFreeformWhileSuspendedFixed({
      railDisabledAtInjection: true,
      runCountBeforeInjection: 2,
      runCountAfterInjection: 2,
      suspendedRunStatus: "awaiting_approval",
      lastRunIdAfterInjection: "susp",
      suspendedRunId: "susp",
    });
    expect(r.ok).toBe(true);
  });
  it("FAILS (blocker) if a rogue run forked (count grew)", () => {
    const r = assertFreeformWhileSuspendedFixed({
      railDisabledAtInjection: false,
      runCountBeforeInjection: 3,
      runCountAfterInjection: 4,
      suspendedRunStatus: "suspended",
      lastRunIdAfterInjection: "rogue-intake",
      suspendedRunId: "susp-run",
    });
    expect(r.ok).toBe(false);
    expect(r.severity).toBe("blocker");
    expect(r.detail).toMatch(/rogue|coherence/);
  });
  it("FAILS if last_run_id no longer points at the suspended run (the break)", () => {
    const r = assertFreeformWhileSuspendedFixed({
      railDisabledAtInjection: true,
      runCountBeforeInjection: 3,
      runCountAfterInjection: 3,
      suspendedRunStatus: "suspended",
      lastRunIdAfterInjection: "something-else",
      suspendedRunId: "susp-run",
    });
    expect(r.ok).toBe(false);
  });
});

// ===========================================================================
// INV-2 — pinnedProfileId stability + forked-session-unpinned
// ===========================================================================

describe("assertPinnedProfileStable (INV-2)", () => {
  it("clean when every boundary read + every launch scope == the pinned id", () => {
    const r = assertPinnedProfileStable({
      pinnedProfileId: "p-tucson",
      pinReads: ["p-tucson", "p-tucson", "p-tucson"],
      launchScopedProfileIds: ["p-tucson", "p-tucson"],
    });
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("red");
  });
  it("FAILS when the pin drifted at a boundary", () => {
    const r = assertPinnedProfileStable({
      pinnedProfileId: "p-tucson",
      pinReads: ["p-tucson", "p-other"],
      launchScopedProfileIds: ["p-tucson"],
    });
    expect(r.ok).toBe(false);
  });
  it("FAILS when a launch resolved a different profile (pin-threading broke)", () => {
    const r = assertPinnedProfileStable({
      pinnedProfileId: "p-tucson",
      pinReads: ["p-tucson"],
      launchScopedProfileIds: ["p-tucson", "p-wrong"],
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/pin-threading|drifted/);
  });
});

describe("assertForkedSessionUnpinned (INV-2 fork rule)", () => {
  it("clean (vacuous) when no fork happened", () => {
    expect(assertForkedSessionUnpinned({ forkHappened: false, forkedSessionPin: "p-x" }).ok).toBe(true);
  });
  it("clean when the forked session is unpinned (null)", () => {
    expect(assertForkedSessionUnpinned({ forkHappened: true, forkedSessionPin: null }).ok).toBe(true);
  });
  it("FAILS when an intake fork inherited a pin", () => {
    expect(assertForkedSessionUnpinned({ forkHappened: true, forkedSessionPin: "p-leaked" }).ok).toBe(false);
  });
});

// ===========================================================================
// INV-3 — decline = zero writes (BLOCKER)
// ===========================================================================

describe("assertDeclineZeroWrite (INV-3)", () => {
  it("clean when the scoped deltas are all zero", () => {
    const before = snapshotCounts(PROFILE, db);
    const after = snapshotCounts(PROFILE, db);
    const r = assertDeclineZeroWrite({ before, after, tables: ["dealer_quotes", "messages", "audit_log"] });
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("blocker");
  });
  it("FAILS (blocker) when a declined gate wrote a row", () => {
    const before = snapshotCounts(PROFILE, db);
    const after = snapshotCounts(PROFILE, db);
    const grown = { ...after, profile: { ...after.profile, dealer_quotes: (after.profile["dealer_quotes"] ?? 0) + 1 } };
    const r = assertDeclineZeroWrite({ before, after: grown, tables: ["dealer_quotes"] });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/zero-write/);
  });
  it("supports the batch_review decline (inventory_listings / threads, global scope)", () => {
    const before = snapshotCounts(null, db);
    const after = snapshotCounts(null, db);
    const r = assertDeclineZeroWrite({ before, after, tables: ["inventory_listings", "threads"], scope: "global" });
    expect(r.ok).toBe(true);
  });
});

// ===========================================================================
// INV-4 — single completion row + idempotent re-run
// ===========================================================================

describe("assertSingleCompletionRow (INV-4)", () => {
  const completion = (steps: string[]): PipelineCompletionRow => ({
    auditId: "a",
    searchProfileId: PROFILE,
    pipelineRunId: "r",
    completedSteps: steps,
    finalState: "complete",
    nextAction: "x",
  });
  it("clean on exactly one completion row", () => {
    const r = assertSingleCompletionRow({ completionRows: [completion(["extract"])] });
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("red");
  });
  it("FAILS on two completion rows (completed steps re-ran)", () => {
    const r = assertSingleCompletionRow({ completionRows: [completion(["extract"]), completion(["extract"])] });
    expect(r.ok).toBe(false);
  });
  it("FAILS on zero completion rows", () => {
    expect(assertSingleCompletionRow({ completionRows: [] }).ok).toBe(false);
  });
});

describe("assertIdempotentReRun (INV-4)", () => {
  it("clean when a re-run adds zero net-new rows", () => {
    const before = snapshotCounts(PROFILE, db);
    const after = snapshotCounts(PROFILE, db);
    const r = assertIdempotentReRun({ before, after, tables: ["dealer_quotes", "quote_audits"] });
    expect(r.ok).toBe(true);
  });
  it("FAILS when a re-run grew a child-write table for an already-done step", () => {
    const before = snapshotCounts(PROFILE, db);
    const after = snapshotCounts(PROFILE, db);
    const grown = { ...after, profile: { ...after.profile, quote_audits: (after.profile["quote_audits"] ?? 0) + 1 } };
    expect(assertIdempotentReRun({ before, after: grown, tables: ["quote_audits"] }).ok).toBe(false);
  });
});

// ===========================================================================
// INV-5 — suspend payload resume contract (BLOCKER) + batch resume ⊆ targets
// ===========================================================================

describe("assertSuspendPayloadResumeContract (INV-5)", () => {
  const goodPayload = {
    kind: "approval",
    sensitive: true,
    vin: "5NMJ...",
    dealerId: "d-1",
    listingId: "l-1",
    reason: "targeted_otd_send",
  };
  it("clean when the payload shape + decision_id echo are correct", () => {
    const r = assertSuspendPayloadResumeContract({
      payload: goodPayload,
      awaitingDecisionId: "dec-1",
      resumeDecisionId: "dec-1",
    });
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("blocker");
  });
  it("FAILS when the payload is missing reason=targeted_otd_send", () => {
    const r = assertSuspendPayloadResumeContract({
      payload: { ...goodPayload, reason: "something_else" },
      awaitingDecisionId: "dec-1",
      resumeDecisionId: "dec-1",
    });
    expect(r.ok).toBe(false);
  });
  it("FAILS when the resume decision_id does not echo the awaiting one", () => {
    const r = assertSuspendPayloadResumeContract({
      payload: goodPayload,
      awaitingDecisionId: "dec-1",
      resumeDecisionId: "dec-2",
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/decision_id/);
  });
  it("FAILS on a null payload", () => {
    expect(
      assertSuspendPayloadResumeContract({ payload: null, awaitingDecisionId: "d", resumeDecisionId: "d" }).ok,
    ).toBe(false);
  });
});

describe("assertBatchResumeSubsetOfTargets (INV-5)", () => {
  it("clean when approved ids ⊆ targets", () => {
    const r = assertBatchResumeSubsetOfTargets({
      approvedDealerIds: ["d-1", "d-2"],
      targetDealerIds: ["d-1", "d-2", "d-3"],
    });
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("red");
  });
  it("FAILS when an approved id is outside the targets", () => {
    const r = assertBatchResumeSubsetOfTargets({
      approvedDealerIds: ["d-1", "d-99"],
      targetDealerIds: ["d-1", "d-2"],
    });
    expect(r.ok).toBe(false);
  });
  it("scores the out-of-set probe (rejected → ok, accepted → fail)", () => {
    expect(
      assertBatchResumeSubsetOfTargets({ approvedDealerIds: ["d-1"], targetDealerIds: ["d-1"], outOfSetRejected: true }).ok,
    ).toBe(true);
    expect(
      assertBatchResumeSubsetOfTargets({ approvedDealerIds: ["d-1"], targetDealerIds: ["d-1"], outOfSetRejected: false }).ok,
    ).toBe(false);
  });
});

// ===========================================================================
// INV-6 — idempotent form-decision (200 / 409 / 410)
// ===========================================================================

describe("assertIdempotentFormDecision (INV-6)", () => {
  it("clean on the 200/409/410 triple", () => {
    const r = assertIdempotentFormDecision({
      replaySameBodyStatus: 200,
      conflictDifferentBodyStatus: 409,
      terminalStatus: 410,
    });
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("red");
  });
  it("FAILS when the same body did NOT replay 200 (a second Mastra resume)", () => {
    expect(
      assertIdempotentFormDecision({ replaySameBodyStatus: 201, conflictDifferentBodyStatus: 409, terminalStatus: 410 }).ok,
    ).toBe(false);
  });
  it("FAILS when a different body did NOT conflict 409", () => {
    expect(
      assertIdempotentFormDecision({ replaySameBodyStatus: 200, conflictDifferentBodyStatus: 200, terminalStatus: 410 }).ok,
    ).toBe(false);
  });
});

// ===========================================================================
// INV-7 — restart re-attach
// ===========================================================================

describe("assertRestartReattach (INV-7)", () => {
  it("clean when the SAME run reattaches with a FRESH decision_id and resumes to terminal", () => {
    const r = assertRestartReattach({
      runIdBeforeRestart: "run-x",
      runIdAfterRestart: "run-x",
      decisionIdBeforeRestart: "dec-old",
      decisionIdAfterRestart: "dec-new",
      resumedTerminalStatus: "done",
    });
    expect(r.ok).toBe(true);
  });
  it("FAILS when a NEW run id appeared (not a snapshot reattach)", () => {
    expect(
      assertRestartReattach({
        runIdBeforeRestart: "run-x",
        runIdAfterRestart: "run-y",
        decisionIdBeforeRestart: "a",
        decisionIdAfterRestart: "b",
        resumedTerminalStatus: "done",
      }).ok,
    ).toBe(false);
  });
  it("FAILS when the decision_id was NOT refreshed", () => {
    expect(
      assertRestartReattach({
        runIdBeforeRestart: "run-x",
        runIdAfterRestart: "run-x",
        decisionIdBeforeRestart: "same",
        decisionIdAfterRestart: "same",
        resumedTerminalStatus: "done",
      }).ok,
    ).toBe(false);
  });
  it("FAILS when the resumed run never reached terminal", () => {
    expect(
      assertRestartReattach({
        runIdBeforeRestart: "run-x",
        runIdAfterRestart: "run-x",
        decisionIdBeforeRestart: "a",
        decisionIdAfterRestart: "b",
        resumedTerminalStatus: "running",
      }).ok,
    ).toBe(false);
  });
});

// ===========================================================================
// INV-projection
// ===========================================================================

describe("assertProjectionMatchesSnapshot (INV-projection)", () => {
  it("clean when every projection matches the snapshot truth", () => {
    const r = assertProjectionMatchesSnapshot([
      { snapshot: "suspended", projected: "awaiting_approval" },
      { snapshot: "success", projected: "done" },
      { snapshot: "success_declined", projected: "declined" },
      { snapshot: "canceled", projected: "declined" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("red");
  });
  it("FAILS when a suspended run did NOT project to awaiting_approval", () => {
    const r = assertProjectionMatchesSnapshot([{ snapshot: "suspended", projected: "running" }]);
    expect(r.ok).toBe(false);
  });
  it("FAILS on zero boundaries (vacuous guard)", () => {
    expect(assertProjectionMatchesSnapshot([]).ok).toBe(false);
  });
});

// ===========================================================================
// INV-scrape-reap
// ===========================================================================

describe("assertScrapeChildReaped (INV-scrape-reap)", () => {
  const partialCompletion: PipelineCompletionRow = {
    auditId: "a",
    searchProfileId: PROFILE,
    pipelineRunId: "r",
    completedSteps: ["extract", "audit", "compare"], // scrape EXCLUDED
    finalState: "partial",
    nextAction: "run /incentive_scrape to resolve the OEM source",
  };
  it("clean when child canceled + scrape excluded + partial + next_action → /incentive_scrape", () => {
    const r = assertScrapeChildReaped({ childRunStatus: "canceled", completion: partialCompletion });
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("red");
  });
  it("FAILS when the child was left suspended (floated across the boundary)", () => {
    const r = assertScrapeChildReaped({ childRunStatus: "suspended", completion: partialCompletion });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/floated|cancel-reap/);
  });
  it("FAILS when scrape was (wrongly) marked completed", () => {
    const r = assertScrapeChildReaped({
      childRunStatus: "canceled",
      completion: { ...partialCompletion, completedSteps: ["extract", "scrape"] },
    });
    expect(r.ok).toBe(false);
  });
  it("FAILS when final_state is not 'partial'", () => {
    const r = assertScrapeChildReaped({
      childRunStatus: "canceled",
      completion: { ...partialCompletion, finalState: "complete" },
    });
    expect(r.ok).toBe(false);
  });
});

// ===========================================================================
// INV-no-external-mutation (journey-wide, keystone) + INV-budget-redaction
// ===========================================================================

describe("assertJourneyNoExternalMutation (keystone)", () => {
  it("clean when the external-mutation scan delta is zero vs baseline", () => {
    const baseline = externalMutationDbCount(db).total;
    const r = assertJourneyNoExternalMutation({ db, baseline });
    expect(r.assertionId).toBe("inv_journey_no_external_mutation");
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("blocker");
  });
  it("FAILS (blocker) when a submitted lead lands past the baseline", () => {
    const r = assertJourneyNoExternalMutation({ db, baseline: -1 });
    // A negative baseline forces a positive delta IF any send/submit rows exist;
    // with a clean DB the scan total is 0, so delta = max(0, 0 - (-1)) = 1.
    expect(r.ok).toBe(false);
    expect(r.severity).toBe("blocker");
  });
});

describe("assertBudgetRedacted (INV-budget-redaction)", () => {
  it("clean when the budget number appears in no body", () => {
    const r = assertBudgetRedacted({ budgetMax: 34000, bodies: ["Here is your OTD quote.", "Selling price $33,500."] });
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("blocker");
  });
  it("FAILS (blocker) when the budget number leaked into a body", () => {
    const r = assertBudgetRedacted({ budgetMax: 34000, bodies: ["My budget is 34000 by the way."] });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/budget/);
  });
});

// ===========================================================================
// NL routing-accuracy
// ===========================================================================

describe("assertRoutingAccuracy (NL mode)", () => {
  it("clean when every NL turn routed to the expected skill", () => {
    const r = assertRoutingAccuracy([
      { nlText: "find dealers near me", expectedSkillId: "dealer_geosearch", routedSkillId: "dealer_geosearch" },
      { nlText: "scan their inventory", expectedSkillId: "inventory_site_scan", routedSkillId: "inventory_site_scan" },
    ]);
    expect(r.ok).toBe(true);
    expect(r.severity).toBe("red");
  });
  it("clean (vacuous) on an empty list (slash mode — router not exercised)", () => {
    expect(assertRoutingAccuracy([]).ok).toBe(true);
  });
  it("FAILS when an NL turn mis-routed", () => {
    const r = assertRoutingAccuracy([
      { nlText: "find dealers near me", expectedSkillId: "dealer_geosearch", routedSkillId: "incentive_scrape" },
    ]);
    expect(r.ok).toBe(false);
  });
  it("FAILS when an NL turn clarified (routedSkillId null) on a turn that needed to advance", () => {
    const r = assertRoutingAccuracy([
      { nlText: "do the thing", expectedSkillId: "quote_pipeline", routedSkillId: null },
    ]);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/mis-routed|clarif/);
  });
});

// ===========================================================================
// combineSoakVerdict folding (the hybrid verdict over the plan-3 ids)
// ===========================================================================

describe("combineSoakVerdict folds the plan-3 severities", () => {
  it("a journey-keystone / blocker failure → BLOCKER", () => {
    const det: DeterministicResult[] = [
      { assertionId: "inv_last_run_id_coherent", ok: true, expected: 0, observed: 0, severity: "red" },
      { assertionId: "inv_journey_no_external_mutation", ok: false, expected: 0, observed: 1, severity: "blocker" },
    ];
    const v = combineSoakVerdict({ deterministic: det });
    expect(v.verdict).toBe("BLOCKER");
    expect(v.defect?.kind).toBe("inv_journey_no_external_mutation");
  });
  it("a session-consistency invariant failure (red) → RED", () => {
    const det: DeterministicResult[] = [
      { assertionId: "inv_last_run_id_coherent", ok: false, expected: "monotonic", observed: "stalled", severity: "red" },
    ];
    expect(combineSoakVerdict({ deterministic: det }).verdict).toBe("RED");
  });
  it("all clean → GREEN", () => {
    const det: DeterministicResult[] = [
      { assertionId: "inv_pinned_profile_stable", ok: true, expected: "stable", observed: "stable", severity: "red" },
      { assertionId: "nl_routing_accuracy", ok: true, expected: "all", observed: "all", severity: "red" },
    ];
    expect(combineSoakVerdict({ deterministic: det }).verdict).toBe("GREEN");
  });
});
