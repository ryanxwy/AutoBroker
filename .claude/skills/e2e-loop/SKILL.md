---
name: e2e-loop
description: Run a manually-triggered live-e2e 全技能巡检 of the 17 AutoBroker skills against
  the real DeepSeek lane via serve-live + a browser — full two-sided live-negotiation
  loop (brand-picker → two-pass sweep → Sonnet dealer-brain negotiation with sustained
  dealer resistance → multi-profile concurrent fan-out → frontend-taste → auto-close
  backlog → report → merge), or a `--light` manual two-pass sweep. Use to
  run the e2e sweep / 全技能巡检 on demand; pass --light for a read-only manual inspection.
disable-model-invocation: true
---

You drive one **live e2e 全技能巡检** of the 17 AutoBroker skills (manually triggered —
run it on demand, every time). This is a
heavyweight live ritual: it starts a real server, drives a real browser via Playwright
MCP, calls the paid DeepSeek provider, dispatches subagents, and (full mode) merges to
`main`. Track progress with TodoWrite. cwd = `~/vscode/AutoBroker/AutoBroker`.

## Mode

If invoked `--light` / "light sweep" / "manual inspection": run a BOUNDED inspection —
steps **{0, 2, 2.5 pin-or-bootstrap, 3 two-pass, 4 resolve-findings, 6 report}** — SKIP
the live dealer-brain negotiation (3.5) and Electron sync (4.5), and don't require the
full random brand-pick / deep 17-skill build. Light needs **no fresh worktree/build
(step 1)** — run step 2 against your existing checkout's (or an already-running)
serve-live; **if its DB is empty (nothing to pin), do a minimal intake first to
bootstrap one profile** (this also exercises intake live), or point --light at an
already-populated server. **Light still closes the loop:** any finding it surfaces is
RESOLVED via the step-4 S0–S6 machine (fix→review→green→fresh live re-verify→merge)
before it finishes — a --light run, like a full run, ends with an **empty backlog**. It
reads this spine + `references/harness-boundaries.md` + `references/skill-pipeline.md` +
`references/backlog-state-machine.md` (+ `references/reporting.md`). Otherwise (bare
`/e2e-loop`): run the FULL path 0→8.

## Feasibility gate (fail-closed, FIRST — do this before anything)

1. Keys present (`DEEPSEEK_API_KEY`, `GOOGLE_PLACES_API_KEY`) and Playwright MCP
   reachable — else **STOP and report**, do not run.
2. After serve-live launch: assert the `{"liveE2e":"listening",…,"dataDir":…}` stdout
   line appears within a bounded wait and record `dataDir` — else fail closed.
3. After brand-pick: assert geosearch returns **≥1 dealer** for the metro — else fail
   closed. An empty metro = a misconfigured `location_query`; do not drive a vacuous
   sweep.

## The spine

| step | action | machine-verify | load (read once) |
|---|---|---|---|
| 0 | read lessons (fixed read-list) + feasibility gate + `touch .claude/.e2e-loop-active` | keys/MCP present; stdout listening line | spine only |
| 1 | new worktree off `origin/main` + better-sqlite3 rebuild + `pnpm -r build` | build OK | `references/harness-boundaries.md` |
| 2 | start `pnpm e2e:serve-live` | `listening` line seen, `dataDir` recorded, floor armed | (in-context) |
| 2.5 | brand-picker (random metro+brand+persona) | geosearch ≥1 dealer (**≥10 for a full run** — big metro + high-volume vehicle) | `references/brand-picker.md` |
| 3 | two-pass sweep: PASS-A freeform-persona, PASS-B `/slash`; per-skill rows/audit + DOM verify | terminal `skill_runs` row + table delta + active-panel testid | `references/skill-pipeline.md` (+`references/ui-lane-personas.md`) |
| 3.5 | dealer-brain: **deep mutual negotiation — multiple parallel threads ≥4 rounds each, ≥10 dealers, multi-titled-contact escalation + AI-auto first-touch + ghosting** (realism > cost) | active threads `buyer_FUs ≥4` (past old cap); ghosts capped at 2 unanswered → drop; re-extract → revised `dealer_quotes` | `references/dealer-brain.md` |
| 3.7 | frontend-taste per data tab | ranked findings list | `references/ui-lane-personas.md` (→ `frontend-taste` skill by name) |
| 3.9 | multi-profile live-LLM fan-out (ONLY after pinned 3/3.5 is terminal+green): seed the **3 different-brand** world (Accord+Camry+Mazda6) via REAL intake; arm the real scheduler (`AUTOBROKER_PORTFOLIO_SCHEDULER=1` + `MAX_CONCURRENT_ACTIVE_PROFILES` < active); run **concurrent per-profile 3.5-grade negotiation** + a shared-`dealer_key` rooftop collision + interleaved human approvals through the unified `ApprovalInbox` | scheduler cap holds + every profile reaches terminal (no starve/wedge); `claimDealer`: exactly 1 binds the rooftop, losers `excluded_conflict` + `exclusion_reason`/`heldByVehicle` voiced + ZERO web-form AND ZERO email (claim precedes send; engage-then-abort releases); decline isolated to its profile (Δ0 there, no-op for others); `runAllInvariants` all-ok per-step (per-profile + portfolio aggregate); keystone `no_external_mutation==0`; portfolio UI: `/portfolio` board lists all N profiles (segment-grouped, health dots) + `portfolio-status-bar` counts + `needs-you-widget` surfaces every parked gate (routes to its run); `pnpm soak mp-replay` GREEN + `pnpm soak mp --until-dry` converges | `references/multi-profile-lane.md` |
| 4 | backlog state machine S0–S6 (enumerate→research→fix-in-worktree→review→green→fresh live re-verify) | backlog-empty grep; green GREEN | `references/backlog-state-machine.md` |
| 4.5 | Electron sync (only if `apps/ui/src` or a testid touched) | `desktop:smoke` 14/14 | `references/reporting.md` |
| 5 | telemetry capture from `test_run_records` BEFORE pipeline_reset | one SQL dump | `references/harness-boundaries.md` (in-context) |
| 6 | write HTML report (incl. Time & Cost 2 tables) → plan repo | report sections present | `references/reporting.md` |
| 7 | integrate: review→green(`RUN_UI_FUNCTIONAL=1`)→CI→merge | `gh pr checks` exit 0 | `references/backlog-state-machine.md` (in-context) |
| 8 | write-back lessons (fixed write-list) + `rm .e2e-loop-active` + teardown | live-status box + memory pointer ≤200c | `references/reporting.md` (in-context) |

