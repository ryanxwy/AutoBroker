/**
 * SkillRun — the self-built ~50-line state machine that orchestrates one skill
 * invocation from start to terminal state.
 *
 * WHY self-built (not Mastra) — decided 2026-06-01 (local-first platform round),
 * reaffirmed 2026-06-02:
 *   All 17 skills are <10-state LINEAR pipelines. A hand-rolled status enum plus
 *   a `resume_payload` JSON column on the existing SQLite `skill_runs` table is
 *   strictly simpler than a workflow framework. Mastra stays parked behind
 *   `HarnessWorkflowRuntime` (see ./harnessWorkflowRuntime.ts) and is only pulled
 *   in if a workflow genuinely exceeds ~10 states, needs multi-agent
 *   sub-orchestration, or needs durable mid-LLM-call resume.
 *
 * CRASH-AND-RESUME (the load-bearing reason this is a state machine at all):
 *   `awaiting_approval` is a DURABLE pause, not an in-memory await. The
 *   `resume_payload` carries everything needed to re-enter the run after a
 *   process restart. The Decision table (SQLite) is the persistent backing store
 *   for the awaiting-user set — the in-memory await store is a convenience cache
 *   only, NEVER the source of truth. A heartbeat reaper marks runs stale
 *   (heartbeat > 5min) as aborted so a crashed run never wedges a profile.
 *
 * INVARIANT: SkillRun NEVER performs a side effect itself. Irreversible actions
 *   (Gmail send / dealer form submit) are physically reachable ONLY through the
 *   L2 in-process gate in @autobroker/tools. When this machine reaches
 *   `awaiting_approval` it has already routed the proposed action THROUGH the
 *   gate, which returned "needs approval" — it does not re-implement the gate.
 */

// TODO(phase-3): import the real Zod-validated status enum + row types from
// @autobroker/core once that package is scaffolded. Inlined here as a stub so
// this file typechecks standalone during the workflows scaffold.
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
