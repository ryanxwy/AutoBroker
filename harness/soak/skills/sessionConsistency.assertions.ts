/**
 * sessionConsistency.assertions — the plan-3 full-journey session-consistency
 * deterministic assertion lib (INV-1..INV-7 + projection + scrape-reap +
 * journey-wide no_external_mutation + budget redaction + NL routing-accuracy).
 *
 * A PER-SKILL soak module that IMPORTS plan-0's FROZEN shared infra (the verdict
 * contract + combineSoakVerdict, the ledger, the dbReads read channel) and NEVER
 * edits a shared file. The OPEN VERDICT CONTRACT is honored: every assertion below
 * returns a DeterministicResult with its OWN per-skill `assertionId` string + an
 * explicit `severity` ("blocker" for a safety red-line that folds to BLOCKER like
 * the keystone, "red" for a session-consistency / correctness invariant) — folded
 * via the frozen combineSoakVerdict. verdict.ts / orchestrator.ts / taxonomy.ts /
 * ledger.ts / freezeToCorpus.ts / claudeAgent.ts are NOT touched.
 *
 * The SUT is READ-ONLY here: this module only OBSERVES the journey state captured
 * off the live surfaces — `GET /api/sessions/:id` (last_run_id, pinned_profile_id),
 * the `POST /api/route` routing decision (routing.skill_id), `GET /api/skill-runs/:id`
 * (the product status projection), the audit_log completion row (payload_json),
 * and the dbReads snapshot deltas. It never modifies App.tsx / quotePipeline.ts /
 * skillRuns.ts.
 *
 * Two halves (mirrors skills/intake.ts + skills/dealerReplyExtract.ts):
 *  (1) the PURE assertion lib (unit-tested over a real isolated migrated tmp DB):
 *      INV-1 lastRunId coherence, INV-1b break (the FIXED no-fork shape), INV-2
 *      pinnedProfileId stability, INV-3 decline zero-write, INV-4 completed-steps
 *      idempotency, INV-5 suspend-payload resume contract, INV-6 idempotent
 *      form-decision, INV-7 restart reattach, INV-projection, INV-scrape-reap,
 *      INV-no-external-mutation (journey-wide), INV-budget-redaction, plus the NL
 *      routing-accuracy assertion. Each takes already-READ inputs and returns a
 *      typed DeterministicResult with evidence.
 *  (2) the read-only DB column reads the assertions consume (the audit_log
 *      completion-row read, the dealer_quotes / messages scoped reads) — through
 *      the same permitted @autobroker/db Db handle dbReads / the resolver use.
 *
 * Dependency wall: harness layer. Imports @autobroker/db (the Db TYPE + the
 * read channel) like dbReads/verdict — never a framework, never a provider client,
 * never playwright, never better-sqlite3/drizzle directly.
 */

import type { Db } from "@autobroker/db";

import { externalMutationDbCount, type TableCounts } from "../../dbReads.js";
import type { DeterministicResult } from "../verdict.js";

// ===========================================================================
// read-only DB reads (the column/row channel dbReads' COUNT API doesn't cover)
//
// The journey assertions need the audit_log completion ROW (its payload_json:
// completed_steps / final_state / next_action) and the scoped dealer_quotes /
// messages bodies — not just counts. We read them through the same permitted
// @autobroker/db Db handle dbReads + the resolver use, via guarded SELECTs on
// db.$client.prepare().get/all(); never a write, never a raw driver import.
// ===========================================================================

/** The pipeline completion action — mirrors tools/pipeline/auditLogWriter
 *  PIPELINE_COMPLETE_ACTION (the queryable discriminator). Re-declared here (not
 *  imported across the layer wall) so the harness stays out of the tools layer. */
export const PIPELINE_COMPLETE_ACTION = "quote_pipeline.complete";

/** One parsed quote_pipeline.complete audit row (the payload_json fields the
 *  journey invariants read). */
export interface PipelineCompletionRow {
  auditId: string;
  searchProfileId: string | null;
  pipelineRunId: string | null;
  completedSteps: string[];
  finalState: string | null;
  nextAction: string | null;
}

/**
 * Read every quote_pipeline.complete audit_log row for a profile, parsing the
 * structured body out of payload_json. Ordered stably by audit_id. READ-ONLY.
 * A row whose payload_json is unparseable is surfaced (completedSteps=[], the
 * other fields null) rather than dropped — a corrupt completion row must not
 * silently vanish from the count.
 */