**Step 3.9 gating (rulings #4/#7):** the pinned single-brand spine (steps 3 and 3.5) runs FIRST and unchanged; step 3.9 only starts once it is terminal+green.

## Verification hierarchy

deterministic `/__e2e/rows` + `/__e2e/audit` counts (the verdict) **>** DOM
`browser_evaluate` on the active panel (corroboration) **>** screenshot (report
artifact) **>** `frontend-taste` LLM-judge (advisory). A lower rung NEVER overrides a
higher one: a pretty screenshot never beats a missing row; a taste finding alone never
blocks a merge.

**A row COUNT alone is NEVER a skill PASS for a data-bearing skill.** A route
that returns only `{table,count}` cannot see a null-price listing or a null-OTD
quote — so a scan that writes N rows whose load-bearing payload (`listed_price`/
`msrp`, `otd_total`) is empty reads identical to N good rows and passes GREEN
(the 2026-06-22 miss: 10 listings, every price NULL, marked PASS while the buyer
saw `0 rec / 10`). For `inventory_site_scan` and `dealer_reply_extract` the
verdict is the `GET /__e2e/dataquality?skill=&profileId=` COVERAGE ratio, not the
`/__e2e/rows` count. Coverage is rung 1; the `price_missing` / `0 rec` chips a DOM
read shows (rung 2) only corroborate — a count-green / coverage-empty result is
itself the FAIL and the lower rungs cannot rescue it upward.

## Guardrails

- Isolated tmp data-dir; `AUTOBROKER_MODE=test` pinned (the sole send-control var);
  **never** set `AUTOBROKER_TEST_AUTO_APPROVE` — keep the decline path live (CLAUDE.md inv #11).
- The 3 irreversible skills stay **fake-send**; gates render BEFORE prose; decline =
  Δ0, proven via `/__e2e/rows` (inv #8, #10).
- #1244 fail-closed watch on the largest live extractions (inv #4, by name — never
  re-paste).
- Seed ONLY via the **6** control routes (`inject_replies`, `inject_reply_to_thread`,
  `inject_crm_threads`, `inject_contact`, `audit`, `rows`) — external SQLite writes are
  invisible to the running server; `inject_crm_threads` before hygiene;
  `inject_contact` for a manager-escalation contact flip; closeout 2nd-last,
  pipeline_reset last.
- Budget never renders as a number (inv #9). Fresh-context auditors stay separate from
  the fixer; "needs live verify" ≠ defer — run a fresh serve-live.
- **Realism > cost (owner, 2026-06-22).** A full run mimics the REAL email quote
  pipeline: ≥10 dealers, full pre-flight market search, and **deep mutual negotiation
  driven to ≥4 rounds on multiple parallel threads** with multi-titled-contact
  escalation, AI-auto first-touch, and ghosting (`references/dealer-brain.md`). Spend
  the LLM calls — saving cost is secondary to exercising the realities.
- **Multi-profile is part of the realities (step 3.9).** A real cross-shopper runs
  several searches at once. A full run drives the **concurrent 3-different-brand
  world** (Accord+Camry+Mazda6) on the REAL scheduler: N independent pipelines under
  a hard cap, each negotiating its own dealers, overlapping on shared rooftops, every
  approval funnelling into ONE inbox — surfacing the concurrency bugs the single-
  profile spine can't (cross-profile bleed, shared-rooftop double-send, mis-routed
  approval, a starved/wedged profile). The operator drives/observes it through the
  **Phase-3 portfolio UI**: the `/portfolio` board (`portfolio-board`, segment-grouped
  `portfolio-card-<id>` + health dots + `portfolio-status-bar` counts header), the
  per-session pin toggle (`session-pin`), and the floating `needs-you-widget` (the DOM
  face of `GET /api/approvals` — routes to the run's gate, never approves inline).
  `references/multi-profile-lane.md`.
- **Dealers RESIST — model it, don't over-cooperate (owner, 2026-06-24).** Most
  dealers won't email an out-the-door number: model the realistic mix — come-onsite-only
  (never a number, even at "ready to buy today"), mid-thread ghosting, reverse-inducement;
  only a minority quote, late + grudgingly. A profile can finish with **few or 0 email
  OTDs → a valid `ghosted`/`cold` outcome** (never a fabricated quote; verdict PASSES a
  low quote-rate, FAIL only for a dropped-but-present OTD). The dealer actor runs as
  **per-dealer Sonnet subagents, ≤3 concurrent on the OAuth subscription** (paced; rounds
  sequential); **every reply is a live LLM generation — never canned/replayed in a live
  run** (`references/dealer-brain.md`).
- **Product behavior rules (owner, 2026-06-23 — also in CLAUDE.md):** (1) **Intake
  never assumes a required vehicle field** — `model`/`trim`/`year` must be stated by
  the buyer; if the persona's freeform omits one, the form leaves it blank and you
  must supply it as the buyer's explicit choice (or ASK), never fabricate a default.
  (2) **`inventory_site_scan` scans ALL in-radius dealers by default — no batch
  approval gate** (read-only; the `batch-*` testids no longer render for it; there is
  no site_scan decline path). The shared batch gate still guards the 3 send skills +
  `inventory_link_scan`. (3) **Chat history stays in one session** — only a deliberate
  new-search (intake fork) or explicit session switch resets the rail. (4)
  **`incentive_scrape` always auto-approves new OEM sources** (read-only; no
  first-encounter `approval-*` gate renders for it). (5) **`dealer_web_lead_submit`'s
  batch card shows a `batch-summary`** (vehicle, email, placeholder-phone — never budget)
  and the dealer list is height-capped + scrollable.
- **Worktree needs `.env` (step-1 trap).** `.env` is gitignored, so a fresh sibling
  worktree has none and `loadDotEnvKeys`' walk-up won't find the main checkout's copy
  — serve-live then reports "Add your DeepSeek key" and the NL router 500s. Copy
  `.env` into `$WT` after `git worktree add` (it stays gitignored, never staged).
- Self-contained `YYYY-MM-DD` HTML report; `MEMORY.md` pointer ≤200 chars (it is over
  budget — detail goes in the topic file).

## Self-check (every round, before declaring done)

- **The run does not end with unresolved findings** (this holds in `--light` too):
  every finding/backlog item this round is RESOLVED — fixed through the step-4 S0–S6
  machine (research → fix-in-worktree → fresh-context review APPROVE + safety SAFE →
  `RUN_UI_FUNCTIONAL=1` green → fresh live re-verify → merge) OR given a written
  `live-verified, no-code-change` ruling. The report's "本轮新 backlog" section is then
  **empty** — verify with a grep, not a rhetorical question.
- **Data-quality floor (count-green is NOT quality-green).** For every
  data-bearing skill that wrote ≥1 row, hit `GET /__e2e/dataquality?skill=&profileId=`
  and apply the per-skill threshold — never accept a `/__e2e/rows` count as the PASS.
  `inventory_site_scan`: **hard FAIL when `n>0 AND priced==0 AND msrp_present==0 AND
  gated==0`** (TOTAL price loss — the 2026-06-22 bug). A healthy scan covers
  `covered/n ≥ 0.5`; below that but `>0` is a soft report note, not a FAIL (the
  per-dealer VDP budget legitimately bounds how many CTA-gated cars get a VDP visit).
  `dealer_reply_extract`: hard FAIL when `n>0 AND otd_present==0` (every quote
  OTD-empty); `otd_present/n ≥ 0.5` is the healthy target. The ONLY non-FAIL
  zero-coverage paths are the machine-checkable escapes the route surfaces as DATA,
  never prose: `nullEscape:true` (n==0, empty metro / nothing extractable) OR
  `gated==n` (every listing explicitly price-withheld). A FAIL goes through the
  step-4 S0–S6 machine; record the coverage ratio in the report's per-skill row.
- All 6 cross-session artifacts written (report, live-status box, memory file +
  pointer, git commit, telemetry export, marker handled).
- `.claude/.e2e-loop-active` removed (on done AND on any abort).
- Calibration two-liner done: diff this round's verdicts/waivers against the owner's
  prior-report judgment; a mismatch fixes the check, not the narrative.
