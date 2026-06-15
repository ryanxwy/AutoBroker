# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in **this** repository.

## What this repo is

This **is AutoBroker (TS)** — the full-TypeScript rebuild of AutoBroker, a
local-first, provider-agnostic new-car quote pipeline built around 17 skills.

Naming (authoritative, 2026-06-03):

- **AutoBroker** — this repo (`~/vscode/AutoBroker/AutoBroker`), the runnable
  full-TS code, `source-of-truth`. Git branch `main`.
- **AutoBroker-Python** — the legacy Python repo
  (`~/vscode/AutoBroker/AutoBroker-Python`). **FROZEN, read-only parity
  oracle.** No new features land there. Cold-copy its SQLite (copy-not-share)
  for parity; never share-write it. Retires only after all 17 skills are
  parity-GREEN and the single-point flip happens.
- **AutoBroker-dev-plan** — the docs/plan repo
  (`~/vscode/AutoBroker/AutoBroker-dev-plan`), `source-of-intent`.

Never write the stale strings `AutoBroker-ts` or `AutoBroker-legacy-py`. The
parity-period data dir is `~/.autobroker-ts/` (isolated from legacy
`~/.autobroker/`), set via `AUTOBROKER_DATA_DIR`.

## Build, test, typecheck

```bash
pnpm install
pnpm typecheck        # tsc --build (honors project references)
pnpm test             # vitest run
pnpm db:pull          # drizzle-kit pull — introspect schema baseline
pnpm db:generate      # drizzle-kit generate — CI gate must be empty-diff
pnpm harness          # live-harness runner (real provider; *.ui_*.toml = live UI lane)
bash scripts/green.sh # THE single pass/fail gate (typecheck + harness typecheck +
                      #   lint:deps + check:strings + db:check + test) — Stop-hook & CI ask this
pnpm ui:functional    # deterministic UI-lane gate: runs harness/cases/*.func.toml
                      #   against seeded fixtures (no provider call). Live-LLM UI
                      #   acceptance is the *.ui_*.toml cases via `pnpm harness`.
pnpm lint:deps        # enforces the five-layer one-way dependency rule (below)
pnpm check:strings    # enforces the forbidden-strings ban (no stale AutoBroker-* names)
```

## Five-layer one-way dependency rule

A pnpm monorepo with a strict one-way ownership wall, enforced by TS project
references in `tsconfig.base.json` and per-package `tsconfig.json` files.
Frameworks stay in their owning layer: `core` stays pure, `model` adapts
providers, `workflows` orchestrates, `tools` owns side effects, and `app` owns
HTTP/UI shells. Treat any new cross-layer reference not already encoded in a
package `tsconfig.json` as an architecture change, not a casual import.

```
core  ->  model  ->  workflows  ->  tools  ->  app
```

- `packages/core` — pure TYPES + Zod schemas. **Imports no framework** (AI SDK,
  Mastra, Drizzle, Playwright must be invisible here).
- `packages/model` — AI SDK 6 provider layer: `createProviderRegistry({deepseek,
  anthropic, openai})`, `policy(useCase→ModelAlias→CapabilityFlags)`,
  `resolveModel(alias)`, canonical-message ↔ ModelMessage translation, and the
  #1244 fail-closed detector/Processor helpers.
- `packages/workflows` — Mastra 1.x backbone: each skill is a flat linear
  `createWorkflow`; sessions use Mastra Memory threads/resources plus OM
  auto-compact on the chat lane; durable `suspend()` / resume and app-side
  status projection replace the old self-built `SkillRun` seam in Phase 0.
- `packages/tools` — Gmail, browser (Playwright-native), DB writes, calc /
  validators. Mutating actions wear a code-level approval wrapper.
- `apps/server`, `apps/ui`, `apps/desktop` — backend HTTP + SSE, React/Vite +
  AI SDK UI chat rail, and the optional Electron shell (Phase 6).

Supporting: `packages/db` (Drizzle + better-sqlite3 product DB,
`test_run_records`; Mastra runtime state lives beside it in a dedicated
`mastra.db`), `packages/skills` (the 17 skill defs).

