---
name: skill-loop
description: Drive one skill through the 7-step build loop (contract → deterministic tools+L1 → workflow → fallback gating → DeepSeek live L2 UI-lane two rounds → cross-provider smoke → acceptance) with deterministic gates at every step. Use when starting or continuing a skill round (e.g. B2 inventory_site_scan) in the AutoBroker TS repo.
---

You drive **one skill = one full loop** for the AutoBroker rebuild. The args
name the skill (and optionally the phase / milestone, e.g.
`/skill-loop inventory_site_scan B2`). Doctrine lives in the plan repo:
`../AutoBroker-dev-plan/ts-rebuild/phases/SKILL_LOOP.html` + the current
`PHASE_<n>` page — read them, they win over this file on conflict.

## The one green signal

`bash scripts/green.sh` is the only definition of "repo is green"
(typecheck + depcruise + forbidden-strings + drizzle empty-diff + full tests).
**Never end a turn that claims a step done without having just run it and seen
`GREEN`.** Never judge tests by eyeballing output (`| tail` hides reds — exit
code only). Known load-flakes (telemetryEgress, spike2.crashResume): rerun the
failing file isolated before believing a red; if isolated-green twice, say so
explicitly instead of silently retrying.

## Step ⓪ — fresh-context opening (every session, ~2 min)

1. Read the latest `../AutoBroker-dev-plan/ts-rebuild/daily/*.html` — yesterday
   + planned next.
2. Read the skill's ①–⑦ plan block in `PHASE_<n>` + `SKILL_LOOP.html`.
3. `git log --oneline -20` in BOTH repos — prefixes are the narrative.
4. Read the latest `harness/exports/*.json` — which cells are already green.
5. Read `~/.autobroker-ts/regression/latest.txt` — if absent or older than the
   last acceptance, the guardian loop is stale.
6. `touch .claude/.skill-loop-active` — marks this as a skill-loop session (the
   optional Stop-hook gate, if the owner has installed it, switches from
   typecheck-only to full green.sh while this marker exists; harmless without
   the hook). Remove it at step ⑦ — and also when ABORTING a round midway.

## Round-start regression gate (before step ① of a NEW skill)

Run `bash scripts/regression.sh` (re-runs every accepted case in
`harness/regression-corpus.txt`, live). Exit 0 required. Any
previously-accepted case coming back RED is a **BLOCKER**: stop the new skill,
fix or record first — per the harness standard's GREEN→RED rule.

## Steps ① – ⑦ (each step ends with its check, then green.sh)

| step | work | machine check before moving on |
|---|---|---|
| ① contract | types + Zod in `packages/core` | green.sh |
| ② deterministic tools + L1 | pure functions in `packages/tools` + unit tests | new tests exist AND green.sh |
| ③ workflow scaffold | flat `createWorkflow` in `packages/workflows`, policy-bound model | `--dry-run` harness boot proves wiring; green.sh |
| ④ fallback gating | semantic→suspend, transient→trace-span; gate renders before prose | the decline path has a test; green.sh |
| ⑤ DeepSeek live, L2 两道 | **UI lane** (real dashboard DOM via harness uiDriver), two independent rounds | both `verdict.json` files read and `GREEN` (lane="ui"); screenshots present |
| ⑥ cross-provider smoke | DEFERRED in dev period (owner ruling 2026-06-05) — record the debt, do not run without explicit go | debt noted in daily |
| ⑦ acceptance | ledger + export + acceptance commit `phaseN/<skill>:` | see checklist below |

## Step ⑦ acceptance checklist

1. `bash scripts/green.sh` → GREEN.
2. **Evaluator calibration (two lines, every acceptance):**
   a. diff EVERY verdict of this skill (including each waiver) against the
      owner's actual judgment; any mismatch → fix the evaluator/anchor, not the
      narrative.
   b. confirm waivers are visible in the daily export (never silently absorbed).
3. `pnpm harness:export` → today's `harness/exports/<date>.json`.
4. Append this skill's accepted case files to `harness/regression-corpus.txt`
   (deferred + cross-provider cases stay out).
5. Acceptance commit with the `phaseN/<skill>:` prefix. (The 3 irreversible skills
   real-send in buyer mode / fake-send in test mode via `AUTOBROKER_MODE` — the old
   fake-send commit-body marker is retired.) The skill's
   `packages/skills/<skill>/SKILL.md` (Phases / Guardrails / References) rides
   the SAME commit — debt-sweep flags implemented skills missing it.
6. `/daily-sync` for the plan-repo daily report (drafts only — the plan repo is
   committed by the user, never automatically).
7. `rm -f .claude/.skill-loop-active` — the session leaves skill-loop mode.

## Safety redlines (no loop may dilute these)

- mutation-capable / deny_all skills (C/D risk + the 3 irreversible skills)
  **never run in an unattended loop**; the floor is `AUTOBROKER_MODE=test` (the
  sole send-control var) + L2 fail-CLOSED.
- never set `AUTOBROKER_TEST_AUTO_APPROVE` — the decline path must stay
  exercised.
- loop output toward the plan repo is drafts/reports only; commits are human.
- the loop's lanes never really send: every harness/test lane is force-pinned
  `AUTOBROKER_MODE=test` fail-closed (real sends exist only in buyer mode, one
  L2-approved action at a time — never from this loop).
