# harness/soak/ — the agentic-soak lane

> **`pnpm soak` is a SEPARATE lane. It NEVER enters `green.sh`/`ui:functional`/CI.**
> It is local/owner-run by nature (Keychain OAuth + subscription rate limits).

The soak is the **discovery engine**; the `*.toml` corpus is the **gate**. It
layers an agentic discovery loop on top of the EXISTING harness substrate
(serverHost boot, `uiDriver` DOM verbs, `dbReads`, `evaluator` semantics) — it
reuses them, it does not fork them.

## The layered randomness model

| Layer | What | How |
|---|---|---|
| **scenario** | the edge class (cold_start_phrasing, gate_decline_path, …) | DETERMINISTIC, version-controlled (`scenarios/*.toml`) |
| **phrasing** | the freeform/dealer text | AGENTIC (the claude buyer/dealer GENERATE it) |
| **execution** | the per-scenario run | ISOLATED (`AUTOBROKER_DATA_DIR` under `~/.autobroker-ts/soak-runs/<ts>/`, L1 fuse armed, AUTO_APPROVE absent) |
| **verdict** | pass/fail | HYBRID (deterministic DB/state assertions are authoritative; Opus judge rules only the soft dims) |
| **freeze** | a discovered failure → a regression | DETERMINISTIC (minimize the input, emit a fixed `*.ui_*.toml`) |

## The OAuth mechanism (no api key)

`claudeAgent.ts` shells `claude -p --output-format json --model <model>` in a
child env with EVERY provider api-key var DELETED
(`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`/`DEEPSEEK_API_KEY`/`OPENAI_API_KEY`),
so the CLI falls back to the machine's logged-in Claude **subscription**
(Keychain OAuth) — **no per-call api cost**. Three probe findings the wrapper
honors (probed live 2026-06-15):

1. `--output-format json` returns a **stream ARRAY** `[system, assistant…,
   rate_limit_event?, result]` — the generated text + `session_id` +
   `total_cost_usd` live on the `type:"result"` element. `parseClaudeStreamJson`
   walks the array; a naive single-object parse yields `undefined`.
2. throughput is gated by subscription **rate limits**, not per-call dollars (a
   trivial call ~50s; a `rate_limit_event` may appear). The wrapper surfaces
   `rateLimited`; the CLI paces scenarios **sequentially**.
3. the lane is **local/owner-run** — it inherits whatever subscription the
   machine is logged into. Never headless cron/CI.

The CLI refuses to start (`assertOauthOnly`) if any api key is present in the
PARENT env, so a mis-set key surfaces rather than burning credits.

## The single-browser story

The buyer/dealer claude children **EMIT text only** — they never drive a browser.
The **orchestrator owns the ONE pinned `UiDriver`**: it types the buyer's text
into the chat rail, launches subsequent skills via `/slash`, and answers every
HITL gate via the gate-BUTTON verbs (`clickApprovalApprove/Deny`,
batch/inbox/hygiene select/submit/decline, `pickProfileStopOption`, reset
confirm/cancel) — **never a chat-text answer to a gate**. One pinned session =
one thread = one profile (the session-consistency invariant).

## Subcommands

```
pnpm soak list                          # print the loaded taxonomy (coverage)
pnpm soak run   --scenario <id>         # drive one scenario end-to-end
pnpm soak suite [--class <className>]   # iterate the taxonomy (a class, or all)
pnpm soak freeze --ledger <ledger.jsonl> [--row <i>]   # minimize + emit a corpus case
```

`--headed` opens a visible browser. Each run writes a replayable `ledger.jsonl`
(scenario id + the EXACT generated text + its sha256 hash + claude session id +
pipeline trace + the hybrid verdict) under `~/.autobroker-ts/soak-runs/<ts>/`.

## Hard rule

The soak NEVER enters `green.sh`. Only DETERMINISTIC failures freeze a corpus
case; a judge-dim flip is surfaced for owner review, never auto-frozen.
