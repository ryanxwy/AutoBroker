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
                      #   NOTE: green.sh SKIPS this by default — run
                      #   `RUN_UI_FUNCTIONAL=1 bash scripts/green.sh` before pushing
                      #   UI/testid/harness changes, or CI goes red despite local green.
pnpm lint:deps        # enforces the five-layer one-way dependency rule (below)
pnpm check:strings    # enforces the forbidden-strings ban (no stale AutoBroker-* names)
```

## Desktop app (`apps/desktop`) — install & auto-fresh

Two one-time commands bootstrap the installed desktop app:

```bash
pnpm desktop:install          # build + install /Applications/AutoBroker.app
pnpm desktop:hooks:install    # arm git hooks that pre-warm rebuilds on commit/merge/checkout
```

**Freshness is eventually-consistent, not instantaneous.** The installed app always
boots immediately on the last-installed build and converges to the current build within
seconds via a non-blocking "Update ready — Relaunch" notification. An uncommitted edit
is fresh only after the background build completes (not on the very first open after the
edit); committed-while-closed edits are fresh on the next launch.

The packaged launch-time check (`apps/desktop/src/main.ts` + `launchFreshness.ts`, gated
on `app.isPackaged`) always SURFACES staleness and CONSUMES an already-built staged build —
that staged-consumption needs no build step and is the real guarantee. BUILDING a
not-yet-built edit (e.g. an uncommitted change) is the part that needs a terminal-context
PATH: the background `node`/`pnpm` build only runs when triggered from a terminal context —
the git hook on a terminal commit, or an app launched from a terminal. A Finder/launchd
launch has a minimal PATH with no `node`, so its background build fails soft (the app still
boots and still consumes any build that is already staged).

**Kill switch:** `AUTOBROKER_DESKTOP_REFRESH=0` disables the auto-rebuild.

**Scope:** macOS-only; requires `mac.identity: null` (unsigned local build). The stamp
marker lives outside the `.app` bundle (`~/.autobroker-ts/desktop-refresh/<hash>.json`),
so a copied or shipped `.app` is a normal frozen build with no self-rebuild. Only the
checkout where `desktop:hooks:install` ran warms `/Applications`; other worktrees are
inert.

**Safety unchanged:** send-mode stays buyer-by-default, the in-app TopBar toggle is
authoritative, the refresh build performs no sends, and the relaunch is env-clean.

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
  `resolveModel(alias)`, and the #1244 fail-closed detector/Processor helpers.
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

**Send mode (authoritative, 2026-06-22): AutoBroker is REAL-SEND-BY-DEFAULT.** A
single user-facing variable `AUTOBROKER_MODE` (`buyer` | `test`, default `buyer`,
toggled in the TopBar) controls all external sending. `buyer` = the real product
(real Gmail send + real dealer web-form submit + real LLM); `test` = internal/safe
(fake mailbox, no real submit). Every test/harness/CI lane is forced to `test`
**fail-closed** — the `AUTOBROKER_HARNESS=1` sentinel + `isHarnessContext()` +
`assertTestModeSafe()` tripwire in boot + the preflight gate + a no-clobber on
`loadEnvConfigIntoEnv` mean a test can NEVER reach a real dealer. The **L2
in-process human-approval gate is the always-on load-bearing floor**: even in
`buyer` mode nothing sends without a per-action human approval; `buyer` only makes
the REAL adapter the target. This supersedes the old "fake-send until Phase 5" /
"real email is never sent" posture historically described below.

1. **`no_external_mutation` applies to every step in `test` mode** (it is what
   every harness lane asserts). In `buyer` mode real sends DO occur — but ONLY
   through the single L2 gate, one human-approved action at a time; there is still
   no un-approved, un-gated outbound path.
2. **Side effects can physically reach `browser.submit` / `gmail.send` only
   through the L2 in-process gate handler**, which fails **closed**. There is no
   second code path to a side effect.
3. **Gate stack (top → bottom):** L3 native Mastra tool/step approval or
   `suspend()` (convenience, api-key lane only) → **L2 in-process gate,
   load-bearing, fail-CLOSED, single structured path** (the always-on
   human-approval floor in BOTH modes) → fallback-suspend. The send floor is the
   per-seam `!isBuyerMode()` mode brake (`AUTOBROKER_MODE=test` resolves every
   send fake/local), independently re-asserted at each network boundary and
   force-pinned for all test/CI contexts by `forceTestMode()`+`assertTestModeSafe()`.
   **`AUTOBROKER_MODE` is the SOLE send-control variable** — `AUTOBROKER_GMAIL_BACKEND`
   and the L1 `AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS` fuse are **removed** (both
   added to the `check:strings` forbidden list so neither can be re-introduced).
   **Honest floor:** this narrows the env floor from two independent rings to ONE
   env var plus the always-on L2 human-approval gate. A mistyped/garbage MODE
   resolves buyer-capable (anything but the exact string `test` is buyer) and is
   caught **only** by the L2 human-approval gate — there is no second env ring.
   Invariant #2 (side effects reach a seam only through the L2 gate, fail-closed)
   is unchanged and still true.
4. **#1244 fail-closed.** Live-probed 2026-06-04 (107 controlled calls): pure
   tool loops are clean (0/56); the trigger is mixing structured output
   (`response_format`/json_schema) with tools — 27/36 silent tool-skip, 2/36
   plain-text dump. Detection and handling unchanged: on `finish_reason !=
   tool_calls` OR empty `tool_calls` OR tool-shaped blob in content → fail
   **closed** through the Mastra output Processor / post-step detector path:
   under HITL suspend and ask; with no HITL, hard-abort with a typed
   `MalformedToolCallAbort`. **Never** regex a function name out of content and
   execute it. fail-open == silent-fallback. **Bounded recovery (additive — never
   weakens this floor):** the **no-HITL** lane of opt-in heavy extractors
   (`geosearch_extract`/`inventory_extract`/`incentive_extract`/`lead_form_map` +
   the original `dealer_reply_extract`) retries the malformed class EXACTLY ONCE on
   the same-provider v4-pro+thinking lane (shared `recoverEmitWithRetry`: a fresh
   generation over the ORIGINAL prompt, `provider==='deepseek'`-asserted, per-run
   budget-capped, high-precision-signal-gated — never `retry:true` /
   `experimental_repairToolCall` / regex-execute) before the identical hard-abort;
   HITL stays suspend-first (recovery never fires under HITL). Every malformed trip
   is recorded into `test_run_records` with a truncated, budget/PII-redacted sample
   (inv #9).
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
7. **Real email is sent in `buyer` mode** (real-send-by-default), always behind
   the L2 human-approval gate, one recipient at a time. In `test` mode it is local
   fake-mailbox DB rows only, behind the fail-closed `fake_mailbox_send_only`
   preflight. Email-pipeline skills still validate against the fixed real-dealer
   corpus (fixed input, not fixed LLM trace) in the `test`-mode harness lane.
8. **The 3 irreversible mutation skills** (`dealer_web_lead_submit`,
   `negotiation_followup`, `dealer_closeout_email`) really send in `buyer` mode and
   fake-send in `test` mode — via the SAME `AUTOBROKER_MODE` switch as every other
   send; there is no separate per-skill flag and no Phase-5/legal gate. Their human
   approval is **never hidden** on any surface, and `dealer_web_lead_submit`'s
   `email_fallback` scope switch (browser.submit → gmail.send) must force a suspend
   re-confirm.
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

## Product behavior rules (owner-directed, 2026-06-23)

These are durable product rules, distinct from the safety invariants above:

1. **Intake never assumes a required vehicle field.** `model`, `trim`, and `year`
   (all required) must come from the buyer explicitly. Freeform prefill seeds only
   fields the buyer actually stated (nulls are dropped, never a fabricated default —
   `intakeContracts.ts` `IntakePrefillSchema`); the form blocks submit until every
   required field is filled (`SchemaForm`/`formModel`). When a field is missing,
   ASK and WAIT — do not guess a trim/year/model to be helpful. (PII fields
   email/phone/budget stay excluded from prefill — inv #9.) **Trim-suggestion
   helper (freeform only):** when a freeform launch gives make+model+year but no
   trim, the intake `trimSuggestion` step WEB-LOOKS-UP the real trim lineup
   (`tools` `fetchTrimSources` — allowlisted hosts, SSRF-gated) and the LLM extracts
   it (`intake_trim_lookup`, grounded "only trims in the source text"), then SUSPENDS
   a `gate-trim-suggestion` picker. The buyer PICKS one (seeds the form only), or
   `skip`s to type it manually, or `decline`s (terminal); every path then ends at
   the unconditional `confirmVehicle` suspend before persist (no
   `trimGrounded`/`trimVerify` skip). This ASSISTS the buyer's explicit choice with real data —
   it never auto-fills (picker starts unselected) and never fabricates; web/LLM
   failure degrades gracefully to the blank-trim form (never blocks intake).
2. **`inventory_site_scan` scans all in-radius dealers by default — no per-dealer
   approval gate.** It is read-only (browses dealer SRPs; never sends/submits), so
   it has no human-approval floor: it auto-scans the full in-radius target set. The
   `batch_review` suspend/gate is removed for site_scan ONLY — the SHARED
   `BatchReviewCard` / `batchReviewResume` seam still gates the three irreversible
   send skills (`dealer_web_lead_submit`, `negotiation_followup`,
   `dealer_closeout_email`) and `inventory_link_scan`; never weaken those.
3. **Chat history stays in one session unless the user changes it on purpose.** The
   chat rail keeps every turn of a session (`streamedSessionRef`, `App.tsx`); only a
   deliberate user action — starting a NEW search (intake forks a new session) or
   explicitly switching sessions — resets it. A non-intake skill run, profile
   hard-delete, and `pipeline_reset` all KEEP the rail history.
4. **`incentive_scrape` always auto-approves new OEM sources — never asks.** Like
   site_scan it is read-only (scrapes public manufacturer incentive pages, writes only
   local `manufacturer_incentives` rows; no send/submit), so its first-encounter
   source-approval suspend is removed — every new source is auto-recorded and scraped.
   SSRF / host-classification / cache gating still run in code. Scoped to the
   `incentive_scrape` workflow; the shared approval card/seam still gates the send skills.
5. **Send-gate transparency: a batch send gate must preview what is sent.** The
   `dealer_web_lead_submit` batch card carries a `summary` (vehicle, buyer email,
   placeholder-phone note — budget NEVER shown, inv #9) so the user sees the minimal
   payload before approving; the dealer list is height-capped + scrollable so the gate
   never swamps the layout. The summary block is opt-in on the shared `BatchReviewCard`.

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
docs-repo daily sync can bucket commits by phase. (The 3 irreversible skills now
really send in `buyer` mode — see the send-mode note under Safety invariants —
so the old `[fake-send]` commit-body marker is retired.)

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

**Definition of done (every task).** Finish each task in this end state, no
exceptions: all work committed and pushed; the work merged into `main` (a no-op
when working directly on `main`, a real merge when a worktree/branch was used);
and the local `main` fast-forwarded so it is **aligned with `origin/main`**
(`git rev-list --left-right --count HEAD...origin/main` reads `0  0`). Never
leave a task with uncommitted/unpushed work, work stranded on a worktree/branch
that never reached `main`, or a local `main` out of sync with the remote. This
is the standing instruction — it supersedes any "don't push/merge without an
explicit go" default. The force-push ban, explicit-path staging, and the
destructive-action approval gates above still apply.

**Closeout is git + docs.** After implementing any code change, invoke the
`landing-changes` skill (`.claude/skills/landing-changes/`) to wrap up: it runs
the git "definition of done" above AND a doc-freshness sweep — find every doc
(this repo's `CLAUDE.md` / `.claude/skills/**` and the plan repo's
`ts-rebuild/**` reports + ADRs + live-status box) that the change made stale, and
strip the stale data/discussion so docs reflect ONLY the latest code. A doc that
contradicts the merged code is an unfinished task, not a finished one.
