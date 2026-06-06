/**
 * @autobroker/workflows — Layer 3 public surface.
 *
 * The Mastra 1.x backbone (load-bearing). There is NO engine seam: the
 * transitional self-built SkillRun / HarnessWorkflowRuntime scaffold has been
 * DELETED; skills import Mastra primitives directly.
 *
 * What lands here (foundation first, then one skill at a time):
 *   - the Mastra instance (library mode — no `mastra dev`, no Hono server, no
 *     Cloud), storage = @mastra/libsql on file:~/.autobroker-ts/mastra.db —
 *     a dedicated DB beside the product autobroker.db, never the same file;
 *   - one flat linear `createWorkflow` per skill;
 *   - Memory threads/resources + OM auto-compact on the chat rail ONLY (OM is
 *     never enabled inside skill workflow runs — mastra#14598);
 *   - the runtime-glue service: boot recovery (MASTRA_TELEMETRY_DISABLED=1
 *     before construction → deterministic tool re-registration by toolName →
 *     listWorkflowRuns({status:'suspended'}) re-attach approval UI →
 *     restart()/cancel() per age policy), duplicate-runId idempotency guard,
 *     SSE pubsub discipline, and the Mastra→product status projection onto
 *     core's `SkillRunStatus` (single source — no core↔workflows enum drift).
 *
 * Dependency wall: workflows may import core, model, and tools — never app.
 * workflows NEVER touches SQLite or external APIs; all side effects go through
 * the @autobroker/tools L2 gate.
 */

// @mastra/core@1.41.0 + @mastra/memory@1.20.2 + @mastra/libsql@1.12.1 are
// installed as an EXACT date-matched trio (pinned, not range) — the published
// peer ranges are looser than reality (libsql@1.12.1 imports
// NotificationsStorage that core@1.38 lacks; mastra#10602-class residue), so
// bump all three together or none. `Mastra` / `Memory` / `LibSQLStore` /
// `createWorkflow` (subpath @mastra/core/workflows) all resolve under NodeNext
// ESM. Do NOT re-introduce a self-built run state machine here.

// #1244 fail-closed detector as a Mastra output Processor (detection logic
// stays pure in @autobroker/model).
export {
  malformedToolCallProcessor,
  type MalformedToolCallProcessorOptions,
  type MalformedToolCallTripMetadata,
} from "./malformedToolCallProcessor.js";

// The library-mode Mastra instance (storage = mastra.db on disk, the dual-DB
// never-co-write rule keeps it separate from the product DB). No dev server, no Cloud.
export {
  createMastraInstance,
  getMastra,
  resetMastraForTests,
  type CreateMastraInstanceOptions,
} from "./mastra.js";

// The runnable harness.generate facade: the Mastra Agent
// loop end-to-end. Types + pure helpers live in @autobroker/model; the loop is
// owned here (only the api-key lane lets the AI SDK own the tool loop).
// emit_result discipline + #1244 fail-closed.
export {
  harness,
  type HarnessLedgerContext,
} from "./harness.js";

// Runtime glue — boot recovery (suspended re-attach + stale
// 'running' restart/cancel) and the duplicate-runId guard. Thin wrappers over
// the Mastra instance/workflow/run API (no engine seam).
export {
  recoverOnBoot,
  restartStaleRun,
  cancelStaleRun,
  startRunGuarded,
  resetRuntimeGlueForTests,
  DuplicateRunIdError,
  type BootRecoveryReport,
  type UnclassifiedRun,
  type ReattachableSuspendedRun,
  type StaleRunningRun,
  type RecoverOnBootOptions,
  type StartRunGuardedArgs,
} from "./runtimeGlue.js";

// The search_profile_intake skill workflow (the first skill) — one flat
// linear createWorkflow, 8 steps, no nested workflow. The test-only deps seam is
// exported so the offline in-stack tests drive the real suspend/resume chain.
export {
  searchProfileIntakeWorkflow,
  SEARCH_PROFILE_INTAKE_WORKFLOW_ID,
  __setIntakeDepsForTests,
  __resetIntakeDepsForTests,
  type IntakeWorkflowDeps,
} from "./searchProfileIntake.js";

// The intake skill contracts (emit schemas + resume schemas + prompt builders),
// co-located with the skill (skill-local, single-use; see header rationale).
export {
  IntakePrefillSchema,
  TrimVerifyResultSchema,
  CollectResumeSchema,
  ForceOverrideResumeSchema,
  AmbiguousLocationResumeSchema,
  MalformedRetryResumeSchema,
  buildPrefillPrompt,
  buildTrimVerifyPrompt,
  type IntakePrefill,
  type TrimVerifyResult,
} from "./intakeContracts.js";

// The registered-workflows map for createMastraInstance({ workflows }) and the
// ids recoverOnBoot scans (the boot caller owns this list — runtimeGlue).
export {
  REGISTERED_WORKFLOWS,
  REGISTERED_WORKFLOW_IDS,
} from "./registeredWorkflows.js";

// The chat-rail Memory thread store (sessions = Mastra Memory threads). The
// ONLY construction of @mastra/memory Memory — apps do session CRUD through the
// product-shaped RailSessionStore facade and never import @mastra/* (dep wall).
// OM is configured rail-only with its model PINNED to DeepSeek via resolveModel
// (never the @mastra default Gemini).
export {
  createRailMemory,
  RailSessionStore,
  RAIL_RESOURCE_ID,
  PIN_METADATA_KEY,
  type RailSession,
} from "./railMemory.js";
