/**
 * HarnessWorkflowRuntime — the REVERSIBLE seam that hides the orchestration
 * engine from the rest of the system.
 *
 * Today the only implementation is `SelfBuiltWorkflowRuntime`, which drives the
 * ~50-line `SkillRun` state machine (./skillRun.ts). The seam exists so that
 * swapping in Mastra later is a one-file change at the runtime boundary, NOT a
 * rewrite of every skill: skills and the server talk to this interface, never to
 * `SkillRun` directly.
 *
 * UPGRADE TRIGGERS (decided 2026-06-01, reaffirmed 2026-06-02) — only adopt
 * Mastra behind this seam when at least one is true for a real workflow:
 *   1. The workflow genuinely exceeds ~10 states (current max is well under).
 *   2. It needs multi-agent sub-orchestration (one skill driving sub-agents).
 *   3. It needs durable MID-LLM-CALL resume (resume inside a single model call,
 *      not just between steps — which crash-and-resume already covers).
 * Until then, a framework is pure overhead: all 17 skills are <10-state linear
 * pipelines and the self-built machine + SQLite resume_payload is sufficient.
 */

import { SkillRun, type SkillRunSnapshot, type SkillRunStore } from "./skillRun.js";

/** Provider-neutral handle to a started/loaded run, returned to callers. */
export interface WorkflowHandle {
  id: string;
  skill: string;
  status: SkillRunSnapshot["status"];
}

/**
 * The seam. Both the self-built engine and a future Mastra-backed engine
 * implement this. Callers (skills, the server's SSE route) depend only on this
 * type. Keep the surface small — every method added here must also be
 * implementable by Mastra, or the seam stops being reversible.
 */
export interface HarnessWorkflowRuntime {
  /** Start a new run for `skill`, returning a handle in `pending`/`running`. */
  startRun(id: string, skill: string): Promise<WorkflowHandle>;
  /** Re-enter a crash-paused or approval-paused run by id. */
  resumeRun(id: string): Promise<WorkflowHandle>;
  /** Reap `running` runs whose heartbeat went stale (>5min) to `aborted`. */
  reapStale(): Promise<string[]>;
}

/**
 * Default runtime: thin adapter over `SkillRun`. This is the production path for
 * Phase 3+; the Mastra slot below stays a no-op stub until an upgrade trigger
 * fires.
 */
export class SelfBuiltWorkflowRuntime implements HarnessWorkflowRuntime {
  private readonly machine: SkillRun;

  constructor(store: SkillRunStore) {
    this.machine = new SkillRun(store);
  }

  async startRun(id: string, skill: string): Promise<WorkflowHandle> {
    const snap = await this.machine.start(id, skill);
    // TODO(phase-3): drive the skill's step pipeline here — each step routes any
    // proposed side effect THROUGH the @autobroker/tools L2 gate, and a
    // "needs approval" verdict suspends the run via SkillRun.apply({suspend}).
    return { id: snap.id, skill: snap.skill, status: snap.status };
  }

  async resumeRun(id: string): Promise<WorkflowHandle> {
    const payload = await this.machine.resume(id);
    // TODO(phase-3): replay from payload.step; re-feed payload.pendingAction
    // .gateRequest to the gate now that approval exists.
    return { id, skill: payload.skill, status: "running" };
  }

  async reapStale(): Promise<string[]> {
    // TODO(phase-3): query the store for `running` runs past the heartbeat
    // threshold and transition each to `aborted`. Returns reaped run ids.
    return [];
  }
}

/**
 * Mastra upgrade slot — intentionally NOT implemented.
 *
 * Leaving this as a documented throw (rather than deleting it) keeps the seam
 * honest: the day an upgrade trigger fires, this is the single class to fill in,
 * and `app`/skills keep depending on `HarnessWorkflowRuntime` unchanged.
 */
export class MastraWorkflowRuntime implements HarnessWorkflowRuntime {
  // TODO(upgrade-trigger): only build this when a real workflow hits >10 states,
  // needs multi-agent sub-orchestration, or needs durable mid-LLM-call resume.
  startRun(): Promise<WorkflowHandle> {
    throw new Error(
      "MastraWorkflowRuntime is an upgrade slot — not yet warranted (no >10-state / multi-agent / durable-mid-LLM-resume workflow exists).",
    );
  }
  resumeRun(): Promise<WorkflowHandle> {
    throw new Error("MastraWorkflowRuntime is an upgrade slot — not implemented.");
  }
  reapStale(): Promise<string[]> {
    throw new Error("MastraWorkflowRuntime is an upgrade slot — not implemented.");
  }
}