export function readPipelineCompletionRows(
  db: Db,
  searchProfileId: string,
): PipelineCompletionRow[] {
  const rows = db.$client
    .prepare(
      "SELECT audit_id, search_profile_id, payload_json FROM audit_log " +
        "WHERE action = ? AND search_profile_id = ? ORDER BY audit_id",
    )
    .all(PIPELINE_COMPLETE_ACTION, searchProfileId) as Array<{
    audit_id: string;
    search_profile_id: string | null;
    payload_json: string | null;
  }>;
  return rows.map((r) => {
    let pipelineRunId: string | null = null;
    let completedSteps: string[] = [];
    let finalState: string | null = null;
    let nextAction: string | null = null;
    if (typeof r.payload_json === "string") {
      try {
        const body = JSON.parse(r.payload_json) as Record<string, unknown>;
        pipelineRunId = typeof body["pipeline_run_id"] === "string" ? body["pipeline_run_id"] : null;
        completedSteps = Array.isArray(body["completed_steps"])
          ? (body["completed_steps"] as unknown[]).filter((s): s is string => typeof s === "string")
          : [];
        finalState = typeof body["final_state"] === "string" ? body["final_state"] : null;
        nextAction = typeof body["next_action"] === "string" ? body["next_action"] : null;
      } catch {
        // Unparseable completion body — surface the row with empty steps.
      }
    }
    return {
      auditId: r.audit_id,
      searchProfileId: r.search_profile_id,
      pipelineRunId,
      completedSteps,
      finalState,
      nextAction,
    };
  });
}

/** The body text of every messages row scoped to a profile (the budget-redaction
 *  scan reads these). READ-ONLY. */
export function readProfileMessageBodies(db: Db, searchProfileId: string): string[] {
  const rows = db.$client
    .prepare("SELECT body_text FROM messages WHERE search_profile_id = ?")
    .all(searchProfileId) as Array<{ body_text: string | null }>;
  return rows
    .map((r) => r.body_text)
    .filter((b): b is string => typeof b === "string" && b.length > 0);
}

/** Count outbound messages rows carrying a REAL (non-sandbox) gmail_message_id —
 *  the journey-wide real-send escape signal scoped to a profile. READ-ONLY. */
export function countRealOutboundMessages(db: Db, searchProfileId: string): number {
  const row = db.$client
    .prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE search_profile_id = ? AND direction = 'outbound' " +
        "AND gmail_message_id IS NOT NULL AND gmail_message_id NOT LIKE 'sandbox-out-%'",
    )
    .get(searchProfileId) as { n: number } | undefined;
  return row?.n ?? 0;
}

// ===========================================================================
// INV-1 / INV-1b — lastRunId coherence (happy) + the FIXED no-fork shape (hazard)
// ===========================================================================

/** One launch observation the journey records: the runId it started + the
 *  session's last_run_id read back from GET /api/sessions/:id right after. */
export interface LaunchObservation {
  /** The runId this launch started (off /api/route routing or /runs/:id route). */
  runId: string;
  /** The session's last_run_id read back AFTER this launch (the recordRun write). */
  lastRunIdAfter: string | null;
}

/**
 * INV-1 lastRunId coherence (RED): after EACH of the N journey launches the
 * session's last_run_id equals the runId just started, AND the value advances
 * MONOTONICALLY (each launch's lastRunId differs from the previous launch's —
 * a newer launch overwrote it). A repeated lastRunId across two distinct launches
 * means recordRun did not advance (the durable bridge stalled).
 */
export function assertLastRunIdCoherent(observations: readonly LaunchObservation[]): DeterministicResult {
  const mismatches: string[] = [];
  for (const obs of observations) {
    if (obs.lastRunIdAfter !== obs.runId) {
      mismatches.push(`launch ${obs.runId} → last_run_id=${obs.lastRunIdAfter ?? "∅"}`);
    }
  }
  // Monotonic: consecutive launches must carry DISTINCT lastRunId values.
  let monotonic = true;
  for (let i = 1; i < observations.length; i += 1) {
    if (observations[i]!.lastRunIdAfter === observations[i - 1]!.lastRunIdAfter) {
      monotonic = false;
      break;
    }
  }
  const ok = mismatches.length === 0 && monotonic && observations.length > 0;
  return {
    assertionId: "inv_last_run_id_coherent",
    ok,
    expected: "after each launch last_run_id == the runId started, advancing monotonically",
    observed:
      mismatches.length > 0
        ? `mismatches: ${mismatches.join("; ")}`
        : observations.length === 0
          ? "no launches observed"
          : `monotonic=${monotonic} over ${observations.length} launches`,
    severity: "red",
    ...(ok ? {} : { detail: "lastRunId did not track each launch monotonically (railMemory recordLastRun)" }),
  };
}

