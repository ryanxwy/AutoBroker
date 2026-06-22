---
name: e2e-loop
description: Run a manually-triggered live-e2e 全技能巡检 of the 17 AutoBroker skills against
  the real DeepSeek lane via serve-live + a browser — full two-sided live-negotiation
  loop (brand-picker → two-pass sweep → Opus dealer-brain haggle → frontend-taste →
  auto-close backlog → report → merge), or a `--light` manual two-pass sweep. Use to
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
| 2.5 | brand-picker (random metro+brand+persona) | geosearch ≥1 dealer | `references/brand-picker.md` |
| 3 | two-pass sweep: PASS-A freeform-persona, PASS-B `/slash`; per-skill rows/audit + DOM verify | terminal `skill_runs` row + table delta + active-panel testid | `references/skill-pipeline.md` (+`references/ui-lane-personas.md`) |
| 3.5 | dealer-brain live ≤2 rounds × ≤4 dealers | re-extract → new `dealer_quotes` row | `references/dealer-brain.md` |
| 3.7 | frontend-taste per data tab | ranked findings list | `references/ui-lane-personas.md` (→ `frontend-taste` skill by name) |
| 4 | backlog state machine S0–S6 (enumerate→research→fix-in-worktree→review→green→fresh live re-verify) | backlog-empty grep; green GREEN | `references/backlog-state-machine.md` |
| 4.5 | Electron sync (only if `apps/ui/src` or a testid touched) | `desktop:smoke` 14/14 | `references/reporting.md` |
| 5 | telemetry capture from `test_run_records` BEFORE pipeline_reset | one SQL dump | `references/harness-boundaries.md` (in-context) |
| 6 | write HTML report (incl. Time & Cost 2 tables) → plan repo | report sections present | `references/reporting.md` |
| 7 | integrate: review→green(`RUN_UI_FUNCTIONAL=1`)→CI→merge | `gh pr checks` exit 0 | `references/backlog-state-machine.md` (in-context) |
| 8 | write-back lessons (fixed write-list) + `rm .e2e-loop-active` + teardown | live-status box + memory pointer ≤200c | `references/reporting.md` (in-context) |

## Verification hierarchy

deterministic `/__e2e/rows` + `/__e2e/audit` counts (the verdict) **>** DOM
`browser_evaluate` on the active panel (corroboration) **>** screenshot (report
artifact) **>** `frontend-taste` LLM-judge (advisory). A lower rung NEVER overrides a
higher one: a pretty screenshot never beats a missing row; a taste finding alone never
blocks a merge.

## Guardrails

- Isolated tmp data-dir; `AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS=1` armed; **never** set
  `AUTOBROKER_TEST_AUTO_APPROVE` — keep the decline path live (CLAUDE.md inv #11).
- The 3 irreversible skills stay **fake-send**; gates render BEFORE prose; decline =
  Δ0, proven via `/__e2e/rows` (inv #8, #10).
- #1244 fail-closed watch on the largest live extractions (inv #4, by name — never
  re-paste).
- Seed ONLY via the **5** control routes (`inject_replies`, `inject_reply_to_thread`,
  `inject_crm_threads`, `audit`, `rows`) — external SQLite writes are invisible to the
  running server; `inject_crm_threads` before hygiene; closeout 2nd-last,
  pipeline_reset last.
- Budget never renders as a number (inv #9). Fresh-context auditors stay separate from
  the fixer; "needs live verify" ≠ defer — run a fresh serve-live.
- Self-contained `YYYY-MM-DD` HTML report; `MEMORY.md` pointer ≤200 chars (it is over
  budget — detail goes in the topic file).

## Self-check (every round, before declaring done)

- **The run does not end with unresolved findings** (this holds in `--light` too):
  every finding/backlog item this round is RESOLVED — fixed through the step-4 S0–S6
  machine (research → fix-in-worktree → fresh-context review APPROVE + safety SAFE →
  `RUN_UI_FUNCTIONAL=1` green → fresh live re-verify → merge) OR given a written
  `live-verified, no-code-change` ruling. The report's "本轮新 backlog" section is then
  **empty** — verify with a grep, not a rhetorical question.
- All 6 cross-session artifacts written (report, live-status box, memory file +
  pointer, git commit, telemetry export, marker handled).
- `.claude/.e2e-loop-active` removed (on done AND on any abort).
- Calibration two-liner done: diff this round's verdicts/waivers against the owner's
  prior-report judgment; a mismatch fixes the check, not the narrative.
