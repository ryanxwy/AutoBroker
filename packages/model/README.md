# @autobroker/model

> Status: Phase 0 (foundation) · 2026-06-02 · Layer 2 of the AutoBroker (TS)
> five-layer monorepo: **the AI SDK layer**. Owns provider routing and the
> provider-neutral structured-generation entry. Sits above `@autobroker/core`,
> below `@autobroker/workflows`. Canonical architecture lives in the plan repo:
> `../../../AutoBroker-dev-plan/architecture/ARCH_PROVIDER_ROUTER.md`,
> `ARCH_STRUCTURED_OUTPUT.md`, and the foundation phase
> `../../../AutoBroker-dev-plan/phases/PHASE_0_foundation.md`.

Layer 2 (`model`) is the only layer that imports the AI SDK
(`ai`, `@ai-sdk/*`). It depends on Layer 1 (`@autobroker/core`) and **must not**
import `workflows` / `tools` / `app`.

```
core → model → workflows → tools → app
```

## What lives here

| File | Owns |
| --- | --- |
| `src/registry.ts` | `createProviderRegistry({ deepseek, anthropic, openai })` with `customProvider` tier aliases; `resolveModel(alias)` |
| `src/policy.ts` | `policy(useCase) → { alias, provider, capabilities }` — workflows name only a `useCase` |
| `src/harness.ts` | `harness.generate({ useCase, schema, prompt, hitlAvailable })` — provider-neutral structured generation; the api-key lane owns the tool loop here |
| `src/malformedToolCall.ts` | the **#1244 fail-closed** malformed-tool-call detector (`detectMalformedToolCall`, `assertToolTurnOrFailClosed`, `MalformedToolCallAbort`) |
| `src/index.ts` | the public re-export surface |

## Provider policy (2026-06-02 override)

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

## The api-key lane owns the tool loop

`harness.generate` is the single structured-output chokepoint. On the **api-key
lane** the AI SDK owns the agentic tool loop, so `needsApproval` / `stopWhen` /
`Output.*` fire natively and the in-process gate handler (tools layer) is the
only path to side effects. Subscription / CLI-spawn lanes do **not** fire the AI
SDK tool loop (T1); they are an optional lane whose gate routes through the
in-process handler instead.

## Structured-output strategy

Driven by `CapabilityFlags.supportsOutputObjectWithTools`:

- **DeepSeek (`false`)** — never mix `Output.object` with `tools` (per-step
  `json_schema` injection provokes the #1244 text-dump). Use the single
  `emit_result` tool (Zod-validated in-process) **or** a two-phase pipeline
  (tools-only loop, then a separate no-tools `generateText` + `Output.object`).
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
- Under HITL: **suspend** (`reason: "malformed_tool_call"`).
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
`@ai-sdk/openai`, `@ai-sdk/deepseek`. The concrete model ids in `registry.ts`
are `TODO` placeholders to be pinned against each provider's catalog before
Phase 1 live runs.