/**
 * INV-1 SURVIVES RESTART (RED): the session's last_run_id read AFTER a server
 * restart equals the value read BEFORE the restart (the durable thread-metadata
 * bridge survived the process boundary). The caller captures both reads around
 * the plan-0 restart hook.
 */
export function assertLastRunIdSurvivesRestart(args: {
  beforeRestart: string | null;
  afterRestart: string | null;
}): DeterministicResult {
  const ok = args.beforeRestart !== null && args.beforeRestart === args.afterRestart;
  return {
    assertionId: "inv_last_run_id_survives_restart",
    ok,
    expected: "last_run_id identical before/after the server restart (durable bridge)",
    observed: `before=${args.beforeRestart ?? "∅"} after=${args.afterRestart ?? "∅"}`,
    severity: "red",
    ...(ok ? {} : { detail: "lastRunId did not survive the restart (the thread-metadata bridge broke)" }),
  };
}

/**
 * INV-1b FREEFORM-WHILE-SUSPENDED IS FIXED (BLOCKER): the FIXED behavior per
 * commit 8863d11 — the chat rail is DISABLED while a gate is pending
 * (ChatRail.tsx `disabled={activeAwaiting !== null}`), so a freeform typed into the
 * suspended rail forks NO rogue intake run. The assertion proves:
 *   - the rail input was DISABLED at the injection moment (the component guard);
 *   - NO new run started from the injection (the runId count did not grow);
 *   - the suspended run STAYED suspended (still answerable);
 *   - the session's last_run_id STILL points at the suspended run (NOT overwritten
 *     by a rogue intake).
 * This is the session-consistency keystone for plan-3 → severity:"blocker" (the
 * lastRunId-break, were it to happen, is the safety red-line the spec flags).
 */
export function assertFreeformWhileSuspendedFixed(args: {
  /** The rail input's disabled state at the injection moment (the DOM guard). */
  railDisabledAtInjection: boolean;
  /** The runId count BEFORE the injected freeform (the journey's run set size). */
  runCountBeforeInjection: number;
  /** The runId count AFTER the injected freeform (must NOT have grown — no fork). */
  runCountAfterInjection: number;
  /** The suspended run's status read back (must still be 'suspended'/awaiting). */
  suspendedRunStatus: string | null;
  /** The session's last_run_id AFTER the injection. */
  lastRunIdAfterInjection: string | null;
  /** The suspended run's id (last_run_id must STILL equal this — not a rogue). */
  suspendedRunId: string;
}): DeterministicResult {
  const noFork = args.runCountAfterInjection === args.runCountBeforeInjection;
  const stillSuspended =
    args.suspendedRunStatus === "suspended" || args.suspendedRunStatus === "awaiting_approval";
  const lastRunStillPointsAtSuspended = args.lastRunIdAfterInjection === args.suspendedRunId;
  const ok =
    args.railDisabledAtInjection && noFork && stillSuspended && lastRunStillPointsAtSuspended;
  return {
    assertionId: "inv_freeform_while_suspended_fixed",
    ok,
    expected:
      "rail DISABLED while suspended → NO rogue fork, run stays suspended, last_run_id unchanged (commit 8863d11)",
    observed: `railDisabled=${args.railDisabledAtInjection} noFork=${noFork} status=${args.suspendedRunStatus ?? "∅"} lastRunId=${args.lastRunIdAfterInjection ?? "∅"} (want ${args.suspendedRunId})`,
    severity: "blocker",
    ...(ok
      ? {}
      : {
          detail:
            "freeform-while-suspended forked a rogue run or broke lastRunId coherence — the session-consistency hazard (App.tsx onFreeform / ChatRail.tsx disabled wiring)",
        }),
  };
}

// ===========================================================================
// INV-2 — pinnedProfileId stability across the whole journey
// ===========================================================================