## The SQLite / external-API invariant

**Only `packages/tools` (and the services within it) may touch the product DB or
call external APIs.** Routes, CLI, workflows, and model code must delegate down
into tools — they never open the product DB connection or call Gmail/Maps/an
LLM-mutation endpoint directly. Mastra may persist framework runtime state to
its own `mastra.db` in the same data dir, but those tables are not part of the
product schema or parity gate. This mirrors the legacy rule "only the services
layer touches SQLite or external I/O" while carving out Mastra's runtime store.

## Provider policy (no tiering)

- **DeepSeek is the DEFAULT api-key provider AND the live-harness test agent.**
  It runs the real harness tests on the real corpus. There is **no per-provider
  L1–L5 tiering**, no sanitized/synthetic/ZDR precondition gate, no
  "DeepSeek-optional / behind-a-privacy-gate" framing.
- Privacy is handled by an **upfront disclosure in the README** (DeepSeek stores
  inputs/prompts/uploaded files in the PRC and may train on them). Users who
  mind switch to a Western provider.
- **Anthropic and OpenAI are also first-class, switchable api-key providers.**
  Support all three. Provider selection is policy-driven (`useCase →
  ModelAlias`); workflows never hardcode a provider name. Swapping a provider is
  a registry-string change, not a workflow edit.
- The api-key lane is the keystone: AI SDK 6 supplies `LanguageModel` instances
  to Mastra agents, while Mastra owns the agent loop, workflow snapshots, and
  durable suspend/resume. Native Mastra tool/step approval is a convenience
  layer only; the L2 in-process gate is still load-bearing. Subscription OAuth
  CLI-spawn lanes remain optional; on those the api-key loop does not fire, so
  the gate must live in the in-process MCP handler.

## Safety invariants (load-bearing — do not weaken)

1. **`no_external_mutation` is non-negotiable and applies to every step.** No
   submitted-lead row, no real Gmail-send tool event, no non-fake outbound row.
2. **Side effects can physically reach `browser.submit` / `gmail.send` only
   through the L2 in-process gate handler**, which fails **closed**. There is no
   second code path to a side effect.
3. **Gate stack (top → bottom):** L3 native Mastra tool/step approval or
   `suspend()` (convenience, api-key lane only) → **L2 in-process gate,
   load-bearing, fail-CLOSED, single structured path** → fallback-suspend → L1
   `AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS=1` fuse (redundant outer ring, always
   armed, never the only floor).
4. **#1244 fail-closed.** Live-probed 2026-06-04 (107 controlled calls): pure
   tool loops are clean (0/56); the trigger is mixing structured output
   (`response_format`/json_schema) with tools — 27/36 silent tool-skip, 2/36
   plain-text dump. Detection and handling unchanged: on `finish_reason !=
   tool_calls` OR empty `tool_calls` OR tool-shaped blob in content → fail
   **closed** through the Mastra output Processor / post-step detector path:
   under HITL suspend and ask; with no HITL, hard-abort with a typed
   `MalformedToolCallAbort`. **Never** regex a function name out of content and
   execute it. fail-open == silent-fallback.
5. **Structured output:** never mix structured object output + tools in the same
   DeepSeek model step (per-step json_schema injection triggers the #1244 text
   dump). Use a single `emit_result` tool with a Zod schema, or a two-phase
   pipeline (tools-only loop + separate no-tools structured call). Always add
   Zod post-validation. Keep schemas flat, all-required with explicit null,
   prefer enums, lowest common JSON-Schema subset.
6. **profile-ASK three-branch contract.** Every skill acts on one profile. If
   none resolves, ASK first — never silently pick newest-active. (exactly 1 →
   run; 0 → STOP, point to intake; 2+ → STOP, ask by vehicle name). Return a
   typed result distinguishing `pinned` vs `inferred-newest`; log every inferred
   resolution. Re-test the 1/0/2-active branches in the TS resolver — do not
   assume closed. Do not build a global `AUTOBROKER_STRICT_PROFILE_PIN`.
