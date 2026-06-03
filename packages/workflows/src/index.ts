/**
 * @autobroker/workflows — Layer 3 public surface.
 *
 * Exposes the self-built SkillRun state machine and the HarnessWorkflowRuntime
 * reversible seam. Consumers (apps/server, packages/skills) depend on the seam
 * interface, not on the concrete machine.
 *
 * Dependency wall: workflows may import core, model, and tools — never app.
 * workflows NEVER touches SQLite or external APIs; all side effects go through
 * the @autobroker/tools L2 gate.
 */

export {
  SkillRun,
  type SkillRunStatus,
  type SkillRunSnapshot,
  type SkillRunStore,
  type ResumePayload,
  type Transition,
} from "./skillRun.js";

export {
  type HarnessWorkflowRuntime,
  type WorkflowHandle,
  SelfBuiltWorkflowRuntime,
  MastraWorkflowRuntime,
} from "./harnessWorkflowRuntime.js";