/**
 * INV-2 pinnedProfileId STABLE (RED): the session's pinned_profile_id read at
 * every step boundary equals the id set via pinProfileInSearches, AND every
 * NON-intake launch's effective search_profile_id equals that pinned id (the
 * App.tsx pin-threading 300-303). `pinReads` are the per-boundary reads; the
 * `launchScopedProfileIds` are each non-intake launch's resolved scope (read off
 * audit_log / dealer_quotes search_profile_id or the workflow input).
 */
export function assertPinnedProfileStable(args: {
  pinnedProfileId: string;
  pinReads: readonly (string | null)[];
  launchScopedProfileIds: readonly string[];
}): DeterministicResult {
  const driftedReads = args.pinReads.filter((p) => p !== args.pinnedProfileId);
  const wrongScope = args.launchScopedProfileIds.filter((p) => p !== args.pinnedProfileId);
  const ok = driftedReads.length === 0 && wrongScope.length === 0;
  return {
    assertionId: "inv_pinned_profile_stable",
    ok,
    expected: `pinned_profile_id == ${args.pinnedProfileId} at every boundary + every non-intake launch scoped to it`,
    observed: `driftedReads=${driftedReads.length} wrongScope=${JSON.stringify(wrongScope)}`,
    severity: "red",
    ...(ok ? {} : { detail: "the pin drifted across the journey or a launch resolved a different profile (#6 / App pin-threading)" }),
  };
}

/**
 * INV-2 forked-rogue session UNPINNED (RED): an intake fork starts an UNPINNED
 * session (pinnedProfileId null) per the fork rule. When the journey provokes an
 * intake fork (e.g. a deliberate /intake mid-journey), the forked session's
 * pinned_profile_id must be null. `forkedSessionPin` is null when no fork happened
 * (the assertion vacuously passes — there was nothing to be unpinned).
 */
export function assertForkedSessionUnpinned(args: {
  forkHappened: boolean;
  forkedSessionPin: string | null;
}): DeterministicResult {
  const ok = !args.forkHappened || args.forkedSessionPin === null;
  return {
    assertionId: "inv_forked_session_unpinned",
    ok,
    expected: "an intake-forked session is UNPINNED (pinned_profile_id null)",
    observed: `forkHappened=${args.forkHappened} forkedPin=${args.forkedSessionPin ?? "∅"}`,
    severity: "red",
    ...(ok ? {} : { detail: "an intake fork inherited a pin (the fresh-unpinned fork rule was violated)" }),
  };
}

// ===========================================================================
// INV-3 — decline = zero writes (targeted SEND decline + batch_review decline)
// ===========================================================================

/**
 * INV-3 DECLINE ZERO-WRITE (BLOCKER): on a declined gate the scoped table deltas
 * (after − before) are 0 for every named table. The targeted-VIN decline asserts
 * dealer_quotes / messages / audit_log Δ=0; a batch_review decline asserts
 * inventory_listings / threads Δ=0. A declined gate that wrote ANY row violates
 * "no confirmation → zero write" → severity:"blocker".
 */
export function assertDeclineZeroWrite(args: {
  before: TableCounts;
  after: TableCounts;
  tables: readonly string[];
  scope?: "profile" | "global";
}): DeterministicResult {
  const scope = args.scope ?? "profile";
  const beforeCounts = scope === "profile" ? args.before.profile : args.before.global;
  const afterCounts = scope === "profile" ? args.after.profile : args.after.global;
  const deltas: Record<string, number> = {};
  let allZero = true;
  for (const t of args.tables) {
    const d = (afterCounts[t] ?? 0) - (beforeCounts[t] ?? 0);
    deltas[t] = d;
    if (d !== 0) allZero = false;
  }
  return {
    assertionId: "inv_decline_zero_write",
    ok: allZero,
    expected: `Δ=0 for ${args.tables.join(", ")} (${scope}) on a declined gate`,
    observed: deltas,
    severity: "blocker",
    ...(allZero ? {} : { detail: "a declined gate wrote rows — zero-write-on-decline violated (#3/#10 — no confirmation → zero write)" }),
  };
}

// ===========================================================================
// INV-4 — completed steps do not re-run (exactly one completion row; idempotent)
// ===========================================================================

/**
 * INV-4 EXACTLY ONE COMPLETION ROW (RED): a quote_pipeline run (including a
 * restart-reattach resume from snapshot) lands EXACTLY ONE audit_log
 * quote_pipeline.complete row for the profile — never two from a double-execution
 * of completed steps. `completionRows` is read via readPipelineCompletionRows.
 */
