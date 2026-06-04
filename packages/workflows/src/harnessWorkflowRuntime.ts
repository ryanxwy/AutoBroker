/**
 * HarnessWorkflowRuntime — transitional pre-Phase-0 seam.
 *
 * This interface and its self-built runtime are no longer the target
 * architecture. Per the 2026-06-03 Mastra decision, Phase 0 deletes this seam
 * and lets skills use Mastra primitives directly. The replacement should be a
 * thin workflow-host service around Mastra, not an alternate engine abstraction.
 */

import { SkillRun, type SkillRunSnapshot, type SkillRunStore } from "./skillRun.js";

/** Provider-neutral handle to a started/loaded run, returned to callers. */
export interface WorkflowHandle {
  id: string;
  skill: string;
  status: SkillRunSnapshot["status"];
}

/**
 * Transitional seam kept only until the Mastra workflow host lands.
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
 * Transitional runtime: thin adapter over `SkillRun`. Do not treat this as the
 * production path for new work; Phase 0 replaces it with Mastra.
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
 * Deprecated placeholder. Phase 0 should delete this class with the seam rather
 * than filling it in.
 */
export class MastraWorkflowRuntime implements HarnessWorkflowRuntime {
  startRun(): Promise<WorkflowHandle> {
    throw new Error(
      "MastraWorkflowRuntime placeholder is deprecated — Phase 0 deletes HarnessWorkflowRuntime and installs the Mastra workflow host.",
    );
  }
  resumeRun(): Promise<WorkflowHandle> {
    throw new Error("MastraWorkflowRuntime placeholder is deprecated.");
  }
  reapStale(): Promise<string[]> {
    throw new Error("MastraWorkflowRuntime placeholder is deprecated.");
  }
}
