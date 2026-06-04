# @autobroker/workflows

> Status: Phase 0 alignment target, 2026-06-03. The source-of-intent is now
> **Mastra 1.x as the workflow backbone**. The pre-Phase-0 self-built
> `SkillRun` / `HarnessWorkflowRuntime` scaffold has been deleted; this package
> now owns the Mastra integration shell and runtime-glue surface. Layer 3 of the
> five-layer monorepo (`core -> model -> workflows -> tools -> app`). Sibling plans:
> [tools package](../tools/README.md) (the only side-effect layer), and the
> canonical phase plan in the dev-plan repo at
> `~/vscode/AutoBroker/AutoBroker-dev-plan/ts-rebuild/phases/index.html`.

## What this package becomes

The orchestration layer. It turns one skill invocation into a durable Mastra
workflow run while staying a pure coordinator that **never performs a product
side effect itself**.

Target shape:

| Concern | Owner |
| --- | --- |
| Skill execution | One flat linear Mastra `createWorkflow` per skill. |
| Agent model | Mastra agents receive AI SDK 6 `LanguageModel` instances from `@autobroker/model`; Mastra's remote model router is not used. |
| Session state | Mastra Memory threads/resources, with Observational Memory auto-compact on the chat lane only. |
| Approval pause | Tool/step-level `suspend()` plus persisted workflow snapshot; boot recovery re-attaches suspended runs to the approval UI. |
| Status projection | App-side projection from Mastra workflow state into AutoBroker's public run statuses. |
| Gate routing | Irreversible actions are routed through the L2 in-process gate in `@autobroker/tools`; workflows only orchestrate the ask/resume path. |

## What Phase 0 removed

The 2026-06-03 product-owner override deleted the old reversibility seam. Phase
0 removed the self-built engine artifacts instead of treating them as an
abstraction to preserve:

| Old artifact | Phase 0 result |
| --- | --- |
| `src/skillRun.ts` | Deleted; replace with Mastra workflow definitions plus a thin status-projection service as skills land. |
| `src/harnessWorkflowRuntime.ts` | Deleted; skills import/use Mastra primitives directly. |
| `SelfBuiltWorkflowRuntime` / `MastraWorkflowRuntime` split | Deleted; there is no parallel engine choice in MVP. |

The accepted cost is that Mastra public API/type churn reaches skill files
directly. The mitigation is a minor-version pin, codemods when needed, and the
live-harness regression net.

## Runtime glue that still belongs here

Mastra owns workflows and snapshots, but the embedded local app still needs
small product-specific glue:

- **Boot recovery** — list suspended/active runs at process start and apply the
  product policy: restart eligible runs, cancel stale runs, and re-attach
  approval UI for suspended runs.
- **Duplicate run guard** — reject duplicate `runId` starts app-side; Mastra can
  restart from step 1 on an existing id if the host allows it.
- **SSE discipline** — all workflow starts route through the streaming path that
  can feed the app's SSE/event bus; do not create invisible runs.
- **Gate rendering order** — every semantic/irreversible fallback is voiced and
  rendered as a gate before prose. Transient/equivalent fallbacks auto-allow but
  record trace spans.

This glue is a service layer, not an alternate workflow engine.

## Side-effect invariant

This layer holds **zero product SQLite handles** and makes **zero external API
calls**. Product DB writes, Gmail, Maps, browser network calls, and any
irreversible send/submit path live in `@autobroker/tools`. Mastra may persist
its own framework runtime state to the dedicated `mastra.db` beside
`autobroker.db`; that state is outside the product schema and outside the
drizzle parity gate.

## Dependency rules

- May import: `@autobroker/core`, `@autobroker/model`, `@autobroker/tools`, and
  Mastra runtime packages once Phase 0 lands.
- May **not** import: `app` surfaces.
- Enforced by TypeScript project references in `tsconfig.json`; changing the
  dependency graph is an architecture decision, not a drive-by import.

## Current scaffold status

As of this doc alignment pass, the package still compiles as the old scaffold.
That is intentional drift until Phase 0: the docs now describe the target
source-of-intent so the implementation work can delete/replace the old files in
one focused slice.
