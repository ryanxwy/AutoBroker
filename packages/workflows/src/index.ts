/**
 * @autobroker/workflows — Layer 3 public surface.
 *
 * Transitional pre-Phase-0 scaffold. The source-of-intent is the Mastra
 * backbone; Phase 0 deletes the self-built SkillRun/HarnessWorkflowRuntime seam
 * and replaces this public surface with Mastra workflow host primitives.
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
