# @autobroker/model

> Status: Phase 0 alignment target · 2026-06-03 · Layer 2 of the AutoBroker
> (TS) five-layer monorepo: **the AI SDK 6 provider layer**. Owns provider
> routing, model-id policy, provider-neutral structured-generation helpers, and
> #1244 fail-closed detector/Processor helpers. Mastra owns orchestration and
> the agent loop; this package supplies `LanguageModel` instances to Mastra.
> Canonical architecture lives in the plan repo:
> `../../../AutoBroker-dev-plan/ts-rebuild/architecture/DECISIONS.html`,
> `ARCH_PROVIDER_ROUTER.html`, `ARCH_STRUCTURED_OUTPUT.html`, and the foundation
> phase `../../../AutoBroker-dev-plan/ts-rebuild/phases/PHASE_0_foundation.html`.

Layer 2 (`model`) is the only product layer that imports the AI SDK
(`ai`, `@ai-sdk/*`). It depends on Layer 1 (`@autobroker/core`) and **must not**
import `workflows` / `tools` / `app`.

```
core → model → workflows → tools → app
```

## What lives here

| File | Owns |
| --- | --- |
| `src/registry.ts` | `createProviderRegistry({ deepseek, anthropic, openai })` with `customProvider` tier aliases; `resolveModel(alias)` returns AI SDK 6 `LanguageModel` instances for Mastra agents |
| `src/policy.ts` | `policy(useCase) → { alias, provider, capabilities }` — workflows name only a `useCase` |
| `src/harness.ts` | `harness.generate({ useCase, schema, prompt, hitlAvailable })` — provider-neutral structured-generation/probe helper; Phase 0 wires resolved models into Mastra workflows |
| `src/malformedToolCall.ts` | the **#1244 fail-closed** malformed-tool-call detector/Processor helpers (`detectMalformedToolCall`, `assertToolTurnOrFailClosed`, `MalformedToolCallAbort`) |
| `src/index.ts` | the public re-export surface |

## Provider policy (2026-06-03 current)

**DeepSeek is the DEFAULT api-key provider AND the live-harness test agent.**
**Anthropic and OpenAI are equally first-class, switchable api-key lanes** — the
registry wires all three. There is **no per-provider tiering**, **no
sanitized/synthetic/ZDR precondition gate**, and **no "DeepSeek is optional"
framing**. DeepSeek runs the real harness tests on the real corpus.

Privacy is handled by an **upfront disclosure in the GitHub README**: DeepSeek
stores inputs/prompts/uploaded files in the PRC and may use them for training;
users who mind switch to a Western provider by changing the alias prefix. This
package enforces no privacy gate.

> This supersedes the research-era "DeepSeek-default REFUTED" verdict
> (`supersededLedger`) per the product-owner decision of 2026-06-02.

### Aliases and routing

A `ModelAlias` is `{provider}.{tier}` (from `@autobroker/core`), e.g.
`deepseek.cheap`, `anthropic.strong`. The registry separator is `.` so an alias
string *is* a registry key. Skills/workflows never name a provider — they call
`policy(useCase)`; swapping the model behind a use-case is an edit in
`policy.ts`/`registry.ts`, nowhere else. `policy()` is **fail-loud**: an unmapped
use-case or a missing `CapabilityFlags` row throws rather than silently
down-routing.

## Mastra owns the api-key agent loop

This package no longer owns orchestration. On the **api-key lane**, AI SDK 6
adapts providers and returns `LanguageModel` instances; Mastra agents own the
agentic loop, workflow snapshots, and durable `suspend()` / resume. Native
Mastra tool/step approval is a convenience layer. The in-process gate handler
in `@autobroker/tools` remains the only path to side effects.

Subscription / CLI-spawn lanes remain optional. Their loop is outside the
api-key path, so the same L2 gate must be enforced in the in-process MCP/tool
handler rather than relying on provider-native approval.

## Structured-output strategy

Driven by `CapabilityFlags.supportsOutputObjectWithTools`:

- **DeepSeek (`false`)** — never mix structured object output with tools in the
  same model step (per-step `json_schema` injection provokes the #1244
  text-dump). Use the single `emit_result` tool (Zod-validated in-process)
  **or** a two-phase pipeline (tools-only loop, then a separate no-tools
  structured call).
- Always **Zod 4 post-validate** the result against the caller's schema
  (belt-and-suspenders), regardless of provider.

## #1244 fail-closed detector

`malformedToolCall.ts` is a **safety boundary**, not a convenience. DeepSeek
intermittently emits a tool call as plain text in `content`. If the loop treats
that as "no tool call → final prose", an approval gate that should fire never
does — and that lands on the 3 irreversible mutation skills.

Policy, enforced after every tool-expecting step:

- `finish_reason != "tool_calls"` **or** empty/absent `tool_calls` **or** a
  tool-shaped blob in `content` ⇒ **fail-closed**.
- Under HITL: **suspend** (`reason: "malformed_tool_call"`), via the Mastra
  output Processor / post-step detector path.
- With no HITL: **hard-abort** (throw `MalformedToolCallAbort`).
- **NEVER** regex-extract a function name from `content` and execute it.
  fail-open == silent-fallback, which is forbidden.

## Build

```bash
pnpm --filter @autobroker/model build      # tsc -b (builds @autobroker/core first)
pnpm --filter @autobroker/model typecheck
```

## Dependency pins

`ai@^6` is intentional (not v7 — `LanguageModelV4` would break V3-spec community
providers). CI adds a major-bump ignore. Provider adapters: `@ai-sdk/anthropic`,
`@ai-sdk/openai`, `@ai-sdk/deepseek`. Phase 0 must pin DeepSeek aliases to the
current explicit ids: `deepseek-v4-flash` for the default/cheap path and
`deepseek-v4-pro` for the reasoner/strong path. Thinking is default-off for
schema-bound skill pipelines.
