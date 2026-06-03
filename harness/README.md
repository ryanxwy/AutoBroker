# harness/ — AutoBroker live-LLM harness (implementation)

> Status: Phase 0 (foundation) · 2026-06-02 · SCAFFOLD. This directory is the
> code-repo **implementation** of the live-LLM harness. The canonical
> specification lives in the plan repo at
> [`../../AutoBroker-dev-plan/ts-rebuild/harness-standard/`](../../AutoBroker-dev-plan/ts-rebuild/harness-standard/)
> (STANDARD / ANCHORS / TEST_LAYERS / INVARIANTS / VERDICTS / CORPUS). Where code
> and standard disagree, fix one to match the other — do not let them drift.

This directory **mirrors** the plan repo's `harness-standard/`. The standard says
what to build; this is where it gets built.

## Roles (five) — `prompts/`

| prompt | model | role |
|---|---|---|
| [`prompts/orchestrator.md`](prompts/orchestrator.md) | **Opus** | owns Browser #1, the per-step loop, the GREEN/RED call |
| [`prompts/driver.md`](prompts/driver.md) | Sonnet | non-technical user on the dashboard chat rail; applies the gate policy |
| [`prompts/monitor.md`](prompts/monitor.md) | Sonnet | read-only verifier; runs the anchor evaluator; writes `verdict.json` |
| [`prompts/dealer.md`](prompts/dealer.md) | Sonnet | multi-round email mode; plays the dealer via the fake mailbox; **zero SUT-shared isolated context** |
| [`prompts/bugfixer.md`](prompts/bugfixer.md) | **Opus** | patches a service / `SKILL.md` / anchor on a Monitor defect flag; never runs a skill or browser |

The harness substrate (these roles) is **independent of the model under test**.
The model under test defaults to **DeepSeek `deepseek-v4-flash`** (non-thinking,
`temperature:0`) and runs the **real** corpus with **no tiering** — Anthropic and
OpenAI are first-class switchable api-key providers, and flipping the tested
provider changes a registry string + the `driver_kind` expectation, nothing in
the orchestration model.

## To be built (TODO — Phase 0)

- [ ] **`cases/*.toml`** — per-skill case files (skill, narrative profile, gate
      policy, expected anchors, seeded preconditions).
- [ ] **`evaluator`** — the deterministic anchor checker for the **6+1 anchors**:
      `run_status`, `driver_kind`, `browser_activity`, `approval_gate`,
      `table_min_rows`, `no_external_mutation` (keystone, every step), plus the
      new `cost_and_time` anchor. Writes `verdict.json`.
- [ ] **`gate_poller` (`deny_all`)** — the test-time approver. Stands in for the
      human at the dashboard; on irreversible steps it denies, exercising the
      decline path. Never `AUTOBROKER_TEST_AUTO_APPROVE`.
- [ ] **`multiround_fake_mailbox`** — the fake-mailbox helper backing the Dealer
      role, with the fail-closed `fake_mailbox_send_only` preflight (positive
      verify FakeGmailAdapter + isolated fake DB + `BLOCK_EXTERNAL_MUTATIONS=1`,
      else `deny_all`).
- [ ] [`export_daily.ts`](export_daily.ts) — exports `test_run_records` for a
      given day to stable JSON (already stubbed), consumed by the plan repo's
      [`../../AutoBroker-dev-plan/ts-rebuild/tools/new-day.sh`](../../AutoBroker-dev-plan/ts-rebuild/tools/new-day.sh).

## Safety (frozen invariants — never relaxed)

- `no_external_mutation` is the non-negotiable keystone, checked on **every**
  step.
- Irreversible actions **fail-closed** — a missing/malformed tool call (#1244)
  never falls back to prose, never regex-extracts a function name from content.
- Never touch the production `~/.autobroker/`; runs use an isolated throwaway DB.
- Never set `AUTOBROKER_TEST_AUTO_APPROVE`.
- Mode-A orchestration uses explicit harness framing — never a bare prompt.

See [`../../AutoBroker-dev-plan/ts-rebuild/harness-standard/INVARIANTS.md`](../../AutoBroker-dev-plan/ts-rebuild/harness-standard/INVARIANTS.md)
for the full set.
