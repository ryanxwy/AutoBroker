/**
 * runtimeGlue — boot recovery + duplicate-runId guard (AI_ORCH M0).
 *
 * PHASE_0 spikes 2 & 7, M0 exit "crash-and-resume 回环". Per the D4 ruling there
 * is NO engine seam: these are THIN wrappers over the real @mastra/core@1.41
 * instance/workflow API — never raw SQL into mastra.db. The glue REPORTS what
 * storage holds and ACTS only through the public run lifecycle methods.
 *
 * DETERMINISTIC TOOL RE-REGISTRATION (architecture property, not persisted
 * closures): Mastra snapshots only DATA (step results, suspend/resume payloads,
 * status) to mastra.db — it does NOT persist step `execute` closures. Workflows
 * and their steps are re-registered by MODULE IMPORT at every boot
 * (`createMastraInstance({ workflows })`), so a run suspended in process A is
 * re-attachable in a FRESH process B purely because B imported the same workflow
 * module. The spike test PROVES this by suspending in one child process and
 * resuming in a separate one. recoverOnBoot never needs the original closures —
 * it re-hydrates a `Run` handle from the registered Workflow + the stored runId.
 *
 * The two failure shapes this module handles (live-probed against
 * @mastra/core@1.41.0 — see the spike report's api_findings):
 *   - status 'suspended'  → a clean HITL pause. Re-attachable; return handles so
 *     the caller can resume({ resumeData }) through the L2 gate.
 *   - status 'running'    → a STALE row left by a process killed mid-flight (no
 *     live process is driving it). Staleness is decided by STORAGE STATE — the
 *     row says 'running' yet this fresh boot owns no such in-memory Run — NOT by
 *     a wall-clock heuristic. Recovery policy: restart() resumes from the last
 *     COMPLETED step (live-probed: a prior completed step does NOT re-execute);
 *     or cancel() flips it to 'canceled' when restart is not wanted.
 *
 * Live-probed 1.41 semantics this glue relies on:
 *   - workflow.listWorkflowRuns({ status }) filters by run status in storage.
 *   - workflow.getWorkflowRunById(runId) → WorkflowState | null (status,
 *     suspendedPaths, ...). null ⇒ no such run (the dup guard's "free to create").
 *   - workflow.createRun({ runId }) re-attaches a Run handle to an EXISTING runId
 *     (proven across a fresh process); a NEW runId creates a fresh run.
 *   - run.restart() resumes a previously-active run from snapshot; run.cancel()
 *     aborts + marks 'canceled'.
 *   - DUP-RUNID CLOBBER (#5549 residue, still REAL in 1.41, live-probed): a
 *     second createRun({ runId:X }).start() SILENTLY overwrites the prior run's
 *     stored result. startRunGuarded closes that by refusing a create+start when
 *     getWorkflowRunById already finds the id — defense-in-depth, fail-loud.
 *
 * Dependency wall: imports @mastra/* (legal only in workflows). Never opens the
 * product DB, never raw-SQLs mastra.db — only the instance/workflow/run API.
 */

import type { Mastra } from "@mastra/core";
import type {
  Workflow,
  WorkflowRunStatus,
  WorkflowState,
} from "@mastra/core/workflows";

/**
 * A suspended run that recoverOnBoot found, packaged as a re-attachable handle
 * descriptor. The caller re-hydrates the `Run` via
 * `mastra.getWorkflow(workflowId).createRun({ runId })` and resumes it through
 * the L2 gate. `suspendedStepPath` is the stored suspend path (e.g. ['stepGate'])
 * when storage recorded one — the approval UI uses it to label what is pending.
 */
export interface ReattachableSuspendedRun {
  workflowId: string;
  runId: string;
  /** Suspended step id path from storage's suspendedPaths, or undefined. */
  suspendedStepPath?: string[];
}

/** A stale 'running' row (a run killed mid-flight; no live process owns it). */
export interface StaleRunningRun {
  workflowId: string;
  runId: string;
}

/** A run in a transient in-flight status (waiting/pending/paused) that boot
 *  recovery cannot classify as cleanly suspended or stale-running. Surfaced —
 *  never silently dropped — so the caller can decide (review F-glue-1b). */
export interface UnclassifiedRun {
  workflowId: string;
  runId: string;
  status: WorkflowRunStatus;
}

