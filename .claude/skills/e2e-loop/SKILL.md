---
name: e2e-loop
description: Run one manually-triggered, live end-to-end pass of the AutoBroker product
  as a real car buyer — drive all 18 skills against the run's live LLM lane (default
  DeepSeek api-key; `--provider claude` = the Claude OAuth subscription lane, the
  official Agent SDK) through serve-live + a Playwright browser, negotiate for real
  against resistant LLM dealers, cross-shop several cars at once, and RECORD every
  blocker / backlog gap / rough edge into an HTML report. The job is to reproduce the
  real buyer experience and expose its imperfections honestly — NOT to ship a perfect
  run. Fixing the recorded issues is the companion `e2e-evolve` skill's job (run it in
  a fresh session). Pass `--light` for a quick read-only sweep. Use to run the live
  e2e / 全技能巡检 on demand.
argument-hint: "[--light] [--provider deepseek|claude]"
disable-model-invocation: true
---

You drive **one live end-to-end pass** of AutoBroker, manually triggered, every time.
You play a **real, non-technical car buyer** going through the whole new-car quote
pipeline. It is heavyweight: it starts a real server, drives a real browser via
Playwright MCP, calls the real LLM provider for the run (DeepSeek API-key by default, or
the Claude OAuth subscription lane under `--provider claude`), and dispatches subagents
(the LLM dealers). Track progress with TodoWrite. cwd = `~/vscode/AutoBroker/AutoBroker`.

## What this skill is for (read this first)

**The deliverable is an honest report, not a green checkmark.** You reproduce the real
buyer journey and **record everything imperfect you hit** — things that blocked the
buyer, real gaps worth fixing, and rough edges. You do **not** try to make the run
perfect, and you do **not** fix most of what you find. A companion skill, **`e2e-evolve`**,
runs later in a fresh session, reads your reports, researches the issues, fixes them,
and improves this very skill so the next run is better on a better product.

The one exception: if a blocker is a **localized safety violation** or an **obvious
one-line fix**, you may fix it in-loop through the small gated path in
`references/recording.md`. Everything else — anything research-heavy, multi-file, or
design-level, **including a multi-file safety stop** — you **record and hand off**. The run
ends with a full report; it does **not** need an empty backlog.

```
 /e2e-loop  (this skill — the RUNNER)        e2e-evolve  (the companion — fresh session)
 ─────────────────────────────────────       ──────────────────────────────────────────
 live the real buyer journey            ──►   read these reports + harvest-register
 record blockers / backlog / polish           research → fix (gated) → merge to main
 fix only safety + one-line blockers           improve THIS skill for the next run
 write the HTML report                  ◄──   write-back lessons
```

## The three buyer use-cases

- **UC1 — single-profile pipeline** (every run): one buyer, one search profile, the full
  pipeline to a negotiated quote — this IS the pinned spine (steps 2–3).
- **UC2 — same vehicle, different metro** (one-time boundary evaluation): the product
  holds one active profile per (account, make) — a second same-make intake trips
  `ActiveSlotConflict` with replace/supersede as the product path. Evaluated ONCE (see
  `references/multi-profile-lane.md` "UC2"), then graduated to the known-correct list;
  NOT an every-run probe.
- **UC3 — same metro, competing models** (portfolio): 3 same-segment different-make
  searches in ONE metro, concurrent, one approval inbox, goal = best quote across the
  options — this IS step 4 (`references/multi-profile-lane.md`).

## Modes

- **Provider lane** (`--provider claude|deepseek`, default `deepseek`): which real LLM
  lane the WHOLE journey runs on. `deepseek` = the DeepSeek API-key lane (lane A, the
  historical default, unchanged). `claude` = the **Claude OAuth subscription** lane (lane
  B, the official Agent SDK) — every one of the 18 skills' LLM calls (extraction / prose /
  routing) routes through it, the same scope as DeepSeek. The runner enforces this by
  exporting `AUTOBROKER_AGENT_PROVIDER=<provider>` into the `serve-live` environment BEFORE
  boot; the server reads it as the default agent selection (the 4-box AgentBar is left
  untouched, so its `agent` payload stays omitted and the env default wins). Record the
  provider/lane the run used at the top of the report, and confirm on a `claude` run that
  `/__e2e/rows`-adjacent ledger rows read `provider: anthropic` / `pricingSource:
  subscription` (not deepseek). Combine with any other mode (e.g. `--light --provider claude`).
