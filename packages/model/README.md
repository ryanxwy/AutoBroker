# @autobroker/model

> Status: Phase 0 alignment target · 2026-06-03 · Layer 2 of the AutoBroker
> (TS) five-layer monorepo: **the AI SDK 6 provider layer**. Owns provider
> routing, model-id policy, and provider-neutral structured-generation helpers.
> Mastra owns orchestration and the agent loop; this package supplies
> `LanguageModel` instances to Mastra.

Layer 2 (`model`) is the only product layer that imports the AI SDK
(`ai`, `@ai-sdk/*`). It depends on Layer 1 (`@autobroker/core`) and **must not**
import `workflows` / `tools` / `app`.

```
core → model → workflows → tools → app
```

## What lives here

| File | Owns |
| --- | --- |
| `src/registry.ts` | `createProviderRegistry({ deepseek, anthropic, openai })` with `customProvider` capability aliases; `resolveModel(alias)` returns AI SDK 6 `LanguageModel` instances for Mastra agents |
| `src/policy.ts` | `policy(useCase) → { alias, provider, capabilities }` — workflows name only a `useCase` |
| `src/harness.ts` | `HarnessGenerateInput/Result` signature types + `chooseStructuredOutputStrategy` — the provider-neutral structured-generation contract; the runnable `harness.generate` facade lives in `@autobroker/workflows` |
| `src/index.ts` | the public re-export surface |

## Provider policy (2026-06-04 current)

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
`deepseek.cheap`, `anthropic.strong`. These are model-capability aliases, not
per-provider L1-L5 harness tiering. The registry separator is `.` so an alias
string *is* a registry key. Skills/workflows never name a provider — they call
`policy(useCase)`; swapping the model behind a use-case is an edit in
`policy.ts`/`registry.ts`, nowhere else. `policy()` is **fail-loud**: an unmapped
use-case or a missing `CapabilityFlags` row throws rather than silently
down-routing.

DeepSeek ids are pinned now (`deepseek-v4-flash` / `deepseek-v4-pro`).
Anthropic/OpenAI aliases are present because those lanes are first-class, but
their exact ids and `CapabilityFlags` rows remain a cross-provider smoke
obligation before acceptance.

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

The mitigation is the never-mix rule above plus in-process Zod validation; when
the single `emit_result` tool never fires, the workflows harness fails closed
(no prose fallthrough, no regex-extract of a tool name from content).

## Build

```bash
pnpm --filter @autobroker/model build      # tsc -b (builds @autobroker/core first)
pnpm --filter @autobroker/model typecheck
```

## Dependency pins

`ai@^6` is intentional (not v7 — `LanguageModelV4` would break V3-spec community
providers). CI adds a major-bump ignore. Provider adapters: `@ai-sdk/anthropic`,
`@ai-sdk/openai`, `@ai-sdk/deepseek`. Phase 0 pins DeepSeek aliases to the
current explicit ids: `deepseek-v4-flash` for default/chat/cheap and
`deepseek-v4-pro` for strong. Thinking is a per-call parameter: chat/rail
defaults to thinking ON + `reasoning_effort:"high"`, while schema-bound
`emit_result` steps force thinking OFF + `temperature:0` because named/forced
tool choice is rejected in thinking mode.