export function assertSingleCompletionRow(args: {
  completionRows: readonly PipelineCompletionRow[];
  expected?: number;
}): DeterministicResult {
  const expected = args.expected ?? 1;
  const ok = args.completionRows.length === expected;
  return {
    assertionId: "inv_single_completion_row",
    ok,
    expected: `exactly ${expected} quote_pipeline.complete audit_log row(s)`,
    observed: `${args.completionRows.length} completion row(s)`,
    severity: "red",
    ...(ok ? {} : { detail: "a quote_pipeline run wrote a duplicate (or zero) completion row — completed steps re-ran (writePipelineCompletion)" }),
  };
}

/**
 * INV-4 IDEMPOTENT RE-RUN (RED): re-running /quote_pipeline (no target) over an
 * already-extracted/audited DB re-derives via detectPipelineState and only runs
 * the still-applicable children — the child-write tables grow ONLY for not-yet-done
 * steps. The caller passes the before/after scoped counts for the idempotent
 * child-write tables (dealer_quotes / quote_audits): a second run over a fully-done
 * state adds 0 net-new rows.
 */
export function assertIdempotentReRun(args: {
  before: TableCounts;
  after: TableCounts;
  tables: readonly string[];
  scope?: "profile" | "global";
}): DeterministicResult {
  const scope = args.scope ?? "profile";
  const beforeCounts = scope === "profile" ? args.before.profile : args.before.global;
  const afterCounts = scope === "profile" ? args.after.profile : args.after.global;
  const deltas: Record<string, number> = {};
  let allZero = true;
  for (const t of args.tables) {
    const d = (afterCounts[t] ?? 0) - (beforeCounts[t] ?? 0);
    deltas[t] = d;
    if (d !== 0) allZero = false;
  }
  return {
    assertionId: "inv_idempotent_re_run",
    ok: allZero,
    expected: `Δ=0 for ${args.tables.join(", ")} on a re-run over already-done state (idempotent UPSERT)`,
    observed: deltas,
    severity: "red",
    ...(allZero ? {} : { detail: "a re-run grew a child-write table for an already-completed step (detectPipelineState / UPSERT idempotency)" }),
  };
}

// ===========================================================================
// INV-5 — the suspend payload IS the resume contract
// ===========================================================================

/** The targeted-VIN SEND suspend payload (the approval card's spec_inline). */
export interface ApprovalSuspendPayload {
  kind?: unknown;
  sensitive?: unknown;
  vin?: unknown;
  dealerId?: unknown;
  listingId?: unknown;
  reason?: unknown;
}

/**
 * INV-5 SUSPEND PAYLOAD IS THE RESUME CONTRACT (BLOCKER): at the targeted SEND
 * suspend the run's spec_inline carries {kind:'approval', sensitive:true, vin,
 * dealerId, listingId, reason:'targeted_otd_send'}, AND the form-decision echoes
 * the SAME decision_id the awaiting_user frame carried. A resume whose decision_id
 * does not match the pending suspend cannot resume that exact step → this is the
 * gate-integrity red-line → severity:"blocker".
 */
export function assertSuspendPayloadResumeContract(args: {
  payload: ApprovalSuspendPayload | null;
  awaitingDecisionId: string;
  resumeDecisionId: string;
}): DeterministicResult {
  const p = args.payload;
  const shapeOk =
    p !== null &&
    p.kind === "approval" &&
    p.sensitive === true &&
    typeof p.vin === "string" &&
    typeof p.dealerId === "string" &&
    typeof p.listingId === "string" &&
    p.reason === "targeted_otd_send";
  const decisionEchoed =
    args.awaitingDecisionId.length > 0 && args.awaitingDecisionId === args.resumeDecisionId;
  const ok = shapeOk && decisionEchoed;
  return {
    assertionId: "inv_suspend_payload_resume_contract",
    ok,
    expected:
      "spec_inline {kind:'approval', sensitive:true, vin, dealerId, listingId, reason:'targeted_otd_send'} + the form-decision echoes the awaiting decision_id",
    observed: `shapeOk=${shapeOk} decisionEchoed=${decisionEchoed} (awaiting=${args.awaitingDecisionId} resume=${args.resumeDecisionId})`,
    severity: "blocker",
    ...(ok ? {} : { detail: "the targeted-send suspend payload / resume decision_id did not match the resume contract (skillRuns formDecision)" }),
  };
}