- **Full** (bare `/e2e-loop`): the whole journey, steps 0→7 below.
- **Light** (`--light` / "light sweep" / "manual inspection"): a bounded read-only
  inspection — steps **{0, 1 pin-or-bootstrap, 2 two-pass sweep, 5 frontend-taste,
  6 record, 7 teardown}**. Skip the live negotiation (step 3) and cross-shop (step 4).
  Light needs **no fresh worktree/build** — run against the existing checkout's (or an
  already-running) serve-live. If its DB is empty, do a minimal intake first to seed one
  profile (this also exercises intake live). Light still writes a report; it just
  expects fewer findings (a clean read-only sweep may legitimately record zero).
  (`--light` still runs ONE final ui-monitor checkpoint.)
- **Buyer-email probe** (optional, owner-run, separate from serve-live): validates the
  REAL Gmail I/O layer — OAuth/refresh, real MIME parse (incl. HTML-only recovery),
  attachment download, historyId — that the test-mode journey can never reach. It is a
  **standalone script** (`pnpm e2e:buyer-email-probe`), NOT serve-live, NOT in `green.sh`,
  **read-only by construction** (the `ReadOnlyGmailAdapter` facade makes send structurally
  impossible — no env flag, unconditional throw), and never sends anything. Run it by hand
  when you want to confirm the live adapter is healthy after an OAuth or MIME change.
  Findings slot into the three-bucket report under a separate "Buyer-email probe"
  sub-section (not in the 逐技能表). See `references/buyer-email-probe.md`.

## Safety gate (do this first, fail closed)

1. Keys present and Playwright MCP reachable — else **STOP and report**, do not run. The
   LLM credential is **provider-aware**: `--provider deepseek` (default) requires
   `DEEPSEEK_API_KEY`; `--provider claude` requires `CLAUDE_CODE_OAUTH_TOKEN`. Either way
   `GOOGLE_PLACES_API_KEY` is required (geosearch). If the chosen provider's credential is
   absent, **STOP** — do not silently fall back to the other provider.
2. After serve-live launches: confirm the `{"liveE2e":"listening",…,"dataDir":…}` line
   appears within a bounded wait and **record `dataDir`** — else fail closed.
3. After picking the buyer: confirm geosearch returns **≥1 dealer** for the metro (**≥10
   for a full run** — pick a big metro + high-volume car) — else fail closed. An empty
   metro means a misconfigured `location_query` (see the Irvine fallback trap in
   `references/harness-boundaries.md`); do not drive a vacuous sweep.
4. **Lane-took-effect verification:** after the FIRST LLM-bearing skill completes, read
   `test_run_records` in `<dataDir>/autobroker.db` and assert the rows match the
   requested lane (`--provider claude` → `provider='anthropic' AND
   pricing_source='subscription'`; `deepseek` → `provider='deepseek' AND
   pricing_source != 'subscription'` — lane A persists the dated pricing-snapshot
   label, or `'unavailable'` on a usage-missing row, never `'subscription'`).
   Mismatch = **STOP**: a mistyped
   `AUTOBROKER_AGENT_PROVIDER` value silently resolves to the DeepSeek default (exact
   strings `claude`/`deepseek` only), and a whole run on the wrong lane poisons every
   cross-lane conclusion.
   **localStorage-shadow trap (2026-07-04):** the UI persists its reflected agent
   default to `localStorage['autobroker:agent-selection']` and then sends it as each
   run's explicit selection — which SHADOWS the server env default for an existing
   browser profile. Before trusting the lane, CLEAR the key in the driven tab
   (`browser_evaluate` → `localStorage.removeItem('autobroker:agent-selection')`, then
   reload) so the env default wins; a stale key silently splits ground truth (a run
   pinned `anthropic+oauth` while `chat_route` still read `deepseek`) and contaminates
   the FIRST cross-lane diagnosis. Clear it again whenever you flip lanes mid-session.

## The journey

