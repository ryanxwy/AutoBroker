/**
 * SkillRun — transitional pre-Phase-0 scaffold.
 *
 * The source-of-intent is Mastra 1.x as the workflow backbone. Phase 0 replaces
 * this self-built state machine with flat Mastra createWorkflow definitions plus
 * a small workflow-host service for boot recovery, duplicate-runId guard, SSE
 * pubsub, and product status projection.
 *
 * This file remains only so the scaffold compiles until that replacement lands.
 * Do not extend it as the production runtime.
 *
 * INVARIANT: SkillRun NEVER performs a side effect itself. Irreversible actions
 *   (Gmail send / dealer form submit) are physically reachable ONLY through the
 *   L2 in-process gate in @autobroker/tools. When this machine reaches
 *   `awaiting_approval` it has already routed the proposed action THROUGH the
 *   gate, which returned "needs approval" — it does not re-implement the gate.
 */

// TODO(phase-0): replace this local scaffold status with the product status
// projection from @autobroker/core once the Mastra workflow host lands.
// import { SkillRunStatus, type SkillRunRow } from "@autobroker/core";

/**
 * Terminal and non-terminal run states.
 * `awaiting_approval` is the only state that survives a process restart by
 * design; `running` runs that miss their heartbeat are reaped to `aborted`.
 */
export type SkillRunStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "succeeded"
  | "declined"
  | "aborted"
  | "failed";

const TERMINAL_STATES: ReadonlySet<SkillRunStatus> = new Set([
  "succeeded",
  "declined",
  "aborted",
  "failed",
]);

/**
 * Opaque, JSON-serializable continuation captured at an `awaiting_approval`
 * pause. Persisted to the `skill_runs.resume_payload` column so the run can be
 * re-entered after a crash. Keep this FLAT and JSON-round-trippable — no class
 * instances, no functions.
 */
export interface ResumePayload {
  /** The skill this run is executing (e.g. "dealer_web_lead_submit"). */
  skill: string;
  /** Machine step to resume at after approval is granted. */
  step: string;
  /** Structured description of the side effect the gate is holding. */
  pendingAction: {
    kind: "gmail_send" | "dealer_form_submit" | "typed_yes_confirm";
    /** Gate-handler input, already validated; re-fed to the gate on resume. */
    gateRequest: Record<string, unknown>;
  };
  /** Arbitrary skill-local scratch state needed to continue. */
  context: Record<string, unknown>;
}

export interface SkillRunSnapshot {
  id: string;
  skill: string;
  status: SkillRunStatus;
  /** Non-null exactly when status === "awaiting_approval". */
  resumePayload: ResumePayload | null;
  /** Updated on every transition; the reaper compares against now(). */
  heartbeatAt: number;
}

/** Persistence seam. Backed by the SQLite `skill_runs` + Decision tables in
 *  @autobroker/tools/db. The state machine itself stays pure: it asks the store
 *  to read/write and never opens a DB handle. */
export interface SkillRunStore {
  load(id: string): Promise<SkillRunSnapshot | null>;
  save(snapshot: SkillRunSnapshot): Promise<void>;
}

/** Outcome of advancing the machine one transition. */
export type Transition =
  | { kind: "advance"; status: "running" }
  | { kind: "suspend"; status: "awaiting_approval"; resumePayload: ResumePayload }
  | { kind: "terminal"; status: "succeeded" | "declined" | "aborted" | "failed" };

/**
 * The whole machine. ~50 lines of transition logic; everything heavy lives in
 * the injected `store` (SQLite) and in @autobroker/tools (gate + side effects).
 */
export class SkillRun {
  constructor(
    private readonly store: SkillRunStore,
    /** Heartbeat staleness threshold; runs older than this are reapable. */
    private readonly staleAfterMs = 5 * 60 * 1000,
  ) {}

  /** Begin a fresh run in `pending`. */
  async start(id: string, skill: string): Promise<SkillRunSnapshot> {
    const snapshot: SkillRunSnapshot = {
      id,
      skill,
      status: "pending",
      resumePayload: null,
      heartbeatAt: Date.now(),
    };
    await this.store.save(snapshot);
    return snapshot;
  }

  /**
   * Apply one transition and persist. Persisting BEFORE returning is what makes
   * `awaiting_approval` crash-survivable: the resume_payload is on disk before
   * the caller ever yields.
   */
  async apply(id: string, t: Transition): Promise<SkillRunSnapshot> {
    const current = await this.store.load(id);
    if (!current) throw new Error(`SkillRun ${id} not found`);
    if (TERMINAL_STATES.has(current.status)) {
      throw new Error(`SkillRun ${id} already terminal (${current.status})`);
    }

    const next: SkillRunSnapshot = {
      ...current,
      status: t.status,
      resumePayload: t.kind === "suspend" ? t.resumePayload : null,
      heartbeatAt: Date.now(),
    };
    await this.store.save(next);
    return next;
  }

  /**
   * Re-enter a run that was paused at `awaiting_approval` (after process restart
   * or after a human approval/decline). Reads the durable resume_payload from
   * the store; the caller maps `approved` to the next transition.
   *
   * TODO(phase-3): wire the approval decision lookup to the Decision table so a
   * resume after a crash reconstructs the human's verdict, not just the pause.
   */
  async resume(id: string): Promise<ResumePayload> {
    const current = await this.store.load(id);
    if (!current) throw new Error(`SkillRun ${id} not found`);
    if (current.status !== "awaiting_approval" || !current.resumePayload) {
      throw new Error(`SkillRun ${id} is not awaiting approval`);
    }
    return current.resumePayload;
  }

  /** True if a `running` run has missed its heartbeat and should be reaped. */
  isStale(snapshot: SkillRunSnapshot, now = Date.now()): boolean {
    return (
      snapshot.status === "running" &&
      now - snapshot.heartbeatAt > this.staleAfterMs
    );
  }
}