7. **Real email is never sent.** Email-pipeline skills validate against fixed
   real-dealer corpus (fixed input, not fixed LLM trace); multi-round is local
   fake-mailbox DB rows only, behind a fail-closed `fake_mailbox_send_only`
   preflight.
8. **The 3 irreversible mutation skills** (`dealer_web_lead_submit`,
   `negotiation_followup`, `dealer_closeout_email`) stay **fake-send** until
   Phase 5 is GREEN, their human approval is **never hidden** on any surface, and
   `dealer_web_lead_submit`'s `email_fallback` scope switch (browser.submit →
   gmail.send) must force a suspend re-confirm.
9. **Communication never includes budget** (`_redact_budget`, enforced in code).
   **Fake phone by default** unless the user explicitly opts in. Hard
   constraints live in code, not in prompt text or sampling temperature.
10. **Destructive skills**: `pipeline_reset` forces a typed-YES second-confirm
    suspend; `dealer_hygiene`'s second confirm is three strictly-ordered
    per-item batch-review suspends (5a/5b/5c, the parity-oracle shape —
    decline/cancel at any stage = zero writes; batch default action is explicit
    selection, never approve-all). Either way: no confirmation → zero
    destruction.
11. **Never touch a production DB.** Use an isolated throwaway DB
    (`AUTOBROKER_DATA_DIR`). **Never** set `AUTOBROKER_TEST_AUTO_APPROVE` — keep
    the approval gate live to exercise the decline path.
12. **Fallback classification:** semantic / irreversible fallbacks (prose-vs-typed
    gate, newest-vs-pinned profile, email_fallback scope switch) → suspend → ask
    through the gate. Transient / equivalent fallbacks (attachment primary →
    backup, JS → snapshot, native-vision → OCR) → auto-allow but record a trace
    span. Every fallback must be voiced; the gate renders before the prose.

## One skill, one commit

Build skills one at a time in dependency × risk order, revised 2026-06-03 to
browser-first: deterministic/read-only + intake → browser service + scans →
email service + LLM extraction → orchestration/report → irreversible send. Each
skill follows the 7-step loop (define contract → build deterministic tools + L1
→ scaffold the flat Mastra `createWorkflow` + bind `harness.generate`/model
policy → map fallback gating → DeepSeek live → cross-provider smoke →
acceptance ledger), and the acceptance step is **one commit per skill**.
Move to the next skill only after the DeepSeek-live step (step 5) is green.

Commit message prefix: **`phaseN/<skill>:`** (e.g. `phase1/quote_audit:`), so the
docs-repo daily sync can bucket commits by phase. For the 3 irreversible skills,
mark the commit body `[fake-send]` until Phase 5 acceptance is GREEN.

## Sync contract with `../AutoBroker-dev-plan`

- Two-repo, one-way: the plan repo (`AutoBroker-dev-plan`) is source-of-intent
  (hand-curated HTML canonical, no build toolchain; Markdown/helper files are
  secondary where present); **this** repo is source-of-truth (runnable TS). The
  plan repo never writes into this repo, and this repo never holds long-form
  plan prose NOR design docs — **all design docs / ADRs live in the plan repo**
  (`AutoBroker-dev-plan/ts-rebuild/architecture/`); the long-range phase order
  and harness standard live there too.
- The plan repo's `tools/new-day.sh` reads this repo's git log (bucketing by the
  `phaseN/<skill>:` prefix and the touched monorepo layer) plus the
  `test_run_records` harness export to fill its daily HTML report. Keep commit
  prefixes and the ledger export stable so that sync stays mechanical.
- "Handy improvements" go to the plan repo's post-parity backlog
  (`architecture/BACKLOG.md`), not into this repo out of scope and not into the
  frozen Python repo.

## Git workflow

Solo project. Work on `main`; no feature branches or PRs by default. Stage
explicit paths, leave unrelated worktree changes alone, never force-push. Keep
destructive/irreversible external actions behind the approval rules above.