| step | what you do | how you know it worked | load when you reach it |
|---|---|---|---|
| 0 | read the last 1–2 reports, run the safety gate, `touch .claude/.e2e-loop-active` | keys/MCP present; listening line seen | this spine |
| 1 | (full) fresh worktree off `origin/main` + better-sqlite3 rebuild + `pnpm -r build`, then start `pnpm e2e:serve-live`; pick a realistic buyer (metro, car, finance mode, persona) | build OK; `dataDir` recorded; geosearch ≥1 dealer (≥10 full) | `references/harness-boundaries.md`, `references/brand-picker.md`, `references/ui-monitor.md` |
| 2 | live the journey: drive all 18 skills as the buyer — PASS-A in natural language, PASS-B by `/slash` — verifying each skill lands its data AND its UI | terminal skill row + table delta + the right Canvas panel; data-quality coverage (not just a row count) | `references/skill-pipeline.md` (+ `references/ui-lane-personas.md`) |
| 3 | (full) negotiate for real: deep, multi-thread email negotiation against resistant LLM dealers — ≥10 dealers, front-runners driven to ≥4 rounds, with ghosting and manager escalation | front-runner threads reach ≥4 buyer rounds; ghosts drop after 2 unanswered; revised OTDs extracted | `references/dealer-brain.md` |
| 4 | (full) cross-shop: run several searches at once (3 different-brand profiles) on the real scheduler — concurrent negotiation, a shared dealer both want, one shared approval inbox | scheduler cap holds; every profile reaches a terminal state; exactly one profile binds each shared dealer, losers voiced + zero send; no budget leak; nothing sent for real | `references/multi-profile-lane.md` |
| 5 | judge the experience: run `frontend-taste` per data tab | a ranked usability findings list | `references/ui-lane-personas.md` (→ the `frontend-taste` skill by name) |
| 6 | record everything: classify each imperfection (blocker / backlog / polish), capture telemetry, fix only safety + one-line blockers, write the HTML report + harvest-register | report sections present; ledger rebuilt | `references/recording.md` |
| 7 | teardown: kill serve-live, remove the worktree, write the memory pointer, `rm .claude/.e2e-loop-active` | marker gone; memory pointer ≤200c | `references/recording.md` |

**UI-monitor checkpoints** (dispatch per `references/ui-monitor.md`, driver idle): after
step 2 PASS-A · after step 2 PASS-B · after step 3 · after step 4 · at step 5 ·
pre-teardown final. `--light` = exactly ONE final checkpoint.

**Step 4 ordering:** the single pinned-brand journey (steps 2 and 3) runs FIRST and
reaches a terminal, healthy state before cross-shop (step 4) begins. Never run them
concurrently — cross-shop is layered on top of a known-good single-brand pass.

## How to read what you see (the verification ladder)

Trust the surfaces in this order, highest first. A lower rung never overrides a higher
one — a pretty screenshot never beats a missing row; a taste opinion never blocks
anything.

1. **Deterministic counts** — `/__e2e/rows` and `/__e2e/audit` (did the write land? did a
   decline change nothing?), and **data-quality coverage** `/__e2e/dataquality` (is the
   data actually usable?). This is the verdict.
2. **The live DOM** — `browser_evaluate` on the active Canvas panel. Corroboration.
   For the Negotiations board do NOT stop at the grid; `browser_click` a
   `canvas-negotiation-card` and `browser_evaluate` the opened
   `negotiation-detail-modal` sections.
3. **A screenshot** — a report artifact, never a verdict.
4. **`frontend-taste`** — an advisory usability opinion.

**A row count alone never means a data-bearing skill passed.** A scan can write 10
listings whose price is every-one null and still read `count: 10`, identical to 10 good
rows — and a buyer then sees "0 recommendations". For `inventory_site_scan` and
`dealer_reply_extract` the verdict is the **coverage** from `/__e2e/dataquality`, not the
row count. (`references/harness-boundaries.md` has the exact thresholds.)

**Cross-lane triage (the four-exit tree — general rule, both lanes).** A one-lane failure is not a lane
verdict. When ANY skill misbehaves on the run's lane, classify before you blame:

0. Browser-fed 0-yield? Read /__e2e/dataquality `rendered_empty_count` FIRST —
   >0 = host thrash (environment; browse has no LLM in it), no re-run needed.
1. Infra signal (429 / timeout / lane-B subprocess crash / credential)? An
   availability fault, not a product fault — re-run ONCE on the SAME lane to confirm.
   BUT a lane-B `error_max_turns` / `error_max_structured_output_retries` is NOT an
   availability fault — it is a deterministic-ish product/prompt condition (the SDK's
   turn accounting), so it goes to exit 2 (diagnose + record), never a retry-to-green.
   If ONE such error kills a whole batch (0 sends), that whole-batch death is itself a
   blocker (a missing per-thread catch), independent of the underlying call error
   (2026-07-04 B2).
