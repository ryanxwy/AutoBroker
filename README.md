# AutoBroker

Local-first, provider-agnostic new-car quote pipeline. AutoBroker discovers
dealers, pulls real dealer email/web quotes, audits the numbers, and helps you
negotiate — driven by 17 LLM-backed skills with deterministic code doing the
load-bearing work and humans approving anything irreversible.

This repository is the **full-TypeScript rebuild** of AutoBroker. It is built
from the ground up, one skill at a time in dependency × risk order, against the
frozen legacy Python implementation (`../AutoBroker-Python`) as a read-only
parity oracle. Mastra 1.x owns orchestration and durable workflow state, AI
SDK 6 is the provider layer, and React/Vite is the local UI surface before the
optional Electron shell.

---

## Privacy — read before configuring providers

**The default LLM provider is DeepSeek (`api.deepseek.com`).** DeepSeek is also
the agent that runs AutoBroker's live test harness against the real corpus.

Per DeepSeek's privacy policy, **your inputs, prompts, and uploaded files are
stored on servers in the People's Republic of China (PRC) and may be used to
train DeepSeek's models.** AutoBroker's core job is to read your **private Gmail
content and dealer PII** — dealer replies are passed verbatim to the model when
extracting quotes. With the default provider, that sensitive content is routed
to, stored in, and potentially trained on inside the PRC.

If you do not accept this, do not use the default. Instead set one of the other
two first-class providers:

- `ANTHROPIC_API_KEY` — route LLM calls to Anthropic (Claude).
- `OPENAI_API_KEY` — route LLM calls to OpenAI.

All three providers (DeepSeek, Anthropic, OpenAI) are first-class and
switchable. Provider selection is policy-driven (`useCase → ModelAlias`); you do
not edit workflow code to change providers — set the corresponding key and the
provider registry routes there.

---

## Quickstart

```bash
pnpm install
cp .env.example .env
# Edit .env: set DEEPSEEK_API_KEY (default) OR ANTHROPIC_API_KEY / OPENAI_API_KEY.
# Read the Privacy section above first.

pnpm typecheck     # tsc --build across the workspace
pnpm test          # vitest
```

Parity-period data (cold-copied product SQLite DB, Mastra runtime DB, logs,
config) lives under `~/.autobroker-ts/`, isolated from the legacy Python repo's
`~/.autobroker/`.

---

## Architecture — the five layers

A pnpm monorepo with a strict **one-way** dependency wall, enforced by TS
project references. Frameworks stay in their owning layer: `core` remains pure
contracts, `model` owns provider adaptation, `workflows` owns Mastra
orchestration, `tools` owns all side effects, and `app` owns HTTP/UI shells.

| Layer | Package | Owns | May import frameworks? |
| --- | --- | --- | --- |
| 1. core | `packages/core` | Pure TYPES + Zod schemas (`DealerQuote`, `AuditFlag`, `SearchProfile`, `CapabilityFlags`, `ModelAlias`, run-status projections) | **No** — AI SDK / Mastra / Drizzle / Playwright are invisible here |
| 2. model | `packages/model` | AI SDK 6 provider layer: registry (`deepseek`, `anthropic`, `openai`), `policy(useCase->alias)`, `resolveModel(alias)`, canonical-message translation, #1244 fail-closed detector/processor helpers | AI SDK 6 |
| 3. workflows | `packages/workflows` | Mastra 1.x backbone: one flat `createWorkflow` per skill, Memory-thread/session integration, OM chat-lane compacting, durable suspend/resume projection, L2 gate orchestration | Mastra |
| 4. tools | `packages/tools` | Gmail, browser (Playwright-native), product DB writes, calc/validators. **Only this layer touches the product DB or external APIs.** Mutating actions wear a code-level approval wrapper | Playwright, googleapis |
| 5. app | `apps/server`, `apps/ui`, `apps/desktop` | Backend HTTP + SSE skill-run stream; React/Vite + AI SDK UI chat rail; Electron shell (Phase 6 optional placeholder) | HTTP framework TBD in Phase 0, React, Electron |

Supporting packages: `packages/db` (Drizzle schema + better-sqlite3,
`drizzle-kit pull` baseline, `test_run_records` ledger; Mastra state lives in a
separate `mastra.db`), `packages/skills` (the 17 skill definitions).

**`ai` is pinned to `^6`** deliberately — v7's `LanguageModelV4` spec would
break V3-spec community providers. On the backend, AI SDK 6 is the provider
adapter (`createProviderRegistry` -> `LanguageModel` -> Mastra agent), not the
workflow engine. On the frontend, AI SDK UI remains first-class for the chat
rail and message streaming.

### Safety, in one line

Side effects can physically reach `browser.submit` / `gmail.send` **only**
through the L2 in-process gate handler, which fails **closed**. The
`AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS=1` env fuse is a redundant outer ring, not
the only floor. The three irreversible skills stay fake-send until their phase
passes, and their human approval is never hidden. See `CLAUDE.md` for the full
invariant set.

---

## Legacy parity

The legacy Python implementation is frozen at **`../AutoBroker-Python`** and is
read-only until all 17 skills reach parity-GREEN, at which point AutoBroker (TS)
takes over and the Python repo retires.
