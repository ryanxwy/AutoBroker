# @autobroker/workflows

> Status: Phase 3 scaffold, 2026-06-02. Owns the **self-built ~50-line SkillRun
> state machine** and the **HarnessWorkflowRuntime reversible seam** (the Mastra
> upgrade slot). Layer 3 of the five-layer monorepo
> (`core → model → workflows → tools → app`). Sibling plans:
> [tools package](../tools/README.md) (Layer 4, the only side-effect layer),
> and the canonical phase plan in the dev-plan repo at
> `~/vscode/AutoBroker/AutoBroker-dev-plan/ts-e2e-rebuild-plan-20260602/index.html`.

## What this package is

The orchestration layer. It turns one skill invocation into a sequence of state
transitions and drives it to a terminal state — while staying a pure coordinator
that **never performs a side effect itself**.

Two pieces:

| File | Role |
| --- | --- |
| `src/skillRun.ts` | The ~50-line state machine: status enum (incl. `awaiting_approval`), `resume_payload` JSON continuation, crash-and-resume, heartbeat staleness. |
| `src/harnessWorkflowRuntime.ts` | The reversible seam callers depend on. `SelfBuiltWorkflowRuntime` is the production engine today; `MastraWorkflowRuntime` is a documented, unimplemented upgrade slot. |

## Why self-built and not a framework

Decided 2026-06-01 (local-first platform round), reaffirmed 2026-06-02:
**all 17 skills are sub-10-state linear pipelines.** A hand-rolled status enum
plus a `resume_payload` JSON column on the existing SQLite `skill_runs` table is
strictly simpler than adopting Mastra. The framework would be pure overhead.

Mastra stays parked behind `HarnessWorkflowRuntime`. **Upgrade triggers** — adopt
it only when a *real* workflow hits one of these:

1. genuinely exceeds ~10 states;
2. needs multi-agent sub-orchestration;
3. needs durable **mid-LLM-call** resume (resume *inside* a single model call —
   step-boundary crash-and-resume already covers the rest).

Until then, `MastraWorkflowRuntime` throws on use; the seam keeps the swap to a
one-file change.

## Crash-and-resume invariant

`awaiting_approval` is a **durable pause**, not an in-memory `await`. On entering
it, `SkillRun.apply` persists the `resume_payload` to disk *before* yielding, so
a process restart loses nothing. The **Decision table** (SQLite) is the
persistent backing store for the awaiting-user set; the in-memory await store is
a convenience cache only — never the source of truth. A heartbeat reaper marks
`running` runs stale after 5 minutes and transitions them to `aborted` so a
crashed run never wedges a profile.

## Side-effect invariant

This layer holds **zero** SQLite handles and makes **zero** external API calls.
When a skill proposes an irreversible action (Gmail send, dealer form submit),
the workflow routes it **through the L2 in-process gate in `@autobroker/tools`**.
A "needs approval" verdict suspends the run; it does not re-implement or bypass
the gate. There is no second code path to a side effect.

## Dependency rules

- May import: `@autobroker/core`, `@autobroker/model`, `@autobroker/tools`.
- May **not** import: `app` (anything below it in the wall).
- Enforced by TypeScript project references in `tsconfig.json`.

## Status of the scaffold

Types and the machine skeleton are real and compile standalone. Step-pipeline
execution, the Decision-table approval lookup, and the stale-run reaper query are
marked `TODO(phase-3)` and land as the 17 skills are built one-per-commit
(`phase3/<skill>:` prefix).