2. Anything else: re-run that ONE skill on the OTHER provider
   (`AUTOBROKER_AGENT_PROVIDER` flipped, fresh dir), AT MOST ONCE, as DIAGNOSIS:
   - fails on BOTH lanes → a general product/environment cause — fix provider-agnostically;
   - fails on ONE lane only → a genuine lane-specific gap — record it with its lane tag
     for `e2e-evolve` (which re-verifies its fix on the SAME lane).

Decoupling invariants: the journey NEVER switches lanes mid-run; a missing credential
is a STOP, never a provider swap; the re-run is a diagnostic, never a retry-to-green.
(Procedure detail + the decisive controlled-extraction test: `references/harness-boundaries.md`.)

## How to classify what you find (three buckets)

Decide each imperfection by two questions, in order:

1. **Did it block the buyer, or break a safety/correctness rule?** → **BLOCKER.**
   The buyer could not get through this step, OR a load-bearing rule was violated:
   - a real send happened in test mode, or the fake adapter did NOT fire on a send;
   - a budget number rendered on any surface;
   - a gate appeared *after* the prose instead of before it;
   - the largest extraction did not fail closed when `emit_result` never fired: the
     blocker is a silent tool-SKIP, a regex-executed tool name, or a fabricated result.
     The correct behavior is a thrown typed error (`EmitResultNotCalledError` /
     `ZodError`) + one ledgered failReason row — never a silent proceed. (There is no
     retry/auto-recover lane; that machinery was deleted 2026-07-03.)
   - **data the pipeline provably held was silently dropped** — a scan wrote rows but the
     price/MSRP coverage is zero, or a dealer emailed an out-the-door number the extractor
     lost (coverage below the healthy bar with no legitimate empty/withheld escape);
   - a decline changed state when it should have changed nothing;
   - a skill dead-ended with no path forward for the buyer.

   Record it with full evidence (skill, route response, screenshot). **Fix it in-loop ONLY
   if it is a localized safety stop or a genuine one-line fix** (`references/recording.md`);
   a multi-file or research-heavy blocker — even a safety one — is recorded and handed to
   `e2e-evolve`.

2. **Was it a real gap that did NOT block the journey?** → **BACKLOG.**
   A correct-but-worse-than-it-should-be outcome: a finance buyer shown only cash
   incentives; scan price-coverage below the healthy bar but not a total loss; a
   same-source attribution ambiguity that did not actually mis-route this run; a missing
   send-preview block; a thin comparison. Record it with evidence **and a falsifiable fix
   idea** (the product change that would close the gap). It goes to the harvest-register
   for `e2e-evolve`.

3. **Otherwise** (correct, just rough) → **POLISH.**
   UX friction, a suboptimal-but-valid outcome, a cosmetic issue. Record it. Lowest
   priority.

**The one hard rule (anti-masking):** a backlog or polish note can NEVER excuse a safety
or data-loss breach. The discriminator is *had-and-lost vs never-had*: if the pipeline
**held** a number and **lost** it, that is a BLOCKER, full stop. You may file a
"low-quote-rate / ghosted dealer" outcome as backlog **only when the data proves no
number was dropped** — i.e. `/__e2e/dataquality` returns its empty escape (nothing was
extractable) or its all-withheld escape (every listing explicitly price-gated). A dealer
who emailed an OTD the extractor dropped is always a blocker, never backlog.

## The verdict

One honest line, no scalar pass/fail:

> **Journey: complete | partial | blocked · Blockers N · Backlog N · Polish N**

A run with N backlog items and a complete journey is a **good run** — that is the engine
working. A full run that records **zero** imperfections is **suspect** (the journey is
LLM-driven against live, resistant dealers — re-examine for under-exercised reality or a
finding you dismissed too quickly). A `--light` read-only sweep may legitimately record
zero. The only thing that makes a journey **blocked** is an unworked safety blocker —
a real send, a budget leak, a gate-after-prose, a silent data loss — which you must
either fix in-loop or, if you cannot, surface at the very top of the report as the run's
headline.

## Guardrails (do not weaken)