/** What recoverOnBoot reports after scanning every registered workflow. */
export interface BootRecoveryReport {
  /** Suspended runs, returned as re-attachable handle descriptors. */
  suspended: ReattachableSuspendedRun[];
  /** Stale 'running' rows awaiting restartStaleRun / cancelStaleRun. */
  stale: StaleRunningRun[];
  /** waiting/pending/paused rows — in-flight shapes a kill can also leave
   *  behind. Reported for the caller's policy; this glue takes no action. */
  other: UnclassifiedRun[];
}

/**
 * runIds started by THIS process via {@link startRunGuarded} — the ownership
 * set that keeps {@link recoverOnBoot} from classifying our own live runs as
 * stale (review F-glue-1a, HIGH: without it, a re-scan after this process has
 * started runs would report every healthy 'running' row as stale and offer it
 * to restart/cancel — clobbering live work). CONTRACT: all production starts
 * go through startRunGuarded (it is also the dup-runId gate, the single entry);
 * a run started via a raw workflow.createRun().start() bypasses this set and
 * recoverOnBoot cannot tell it from a stale row.
 */
const ownedRunIds = new Set<string>();

/** Test-only: clear the process-ownership set between isolated test cases. */
export function resetRuntimeGlueForTests(): void {
  ownedRunIds.clear();
}

/** Options for {@link recoverOnBoot}. */
export interface RecoverOnBootOptions {
  /**
   * The workflow ids to scan. REQUIRED-by-architecture in practice but optional
   * here: when omitted, the caller must pass the ids it registered. We do NOT
   * reach into Mastra private internals to enumerate workflows (no documented
   * public `getWorkflows()` plural on the 1.41 instance); the boot caller owns
   * the registry map it built and passes its keys.
   */
  workflowIds: string[];
}

/**
 * Thrown by {@link startRunGuarded} when a run with the requested id already
 * exists in storage. Defense-in-depth against the #5549 clobber: rather than let
 * a second create+start silently overwrite the prior run's state, we refuse loud.
 */
export class DuplicateRunIdError extends Error {
  readonly workflowId: string;
  readonly runId: string;
  readonly existingStatus: WorkflowRunStatus;
  constructor(workflowId: string, runId: string, existingStatus: WorkflowRunStatus) {
    super(
      `duplicate runId '${runId}' for workflow '${workflowId}' (existing status: ${existingStatus}); refusing to clobber an existing run`,
    );
    this.name = "DuplicateRunIdError";
    this.workflowId = workflowId;
    this.runId = runId;
    this.existingStatus = existingStatus;
  }
}

/**
 * Pull the suspended step-id path out of a stored WorkflowState. 1.41 records
 * suspendedPaths as `{ [stepId]: number[] }` (the execution-path index, not a
 * step id). The step IDS are the keys — that is what an approval UI labels — so
 * we return the keys, or undefined when none were recorded.
 */
function suspendedStepPathOf(state: WorkflowState): string[] | undefined {
  const paths = state.suspendedPaths;
  if (paths === undefined) return undefined;
  const keys = Object.keys(paths);
  return keys.length > 0 ? keys : undefined;
}

/**
 * Scan every registered workflow's runs and classify them for boot recovery.
 *
 * For each workflow id: list 'suspended' runs (return as re-attachable handle
 * descriptors) and 'running' runs (a fresh boot owns no live Run for these, so
 * by storage-state they are STALE — surface them for restart/cancel). We act on
 * nothing here; the caller decides per its recovery policy and the L2 gate.
 */
export async function recoverOnBoot(
  mastra: Mastra,
  opts: RecoverOnBootOptions,
): Promise<BootRecoveryReport> {
  const suspended: ReattachableSuspendedRun[] = [];
  const stale: StaleRunningRun[] = [];
  const other: UnclassifiedRun[] = [];

  for (const workflowId of opts.workflowIds) {
    const workflow = mastra.getWorkflow(workflowId) as Workflow;

    const suspendedRuns = await workflow.listWorkflowRuns({ status: "suspended" });
    for (const run of suspendedRuns.runs) {
      // getWorkflowRunById gives the processed state (suspendedPaths) so the
      // approval UI can name the pending step; listWorkflowRuns alone carries a
      // raw snapshot blob.
      const state = await workflow.getWorkflowRunById(run.runId);
      const suspendedStepPath = state ? suspendedStepPathOf(state) : undefined;
      // exactOptionalPropertyTypes: only attach the key when present (never an
      // explicit `undefined`).
      suspended.push(
        suspendedStepPath === undefined
          ? { workflowId, runId: run.runId }
          : { workflowId, runId: run.runId, suspendedStepPath },
      );
    }

    const runningRuns = await workflow.listWorkflowRuns({ status: "running" });
    for (const run of runningRuns.runs) {
      // Ownership exclusion (review F-glue-1a): a 'running' row whose runId
      // THIS process started is live work, not a stale orphan — never offer it
      // to restart/cancel.
      if (ownedRunIds.has(run.runId)) continue;
      stale.push({ workflowId, runId: run.runId });
    }

    // Transient in-flight statuses a kill can also leave behind (review
    // F-glue-1b): surface, never silently drop. No action taken here.
    for (const status of ["waiting", "pending", "paused"] as const) {
      const transient = await workflow.listWorkflowRuns({ status });
      for (const run of transient.runs) {
        if (ownedRunIds.has(run.runId)) continue;
        other.push({ workflowId, runId: run.runId, status });
      }
    }
  }

  return { suspended, stale, other };
}

