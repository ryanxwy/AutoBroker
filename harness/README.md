# harness/ — AutoBroker live-LLM harness (implementation)

> Status: BUILT (Phase-0 landed 2026-06-05; M3 framework + intake acceptance
> GREEN). This directory is the **implementation** of the live-LLM harness: it
> boots the real server in an isolated process and scores each skill's
> behaviour against deterministic anchors, live, with no fixtures or replay.

## Roles (five) — `prompts/`

| prompt | model | role |
|---|---|---|
| [`prompts/orchestrator.md`](prompts/orchestrator.md) | **Opus** | owns Browser #1, the per-step loop, the GREEN/RED call |
| [`prompts/driver.md`](prompts/driver.md) | Sonnet | non-technical user on the dashboard chat rail; applies the gate policy |
| [`prompts/monitor.md`](prompts/monitor.md) | Sonnet | read-only verifier; runs the anchor evaluator; writes `verdict.json` |
| [`prompts/dealer.md`](prompts/dealer.md) | Sonnet | multi-round email mode; plays the dealer via the fake mailbox; **zero SUT-shared isolated context** |
| [`prompts/bugfixer.md`](prompts/bugfixer.md) | **Opus** | patches a service / `SKILL.md` / anchor on a Monitor defect flag; never runs a skill or browser |

The harness substrate (these roles) is **independent of the model under test**.
The model under test defaults to **DeepSeek `deepseek-v4-flash`** with the
ratified defaults: thinking ON + `reasoning_effort: "high"`; structured
`emit_result` steps inject per-step `thinking:{type:'disabled'}` + named
tool_choice + `temperature:0` (see `harness-standard/STANDARD.html` in the plan
docs). It runs the **real** corpus with **no tiering** — Anthropic and OpenAI
are first-class switchable api-key providers, and flipping the tested provider
changes a registry string + the `driver_kind` expectation, nothing in the
orchestration model.

## Built

- [x] **`cases/*.toml`** — per-skill case files (skill, narrative profile, gate
      policy, expected anchors, seeded preconditions); two rounds per skill
      (slash + freeform) as independent cells.
- [x] **`evaluator.ts`** — the deterministic anchor checker, 8 anchor kinds:
      `run_status`, `driver_kind`, `browser_activity`, `approval_gate`,
      `table_min_rows`, `no_external_mutation` (keystone, every step),
      `cost_and_time`, and the framework-new `malformed_tool_call`. Writes
      `verdict.json` (+ the vacuous-confirmation guard: L2+ needs ≥1 ui_check).
- [x] **`poller.ts` (gate poller, `deny_all`)** — the test-time approver. Stands
      in for the human at the dashboard; on irreversible steps it denies,
      exercising the decline path. Never `AUTOBROKER_TEST_AUTO_APPROVE`.
- [x] [`export_daily.ts`](export_daily.ts) — unions `test_run_records` across
      the default DB + the day's isolated run DBs and folds case verdicts into
      stable JSON, consumed by an external daily-report generator that reads
      `harness/exports/<date>.json`.

## To be built

- [ ] **`multiround_fake_mailbox`** — the fake-mailbox helper backing the Dealer
      role, with the fail-closed `fake_mailbox_send_only` preflight (positive
      verify FakeGmailAdapter + isolated fake DB + `BLOCK_EXTERNAL_MUTATIONS=1`,
      else `deny_all`). Lands with the Phase-3 email service.

## `soak/` — the agentic-soak lane (`pnpm soak`, NEVER green.sh)

A SEPARATE lane beside the harness: an agentic discovery engine layered on the
SAME substrate (serverHost boot + `uiDriver` DOM verbs + `dbReads` + `evaluator`
semantics). It drives **`claude -p`** (the buyer/dealer/judge roles) against the
machine's logged-in Claude **subscription** — the wrapper strips
`ANTHROPIC_API_KEY`/`DEEPSEEK_API_KEY`/`OPENAI_API_KEY` from the child env so the
CLI uses the **Keychain OAuth** path (no per-call api cost). It is **local /
owner-run by nature** (Keychain OAuth + subscription rate limits) and **never
joins `green.sh`/`ui:functional`/CI** (a one-line comment in `green.sh` guards
against a future edit "helpfully" adding it).

The discovery→freeze→corpus flow: the soak DISCOVERS (the claude buyer GENERATES
freeform phrasing under a fixed, version-controlled scenario class; the
orchestrator types it + drives the gate BUTTONS); a HYBRID verdict scores it
(deterministic DB/state assertions over `dbReads` are authoritative; an Opus
LLM-judge rules only the soft dims); on a deterministic failure `freezeToCorpus`
MINIMIZES the input + emits a fixed `*.ui_*.toml` in the `cases.ts` grammar — and
that frozen case is then a deterministic regression `pnpm harness` runs. **The
soak discovers; the `*.toml` corpus is the gate.**

Layout (`harness/soak/`): `claudeAgent.ts` (the OAuth spawn wrapper + stream-array
parser), `taxonomy.ts` + `scenarios/*.toml` (the enumerable edge-class list),
`orchestrator.ts` (the per-scenario drive loop — owns the ONE pinned browser),
`verdict.ts` (the hybrid deterministic-assertion lib + Opus-judge wrapper),
`ledger.ts` (the replayable run-ledger), `freezeToCorpus.ts` (the minimizer +
emitter), `cli.ts` (`run`/`suite`/`freeze`/`list`). Roles: `prompts/buyer.md`,
`prompts/judge.md`, and `prompts/dealer.md`'s soak-mode section.

## Safety (frozen invariants — never relaxed)

- `no_external_mutation` is the non-negotiable keystone, checked on **every**
  step.
- Irreversible actions **fail-closed** — a missing/malformed tool call (#1244)
  never falls back to prose, never regex-extracts a function name from content.
- Never touch the production `~/.autobroker/`; runs use an isolated throwaway DB.
- Never set `AUTOBROKER_TEST_AUTO_APPROVE`.
- Mode-A orchestration uses explicit harness framing — never a bare prompt.
