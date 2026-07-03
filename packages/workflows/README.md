# @autobroker/workflows

The orchestration layer (Layer 3 of the five-layer monorepo
`core -> model -> workflows -> tools -> app`). It is the **Mastra 1.x** backbone:
it turns one skill invocation into a durable Mastra workflow run while staying a
pure coordinator that **never performs a product side effect itself**. Sibling
package: [tools](../tools/README.md), the only side-effect layer.

There is no engine seam — skills import Mastra primitives directly; the Mastra
instance runs in library mode (storage = `@mastra/libsql` on
`file:~/.autobroker-ts/mastra.db`, a dedicated DB beside the product
`autobroker.db`), with no `mastra dev`, no Hono server, and no Cloud.

## What lives here

| Concern | Owner |
| --- | --- |
| Skill execution | One flat linear Mastra `createWorkflow` per skill. The 17 skill workflows are registered in `registeredWorkflows.ts` (`REGISTERED_WORKFLOWS` for `createMastraInstance`, `REGISTERED_WORKFLOW_IDS` for boot scans). |
| Agent loop | `harness.ts` — the runnable `harness.generate` facade that drives the Mastra Agent loop end-to-end. The pure helpers/types live in `@autobroker/model`; the loop is owned here. `emit_result` single-tool discipline. |
| Agent model | Mastra agents receive AI SDK 6 `LanguageModel` instances from `@autobroker/model` (policy-driven, DeepSeek-default); Mastra's remote model router is not used. Per-run provider selection is applied at the generate seam (`agentSelection.ts`). |
| Chat sessions | `railMemory.ts` — the chat-rail Memory thread store (sessions = Mastra Memory threads/resources), with Observational Memory auto-compact configured on the chat rail ONLY (never inside a skill workflow run). Apps do session CRUD through the product-shaped `RailSessionStore` facade and never import `@mastra/*` directly. |
| Boot recovery / run guard | `runtimeGlue.ts` — boot recovery (re-attach suspended runs to the approval UI, restart/cancel stale `running` runs per age policy) and the duplicate-`runId` idempotency guard. Thin wrappers over the Mastra instance/workflow/run API. |
| Approval pause | Tool/step-level `suspend()` plus the persisted workflow snapshot; boot recovery re-attaches suspended runs to the approval UI. The shared batch_review suspend/resume contract lives in `batchReviewContracts.ts`. |
| NL routing | `router.ts` — the LLM skill-router (a core product feature): it reads a free-form chat message and routes it to ONE of the 17 skills / intake / clarify, and also re-ranks the skills popover (advisory only). Single `emit_result` + Zod, #1244 fail-closed → clarify. |
| #1244 fail-closed | `malformedToolCallProcessor.ts` — the fail-closed detector wired as a Mastra output Processor (detection logic stays pure in `@autobroker/model`). `recoverEmitWithRetry.ts` is the bounded, no-HITL, same-provider single retry for the opt-in heavy extractors before the identical hard-abort. |
| Status projection | App-side projection from Mastra workflow state into AutoBroker's public `SkillRunStatus` (single source — no core↔workflows enum drift). |
| Gate routing | Irreversible actions route through the L2 in-process gate in `@autobroker/tools`; workflows only orchestrate the ask/resume path. |

## Side-effect invariant

This layer holds **zero product SQLite handles** and makes **zero external API
calls**. Product DB writes, Gmail, Maps, browser network calls, and any
irreversible send/submit path live in `@autobroker/tools`. Mastra persists its
own framework runtime state to the dedicated `mastra.db` beside `autobroker.db`;
that state is outside the product schema and outside the drizzle parity gate.

Every semantic/irreversible fallback is voiced and rendered as a gate before
prose; transient/equivalent fallbacks auto-allow but record a trace span. All
workflow starts route through the streaming path that feeds the app's SSE/event
bus — there are no invisible runs.

## Dependency rules

- May import: `@autobroker/core`, `@autobroker/model`, `@autobroker/tools`, and
  the Mastra runtime packages (`@mastra/core`, `@mastra/memory`, `@mastra/libsql`
  — pinned as an exact date-matched trio).
- May **not** import: `app` surfaces.
- Enforced by TypeScript project references in `tsconfig.json`; changing the
  dependency graph is an architecture decision, not a drive-by import.