/**
 * Restart a stale 'running' run from its last-persisted snapshot. Live-probed
 * 1.41 semantics: restart() resumes from the last COMPLETED step (a completed
 * step does NOT re-execute); a step that was in-flight when the process died is
 * re-run from scratch. Returns the terminal status string.
 *
 * Note: if the in-flight step re-blocks (e.g. a long sleep / external wait),
 * restart() will not return until that step settles — the caller chooses
 * restartStaleRun vs cancelStaleRun knowing the step's shape.
 */
export async function restartStaleRun(
  mastra: Mastra,
  run: StaleRunningRun,
): Promise<WorkflowRunStatus> {
  const workflow = mastra.getWorkflow(run.workflowId) as Workflow;
  const handle = await workflow.createRun({ runId: run.runId });
  const result = await handle.restart({});
  return result.status;
}

/**
 * Cancel a stale 'running' run: abort any (already-dead) execution and flip the
 * stored status to 'canceled' (live-probed deterministic). Use when restart is
 * not wanted — e.g. the in-flight step would re-block, or the run must be
 * abandoned. Returns the terminal status (expected 'canceled').
 */
export async function cancelStaleRun(
  mastra: Mastra,
  run: StaleRunningRun,
): Promise<WorkflowRunStatus> {
  const workflow = mastra.getWorkflow(run.workflowId) as Workflow;
  const handle = await workflow.createRun({ runId: run.runId });
  await handle.cancel();
  const state = await workflow.getWorkflowRunById(run.runId);
  // getWorkflowRunById is the authority on the persisted terminal status.
  return state?.status ?? "canceled";
}

/** Arguments for {@link startRunGuarded}. */
export interface StartRunGuardedArgs<TInput = unknown> {
  /** The caller-chosen run id (the idempotency key). */
  runId: string;
  /** Input data passed to workflow start(). */
  inputData: TInput;
}

/**
 * Start a workflow run with a duplicate-runId guard (defense-in-depth vs the
 * #5549 clobber). If getWorkflowRunById already finds a run for `runId`, throw a
 * typed {@link DuplicateRunIdError} — never a second create+start, which 1.41
 * would let silently overwrite the prior run's stored state. Otherwise create a
 * fresh run with that id and start it, returning the {runId, result}.
 *
 * `result` is left as `unknown` at this glue boundary: the run's typed output is
 * the skill workflow's concern, not the recovery plumbing's. Callers that need
 * the typed result use the workflow's own start() directly once the guard has
 * confirmed the id is free.
 *
 * KNOWN LIMIT — TOCTOU (review F-glue-2): the existence check and the
 * create+start are two separate awaits with no lock; two CONCURRENT callers
 * racing the same runId can both see null and both start (the underlying
 * clobber is Mastra's, #5549 residue). This guard closes the SEQUENTIAL
 * re-submit only. Single-process serialization comes from the in-memory
 * ownership set + the single-Node-process topology (127.0.0.1:8100, one
 * server); a cross-process airtight guard would need a storage-level unique
 * constraint, which is Mastra's table, not ours (D1: never raw-SQL mastra.db).
 */
export async function startRunGuarded<TInput = unknown>(
  workflow: Workflow,
  args: StartRunGuardedArgs<TInput>,
): Promise<{ runId: string; result: unknown }> {
  const existing = await workflow.getWorkflowRunById(args.runId);
  if (existing !== null) {
    throw new DuplicateRunIdError(workflow.id, args.runId, existing.status);
  }

  // Register ownership BEFORE start: the run is live in-process for the whole
  // awaited window, and recoverOnBoot must never classify it as stale.
  ownedRunIds.add(args.runId);
  const run = await workflow.createRun({ runId: args.runId });
  const result = await run.start({ inputData: args.inputData });
  return { runId: args.runId, result };
}