- **Test mode, isolated.** serve-live runs with `AUTOBROKER_MODE=test` (the sole
  send-control variable) and a throwaway tmp data-dir. Mode is chosen at boot and is
  immutable for the run — **never** flip it on a running host (a live flip arms a real
  adapter on the next send with no second guard). **Never** set
  `AUTOBROKER_TEST_AUTO_APPROVE` — the decline path must stay live (CLAUDE.md inv #11).
  This holds **identically on both provider lanes**: under `--provider claude` the lane-B
  Agent-SDK subprocess only emits structured data / prose (its built-in tools are
  fail-closed disabled — `allowedTools:[]` + deny-all `canUseTool`) and can never reach a
  send; `browser.submit`/`gmail.send` stay the in-process tools-layer steps behind the L2
  gate + mode brake. A `claude` run consumes **real Pro/Max subscription quota** (the same
  realism-over-cost posture as the DeepSeek live harness).
- **The 3 irreversible skills stay fake-send** (`dealer_web_lead_submit`,
  `negotiation_followup`, `dealer_closeout_email`); gates render before prose; a decline
  changes nothing, proven via `/__e2e/rows` before/after.
- **Seed only through the control routes** (`inject_replies`, `inject_reply_to_thread`,
  `inject_crm_threads`, `inject_contact`) — a SQLite write made underneath the running
  server is invisible to it. `inject_crm_threads` before `dealer_hygiene`; run
  `dealer_closeout_email` second-to-last and `pipeline_reset` last.
- **Budget never renders as a number** anywhere, including a batch summary (inv #9).
- **The 12 CLAUDE.md safety invariants hold every step.** They are the floor; a breach is
  always a blocker (above).
- **Realism over cost.** Spend the LLM calls. A full run mimics the real email quote
  pipeline: ≥10 dealers, a full pre-flight market search, and a deep mutual negotiation
  (`references/dealer-brain.md`). Cross-shopping several cars at once is part of the
  reality, not an extra (`references/multi-profile-lane.md`).
- **Dealers resist — model it, don't over-cooperate.** Most dealers will not email an
  out-the-door number: come-onsite-only, mid-thread ghosting, reverse-inducement. A
  profile can legitimately finish with few or zero email quotes — a valid `ghosted` /
  `cold` outcome, never a fabricated quote, never a failure on its own.
- **Worktree needs `.env`.** `.env` is gitignored, so a fresh worktree has none — copy
  the main checkout's `.env` into the worktree after `git worktree add` (it stays
  gitignored, never staged). Without it the run has no lane credential: lane A reports
  "add your DeepSeek key" and the router 500s; lane B fails closed on every call.
- **Self-contained `YYYY-MM-DD` HTML report**; `MEMORY.md` pointer ≤200 chars (detail
  lives in the topic file).

## Before you call it done

- The report classifies every imperfection into the three buckets, each with replayable
  evidence. The "本轮新 blocker" section is empty **or** every blocker is either fixed
  in-loop or surfaced as the headline with a one-line reason it was handed off.
- Every backlog item is mirrored to `harvest-register.md` (semantic dedup — bump
  recurrence on a re-discovery, don't duplicate). That register is what `e2e-evolve` reads.
- For every data-bearing skill that wrote ≥1 row, you checked `/__e2e/dataquality`, not
  just the row count. (`inventory_aggregator_scan` has no dataquality branch — its verdict
  surface is the voiced kept line `Kept N listing(s) matching your <trim> trim` on the
  CHAINED run's turn, `references/skill-pipeline.md` item 4.)
- The site_scan→aggregator AUTO-CHAIN fired: after a completed `inventory_site_scan` the
  parent turn voiced `Also checking shopping sites (Cars.com, Edmunds)…` and a chained
  `inventory_aggregator_scan` turn streamed for the same profile (a healthy site_scan with
  NO chained turn is a finding; `references/skill-pipeline.md` item 4).
- After each of the 3 irreversible sends, you confirmed the **fake** adapter fired (a
  positive check, not just the negative "no real send" counter).
- UI-monitor checkpoints ran (all six on a full run; ONE final on `--light`) and their
  findings are folded into the three buckets with a `monitor` provenance tag.
- The lane-took-effect check was recorded (provider + pricing_source noted in the
  report header).
- All cross-session artifacts written: the report, the run-ledger row, the memory pointer.
- `.claude/.e2e-loop-active` removed (on done AND on any abort).
