/**
 * @autobroker/workflows — Layer 3 public surface.
 *
 * The Mastra 1.x backbone (load-bearing). Per D4 (DECISIONS, 2026-06-03) there
 * is NO engine seam: the transitional self-built SkillRun /
 * HarnessWorkflowRuntime scaffold has been DELETED in Phase 0; skills import
 * Mastra primitives directly. A re-decision after a hard spike failure is an
 * explicit refactor, accepted by the product owner — not a seam kept "just in
 * case".
 *
 * What lands here (Phase-0 spikes 1–2, then one skill at a time):
 *   - the Mastra instance (library mode — no `mastra dev`, no Hono server, no
 *     Cloud), storage = @mastra/libsql on file:~/.autobroker-ts/mastra.db —
 *     a dedicated DB beside the product autobroker.db (D1), never the same file;
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

// Spike-1 ESM/dependency smoke (offline half) is DONE: @mastra/core@1.41.0 +
// @mastra/memory@1.20.2 + @mastra/libsql@1.12.1 are installed as an EXACT
// date-matched trio (bumped-then-frozen 2026-06-04 ruling) — the published peer ranges are looser than
// reality (libsql@1.12.1 imports NotificationsStorage that core@1.38 lacks;
// mastra#10602-class residue), so bump all three together or none.
// `Mastra` / `Memory` / `LibSQLStore` / `createWorkflow` (subpath
// @mastra/core/workflows) all resolve under NodeNext ESM. Remaining half of
// spike 1: one real generate through a Mastra agent (needs a live api-key).
// Do NOT re-introduce a self-built run state machine here.

// #1244 fail-closed detector as a Mastra output Processor (spike-3 shell;
// detection logic stays pure in @autobroker/model).
export {
  malformedToolCallProcessor,
  type MalformedToolCallProcessorOptions,
  type MalformedToolCallTripMetadata,
} from "./malformedToolCallProcessor.js";

// Spike-5: the library-mode Mastra instance (storage = mastra.db on disk, D1
// dual-DB never-co-write). No dev server, no Cloud.
export {
  createMastraInstance,
  getMastra,
  resetMastraForTests,
  type CreateMastraInstanceOptions,
} from "./mastra.js";

// The runnable harness.generate facade (the M0 critical path): the Mastra Agent
// loop end-to-end. Types + pure helpers live in @autobroker/model; the loop is
// owned here (归属裁定 2026-06-04). emit_result discipline + #1244 fail-closed.
export {
  harness,
  HarnessNotImplementedError,
  type HarnessLedgerContext,
} from "./harness.js";

// Spikes 2 & 7: runtime glue — boot recovery (suspended re-attach + stale
// 'running' restart/cancel) and the duplicate-runId guard. Thin wrappers over
// the Mastra instance/workflow/run API (D4: no engine seam).
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

// M1: the search_profile_intake skill workflow (the first skill) — one flat
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

// M2: the chat-rail Memory thread store (sessions = Mastra Memory threads). The
// ONLY construction of @mastra/memory Memory — apps do session CRUD through the
// product-shaped RailSessionStore facade and never import @mastra/* (dep wall).
// OM is configured rail-only with its model PINNED to DeepSeek via resolveModel
// (USER DIRECTIVE 2026-06-05 — never the @mastra default Gemini).
export {
  createRailMemory,
  RailSessionStore,
  RAIL_RESOURCE_ID,
  PIN_METADATA_KEY,
  type RailSession,
} from "./railMemory.js";