/**
 * INV-5 BATCH RESUME ⊆ TARGETS (RED): for inventory_site_scan the batch_review
 * approved_dealer_ids must be a SUBSET of the suspend payload's targets[].dealer_id
 * — submitting an id NOT in targets is rejected (400 content_invalid) and the gate
 * stays answerable. The caller passes the approved ids + the target ids + whether
 * an out-of-set submit was rejected (when exercised).
 */
export function assertBatchResumeSubsetOfTargets(args: {
  approvedDealerIds: readonly string[];
  targetDealerIds: readonly string[];
  /** When the journey probed an out-of-set id, did the server reject it (400)? */
  outOfSetRejected?: boolean;
}): DeterministicResult {
  const targets = new Set(args.targetDealerIds);
  const strays = args.approvedDealerIds.filter((id) => !targets.has(id));
  const subsetOk = strays.length === 0;
  const probeOk = args.outOfSetRejected === undefined ? true : args.outOfSetRejected === true;
  const ok = subsetOk && probeOk;
  return {
    assertionId: "inv_batch_resume_subset_of_targets",
    ok,
    expected: "approved_dealer_ids ⊆ suspendPayload.targets[].dealer_id (out-of-set submit → 400 content_invalid)",
    observed: `strays=${JSON.stringify(strays)} outOfSetRejected=${args.outOfSetRejected ?? "n/a"}`,
    severity: "red",
    ...(ok ? {} : { detail: "a batch_review resume approved an id outside the suspend targets (skillRuns batchReviewResume)" }),
  };
}

// ===========================================================================
// INV-6 — idempotent form-decision (replay 200 / conflict 409 / terminal 410)
// ===========================================================================

/**
 * INV-6 IDEMPOTENT FORM-DECISION (RED): the live /api/skill-runs/:id/form-decision
 * three-phase claim — the SAME body twice → the second returns the stored ack
 * (200, NOT a second Mastra resume); a DIFFERENT body for a consumed decision_id →
 * 409 decision_conflict; a decision_id not matching run.pending on a terminal run →
 * 410 run_terminal. The caller drives the live surface and passes the observed
 * status codes.
 */
export function assertIdempotentFormDecision(args: {
  replaySameBodyStatus: number;
  conflictDifferentBodyStatus: number;
  terminalStatus: number;
}): DeterministicResult {
  const replayOk = args.replaySameBodyStatus === 200;
  const conflictOk = args.conflictDifferentBodyStatus === 409;
  const terminalOk = args.terminalStatus === 410;
  const ok = replayOk && conflictOk && terminalOk;
  return {
    assertionId: "inv_idempotent_form_decision",
    ok,
    expected: "same body → 200 replay, different body → 409 conflict, terminal run → 410",
    observed: `replay=${args.replaySameBodyStatus} conflict=${args.conflictDifferentBodyStatus} terminal=${args.terminalStatus}`,
    severity: "red",
    ...(ok ? {} : { detail: "the form-decision three-phase claim did not return the idempotent replay/conflict/terminal codes (skillRuns)" }),
  };
}

// ===========================================================================
// INV-7 — restart re-attach (fresh decision_id, resume to terminal, no re-run)
// ===========================================================================

/**
 * INV-7 RESTART RE-ATTACH (RED): after a plan-0 server restart mid-suspend,
 * SkillRunService.reattach re-attaches the SAME suspended run off mastra.db with a
 * FRESH decision_id, the resumed run reaches terminal, completed steps did NOT
 * re-execute (asserted via INV-4's single completion row), and the run id is
 * unchanged across the restart (the same snapshot, not a new run).
 */
export function assertRestartReattach(args: {
  runIdBeforeRestart: string;
  runIdAfterRestart: string;
  decisionIdBeforeRestart: string;
  decisionIdAfterRestart: string;
  resumedTerminalStatus: string | null;
}): DeterministicResult {
  const sameRun = args.runIdBeforeRestart === args.runIdAfterRestart;
  const freshDecision =
    args.decisionIdAfterRestart.length > 0 &&
    args.decisionIdAfterRestart !== args.decisionIdBeforeRestart;
  const reachedTerminal =
    args.resumedTerminalStatus === "done" ||
    args.resumedTerminalStatus === "success" ||
    args.resumedTerminalStatus === "declined";
  const ok = sameRun && freshDecision && reachedTerminal;
  return {
    assertionId: "inv_restart_reattach",
    ok,
    expected: "same run reattaches with a FRESH decision_id and resumes to terminal",
    observed: `sameRun=${sameRun} freshDecision=${freshDecision} terminal=${args.resumedTerminalStatus ?? "∅"}`,
    severity: "red",
    ...(ok ? {} : { detail: "the restart did not reattach the same run with a fresh decision_id + resume to terminal (skillRuns reattach)" }),
  };
}

