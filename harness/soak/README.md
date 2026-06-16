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
pnpm soak e2e   --mode nl|slash [--scenario <id>]   # plan-3 full-journey lane (below)
pnpm soak freeze --ledger <ledger.jsonl> [--row <i>]   # minimize + emit a corpus case
```

`--headed` opens a visible browser. Each run writes a replayable `ledger.jsonl`
(scenario id + the EXACT generated text + its sha256 hash + claude session id +
pipeline trace + the hybrid verdict) under `~/.autobroker-ts/soak-runs/<ts>/`.

## The plan-3 full-journey session-consistency lane (`soak e2e`)

`soak e2e` drives a buyer through the WHOLE pinned-session pipeline (intake →
`dealer_geosearch` → `inventory_site_scan` → `dealer_inbox_check` →
`quote_pipeline`) in ONE pinned browser = one rail = one Mastra Memory thread, and
scores the deterministic session-consistency invariants (INV-1..INV-7 + projection
+ scrape-reap + journey-wide `no_external_mutation` + budget + NL routing-accuracy,
defined in `skills/sessionConsistency.assertions.ts`).

**`--mode` is the core abstraction:**

| mode | how each skill launches | what it stresses |
|---|---|---|
| `nl` | the buyer types **natural language** into the rail → the product router (`POST /api/route`, commit 8863d11) classifies it → the right skill | the real-user path; the journey records the router's `routing.skill_id` per turn → the **routing-accuracy** assertion |
| `slash` | the harness types **`/skill`** into the same rail (App.onSlash → doLaunchSkill, bypassing the router) | the deterministic path; routing-accuracy passes vacuously (the router is not exercised) |

In BOTH modes the cold-start intake is freeform prose (a real cold-start always is)
and **every HITL gate is answered ONLY via gate BUTTONS** (approve/deny, batch /
inbox select+submit/decline, the profile STOP picker) — NEVER a chat-text answer.

```
# the whole sc_* taxonomy in NL mode (the real-user path):
pnpm soak e2e --mode nl

# one class in slash mode (the deterministic path):
pnpm soak e2e --mode slash --scenario sc_happy_path_full_journey

# headed (watch the journey drive a visible browser):
pnpm soak e2e --mode nl --headed
```

### Live-run prerequisites — the DeepSeek-vs-OAuth tension (READ THIS)

The lane mixes TWO model providers and they must be configured DIFFERENTLY:

* the **claude buyer / dealer / judge** need the **Keychain OAuth subscription**
  (no api key) — `claudeAgent.ts` strips every provider api-key var from the child;
* the **SUT skills** (intake prefill, `dealer_reply_extract`) need **DeepSeek**.

`assertOauthOnly` refuses to start if ANY provider api-key var
(`DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
`ANTHROPIC_BASE_URL` / `OPENAI_API_KEY`) is present in the **parent** env — so the
SUT's DeepSeek key **cannot live in an env var**. Two facts resolve the tension:

1. The soak host (`serverHost` → `buildServer` → `boot`) seeds provider keys at
   boot from `loadDotEnvKeys()` **then** `loadSecretsIntoEnv()` (boot.ts:92-93).
2. **`loadSecretsIntoEnv()` reads `keys.json` relative to the run's
   `resolveDataDir()`** — and the soak host runs under an **ISOLATED**
   `AUTOBROKER_DATA_DIR` (`~/.autobroker-ts/soak-runs/<ts>/data`), so the canonical
   `~/.autobroker-ts/settings/keys.json` is **NOT** read (different data dir).

⇒ **The working config: put `DEEPSEEK_API_KEY=...` in a repo-root `.env`.**
`loadDotEnvKeys()` walks UP from cwd (≤5 levels), picks up exactly the four
provider keys, and seeds them into the **child** env at boot — AFTER the parent's
`assertOauthOnly` check ran, so it does NOT trip the OAuth gate (the parent env
stays key-free; the child reads `.env`). This is the legitimate keys.json-style
run that survives `assertOauthOnly`.

```
# .env at the repo root (git-ignored), the SUT's DeepSeek source:
DEEPSEEK_API_KEY=sk-...        # the SUT (intake/extract) reads this via loadDotEnvKeys

# parent shell — NO provider api keys in env (assertOauthOnly enforces this):
unset OPENAI_API_KEY ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL DEEPSEEK_API_KEY

# and: be logged into the Claude subscription (claude -p uses Keychain OAuth)
claude --version              # confirm the CLI is present + logged in

pnpm soak e2e --mode nl --scenario sc_happy_path_full_journey
```

> ⚑ **FLAGGED (do NOT weaken `assertOauthOnly`):** the canonical
> `~/.autobroker-ts/settings/keys.json` is NOT consulted by the isolated host, and
> a `DEEPSEEK_API_KEY` in the parent env is (correctly) rejected by the OAuth gate.
> The ONLY clean DeepSeek source for the live e2e is a repo-root `.env`
> (`loadDotEnvKeys`). If a future operator wants the canonical keys.json instead,
> the right move is to have the orchestrator COPY `keys.json` into the isolated
> data dir's `settings/` before boot — NOT to relax `assertOauthOnly`.

(`AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS=1` is armed automatically and
`AUTOBROKER_TEST_AUTO_APPROVE` is deleted by `buildSoakHostEnv` — never set them.)

## Hard rule

The soak NEVER enters `green.sh`. Only DETERMINISTIC failures freeze a corpus
case; a judge-dim flip is surfaced for owner review, never auto-frozen.
