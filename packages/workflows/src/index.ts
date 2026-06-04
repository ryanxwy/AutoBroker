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

// Spike-1 ESM/dependency smoke (offline half) is DONE: @mastra/core@1.38.0 +
// @mastra/memory@1.20.1 + @mastra/libsql@1.12.0 are installed as an EXACT
// date-matched trio (2026-06-02) — the published peer ranges are looser than
// reality (libsql@1.12.1 imports NotificationsStorage that core@1.38 lacks;
// mastra#10602-class residue), so bump all three together or none.
// `Mastra` / `Memory` / `LibSQLStore` / `createWorkflow` (subpath
// @mastra/core/workflows) all resolve under NodeNext ESM. Remaining half of
// spike 1: one real generate through a Mastra agent (needs a live api-key).
// Do NOT re-introduce a self-built run state machine here.
export {};