// ===========================================================================
// INV-projection — the product status projection matches snapshot truth
// ===========================================================================

/**
 * INV-PROJECTION (RED): the product status from GET /api/skill-runs/:id
 * (projectStatus over the live mastra.db status) matches the snapshot truth at a
 * step boundary: suspended→awaiting_approval, success(no decline)→done,
 * success(outcome:declined)→declined, canceled(reaped child)→canceled. The caller
 * passes the snapshot status + the projected product status per boundary.
 */
export type SnapshotStatus =
  | "suspended"
  | "success"
  | "success_declined"
  | "canceled"
  | "running"
  | "failed";

/** The expected product projection for each snapshot truth (mirrors
 *  statusProjection.projectStatus). */
const EXPECTED_PROJECTION: Readonly<Record<SnapshotStatus, string>> = {
  suspended: "awaiting_approval",
  success: "done",
  success_declined: "declined",
  canceled: "declined",
  running: "running",
  failed: "error",
};

export function assertProjectionMatchesSnapshot(
  boundaries: ReadonlyArray<{ snapshot: SnapshotStatus; projected: string }>,
): DeterministicResult {
  const mismatches: string[] = [];
  for (const b of boundaries) {
    const want = EXPECTED_PROJECTION[b.snapshot];
    if (b.projected !== want) {
      mismatches.push(`${b.snapshot}→${b.projected} (want ${want})`);
    }
  }
  const ok = mismatches.length === 0 && boundaries.length > 0;
  return {
    assertionId: "inv_projection_matches_snapshot",
    ok,
    expected: "product status projection matches the mastra.db snapshot truth at every boundary",
    observed:
      mismatches.length > 0
        ? `mismatches: ${mismatches.join("; ")}`
        : boundaries.length === 0
          ? "no boundaries observed"
          : `${boundaries.length} boundaries matched`,
    severity: "red",
    ...(ok ? {} : { detail: "a product status projection diverged from the snapshot truth (statusProjection.projectStatus)" }),
  };
}

// ===========================================================================
// INV-scrape-reap — a suspended scrape child is cancel-reaped, never floated
// ===========================================================================

/**
 * INV-SCRAPE-REAP (RED): after a quote_pipeline run whose scrape child suspended,
 * the orchestrator runChildImpl cancel-reaped it: the child run (incentive_scrape-*
 * id pattern) is status='canceled' in mastra.db (NEVER left 'suspended' for
 * recoverOnBoot to resurface), the completion row's completed_steps EXCLUDES
 * 'scrape', finalState='partial', and nextAction references /incentive_scrape. The
 * caller reads the completion row + the child status off mastra.db.
 */
export function assertScrapeChildReaped(args: {
  childRunStatus: string | null;
  completion: PipelineCompletionRow | null;
}): DeterministicResult {
  const childCanceled = args.childRunStatus === "canceled";
  const completedExcludesScrape =
    args.completion !== null && !args.completion.completedSteps.includes("scrape");
  const partial = args.completion?.finalState === "partial";
  const nextActionPoints =
    typeof args.completion?.nextAction === "string" &&
    args.completion.nextAction.includes("incentive_scrape");
  const ok = childCanceled && completedExcludesScrape && partial && nextActionPoints;
  return {
    assertionId: "inv_scrape_child_reaped",
    ok,
    expected:
      "scrape child status='canceled' + completed_steps excludes 'scrape' + final_state='partial' + next_action → /incentive_scrape",
    observed: `childStatus=${args.childRunStatus ?? "∅"} excludesScrape=${completedExcludesScrape} finalState=${args.completion?.finalState ?? "∅"} nextAction=${args.completion?.nextAction ?? "∅"}`,
    severity: "red",
    ...(ok ? {} : { detail: "the orchestrator floated a child suspend across its boundary (runChildImpl cancel-reap)" }),
  };
}

// ===========================================================================
// INV-no-external-mutation (journey-wide) + INV-budget-redaction
// ===========================================================================

/**
 * INV-NO-EXTERNAL-MUTATION journey-wide (BLOCKER, keystone): across EVERY run the
 * externalMutationDbCount delta vs the journey baseline is 0 — lead_submissions
 * Δ=0, no real (non-sandbox) outbound messages row, the gated send returned blocked
 * on the one targeted approve. The targeted-approve local dealer_quotes record is a
 * LEGAL local write (not a mutation), so the scan's allowFakeOutbound flag is set
 * for the targeted-approve leg. This is the non-negotiable keystone → BLOCKER
 * (folds via the generic BLOCKER_ASSERTIONS set; we also set severity explicitly).
 */
export function assertJourneyNoExternalMutation(args: {
  db: Db;
  baseline: number;
  allowFakeOutbound?: boolean;
}): DeterministicResult {
  const scan = externalMutationDbCount(args.db, {
    ...(args.allowFakeOutbound !== undefined ? { allowFakeOutbound: args.allowFakeOutbound } : {}),
  });
  const delta = Math.max(0, scan.total - args.baseline);
  return {
    assertionId: "inv_journey_no_external_mutation",
    ok: delta === 0,
    expected: 0,
    observed: delta,
    severity: "blocker",
    ...(delta === 0
      ? {}
      : { detail: `JOURNEY KEYSTONE VIOLATION: ${JSON.stringify(scan.breakdown)} baseline=${args.baseline}` }),
  };
}

/**
 * INV-BUDGET-REDACTION (BLOCKER): the literal budget number the buyer stated is
 * ABSENT from every drafted / outbound / fake messages body for the journey
 * (buildTargetedBody + safeBodyTemplate; _redact_budget enforced in code). A pure
 * substring scan over the scoped message bodies — independent of the Opus
 * paraphrase judge. Communication-never-includes-budget is invariant #9 →
 * severity:"blocker".
 */
export function assertBudgetRedacted(args: {
  budgetMax: number;
  bodies: readonly string[];
}): DeterministicResult {
  const needle = String(args.budgetMax);
  const leaked = args.bodies.filter((b) => b.includes(needle));
  return {
    assertionId: "inv_budget_redaction",
    ok: leaked.length === 0,
    expected: `budget number "${needle}" absent from every journey message body`,
    observed: leaked.length === 0 ? "absent" : `${leaked.length} body(ies) contain "${needle}"`,
    severity: "blocker",
    ...(leaked.length === 0 ? {} : { detail: "the budget number leaked into a drafted/sent communication (#9 _redact_budget)" }),
  };
}

// ===========================================================================
// NL routing-accuracy — did each NL turn route to the EXPECTED skill?
// ===========================================================================

/** One NL turn the journey drove: the buyer's natural-language text, the skill the
 *  scenario EXPECTED the router to choose, and the skill the router actually chose
 *  (read off the POST /api/route routing.skill_id; null when the router clarified
 *  / started no run). */
export interface RoutingObservation {
  nlText: string;
  expectedSkillId: string;
  routedSkillId: string | null;
}

/**
 * NL ROUTING-ACCURACY (RED): every NL-mode turn routed to the skill the scenario
 * expected (read off the product router's routing.skill_id). A mis-route or a
 * clarify (routedSkillId null) on a turn the journey needed to advance is a
 * routing failure. In slash mode this assertion is not scored (the deterministic
 * /slash path bypasses the router) — the caller passes an empty list.
 */
export function assertRoutingAccuracy(observations: readonly RoutingObservation[]): DeterministicResult {
  const misroutes = observations.filter((o) => o.routedSkillId !== o.expectedSkillId);
  // An empty list (slash mode) is a vacuous pass — the router was not exercised.
  const ok = misroutes.length === 0;
  return {
    assertionId: "nl_routing_accuracy",
    ok,
    expected: "every NL turn routes to the scenario's expected skill (routing.skill_id)",
    observed:
      misroutes.length === 0
        ? `${observations.length} NL turn(s) routed correctly`
        : `misroutes: ${misroutes.map((m) => `"${m.nlText.slice(0, 32)}…"→${m.routedSkillId ?? "clarify"} (want ${m.expectedSkillId})`).join("; ")}`,
    severity: "red",
    ...(ok ? {} : { detail: "an NL turn mis-routed (or clarified) vs the scenario's expected skill (router.classifySkillFromText)" }),
  };
}
