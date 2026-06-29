---
name: e2e-evolve
description: The companion to `/e2e-loop`. Run it in a FRESH session AFTER one or more
  live e2e runs. It reads the recorded reports + harvest-register, summarizes the
  cross-run lessons, researches and FIXES the recorded blockers / backlog / rough edges
  (through the gated review → green → fresh-live-verify → merge machine), and then
  improves the `/e2e-loop` skill itself so the next run reproduces the buyer experience
  better on a better product. Use after an e2e-loop run to close the loop on what it
  exposed — to fix the live-e2e findings, work the backlog, or evolve the e2e harness.
  Pass `--provider claude|deepseek` (default `deepseek`) to re-verify fixes against the
  same LLM lane the finding came from — `claude` runs the fresh serve-live re-verify on
  the Claude OAuth subscription lane (lane B), `deepseek` on the DeepSeek API-key lane.
disable-model-invocation: true
---

You are the **evolution half** of the live-e2e loop. `/e2e-loop` runs the product as a
real buyer and **records** every imperfection without fixing most of it. You come in a
fresh session, **read what it recorded, fix it, and make the next run better**. Track
progress with TodoWrite. cwd = `~/vscode/AutoBroker/AutoBroker`.

```
 /e2e-loop  (the runner)                     e2e-evolve  (this skill)
 ───────────────────────                     ──────────────────────────
 records blockers/backlog/polish    ──►       read reports + harvest-register
 into HTML reports + harvest-register          prioritize → research → fix → merge
                                               improve /e2e-loop for the next run
                                  ◄──          write-back lessons
```

Your two outputs: **a better product** (fixes merged to `main`) and **a better runner**
(an updated `/e2e-loop` so the next run exposes more, on firmer ground).

## The spine

| step | what you do | how you know it worked | load when you reach it |
|---|---|---|---|
| 1 | **read the history** — the last few `live-e2e/<run-id>/` reports + `harvest-register.md` + the `MEMORY.md` live-e2e pointers; list the open blockers, backlog items, and polish notes; write the cross-run lesson summary | a deduped worklist (one item per row) + a short "what recurs / what's new" note | `references/evolving.md` |
| 2 | **prioritize** — rank by buyer-value × recurrence × tractability; open **blockers first, always**; a backlog item seen in **≥3 runs graduates** into a designed plan-repo round instead of a point fix | a ranked worklist; graduated items flagged | `references/evolving.md` |
| 3 | **research each item** — one subagent per item: root cause → exact `file:line` → the minimal fix. Research only, no edits. Disjoint files run in parallel; overlapping files run serial | each item has a root cause + a minimal-fix plan | `references/fix-machine.md` |
| 4 | **fix in a worktree** — apply the minimal change in a fresh worktree; a fresh-context reviewer returns APPROVE + a safety-auditor returns SAFE (+ alignment-auditor if it touches architecture); `RUN_UI_FUNCTIONAL=1 green.sh` is `GREEN`; re-verify against a **fresh serve-live** | review APPROVE/SAFE; green GREEN; a live `/__e2e/rows` delta proving the fix | `references/fix-machine.md` |
| 5 | **integrate** — PR → `gh pr checks` exit 0 → merge → sync local `main` to `origin` (`0  0`) | `gh pr checks` exit 0; `main` aligned | `references/fix-machine.md` |
| 6 | **improve the runner** — update `/e2e-loop` + its references so the next run catches what was missed (add a verification surface for a blind spot, refresh a stale route/persona, raise the realism); run the calibration two-liner | a concrete `/e2e-loop` diff, or a written "no runner change needed" | `references/evolving.md` |
| 6.5 | **season — LLM-driven edge-case DISCOVERY** (the preferred edge layer): for each shipped fix register one LLM-seasoned case ON TOP of (never instead of) its deterministic regression; then run a BOUNDED generate→soak→triage discovery pass that mutates personas/dealers/messy inputs to find edges the runner doesn't hit | ≥1 seasoned case registered per fix; the discovery pass classifies its candidates WINNER/HARDENER/DUD | `references/seasoning.md` |
| 7 | **record** — update `harvest-register.md` (bump recurrence, mark shipped, move resolved items into the runner's known-correct list), write a short evolve-report (incl. the **Seasoning coverage** tally), write-back memory | register + report + memory updated | `references/evolving.md` |

You do not have to clear the whole backlog in one session — work the top of the ranked
list and leave the rest recorded. But **every open blocker you take on ends fixed +
merged or with a written `live-verified, no-code-change` ruling** — a safety blocker is
never left half-done.

## What you fix (and what you don't)

- **Open blockers** (handed off by the runner, or safety/correctness breaches): always
  in scope, highest priority. Fix through the full gated machine.
- **Backlog items**: the meat of your work — correct-but-worse-than-ideal product gaps.
  Fix the high-value, tractable ones; graduate the recurring systemic ones to a designed
  round; leave the rest recorded with a bumped recurrence.
- **Polish**: lowest priority; batch the cheap ones, skip the cosmetic ones unless they
  cluster into a real UX problem.
- **The runner itself**: when a run missed a reality or couldn't verify something because
  no route/row/testid exposed it, the fix is to **add that surface to the test host or
  the runner skill** (step 6). A new check must generalize to the next random buyer, not
  over-fit this run's metro.

## Guardrails (do not weaken — same floor as the runner)

- Every fix passes a **fresh-context** code-review APPROVE + safety-auditor SAFE — both
  **separate agents from the one that wrote the fix** (a fixer grading its own work is the
  trap). Any non-APPROVE / non-SAFE = hold, never majority-vote through.
- `RUN_UI_FUNCTIONAL=1 bash scripts/green.sh` prints literal `GREEN` for any UI / testid /
  harness diff (the default lane skips `ui:functional` and that gap once merged a CI-red).
- Re-verify every fix against a **fresh serve-live** (isolated tmp DB, `AUTOBROKER_MODE=test`,
  gates live) — "needs live verify" is not a defer reason, a fresh run is. The verdict is a
  `/__e2e/rows` / `/__e2e/audit` delta, not a screenshot. Re-verify on the **same provider
  lane the finding came from** (`--provider claude|deepseek`): export
  `AUTOBROKER_AGENT_PROVIDER=<provider>` before the re-verify serve-live so the whole run
  routes through that lane (a Claude-lane finding must be re-verified on Claude, not silently
  on DeepSeek).
- **Never** set `AUTOBROKER_TEST_AUTO_APPROVE`; never touch a production DB; isolated
  throwaway data-dir (CLAUDE.md inv #11). The 12 safety invariants hold — your fixes
  strengthen the floor, never lower it.
- Explicit-path `git add` only — never `git add .` / `-A`. No Claude attribution trailer.
- **Promotion is one-directional:** a backlog item may be electively pulled into the fix
  machine; a blocker can never be downgraded into a backlog note to avoid fixing it.
- **Seasoning never replaces a deterministic gate.** An LLM-seasoned (advisory) case is the
  edge-DISCOVERY + realism layer that rides ON TOP of the deterministic floor — it never
  becomes a merge gate and never substitutes for a `*.func.toml` / forced-fault test. A
  WINNER it surfaces is fixed through the SAME full gated machine (fresh-context
  APPROVE/SAFE + `RUN_UI_FUNCTIONAL=1` green + fresh serve-live re-verify); discovery gets
  no shortcut. The deterministic floor only ever GROWS (a seasoned case that repeatedly
  catches a real regression graduates DOWN into a func case — `references/seasoning.md`).

## The known-correct list (read before researching)

Before researching any item, filter out the runner's **known-correct behaviors** list
(in `e2e-loop/references/recording.md`) — those are investigated-and-correct, not bugs.
When you ship a fix that resolves a recorded issue, **move its entry into that list** so
the runner never re-flags it.

## Before you call it done

- Every open **blocker** you took on is fixed + merged (fresh-context APPROVE/SAFE +
  `RUN_UI_FUNCTIONAL=1` green + fresh live re-verify) or tagged `live-verified,
  no-code-change` with a one-line reason.
- `main` is aligned with `origin/main` (`git rev-list --left-right --count
  HEAD...origin/main` reads `0  0`); every worktree removed, every branch cleaned.
- `harvest-register.md` reflects this session (shipped items moved to the realized tail,
  resolved items moved to the runner's known-correct list, open blockers cleared on fix) —
  `recurrence` is the runner's counter, you read it, you don't bump it.
- If you changed `/e2e-loop`, the change is concrete and the calibration two-liner is
  done; if you didn't, you wrote why not.
- **Seasoning (step 6.5):** every fix this session registered its paired LLM-seasoned case
  (or you wrote why a deterministic regression was sufficient on its own); the bounded
  discovery pass ran and its candidates are triaged; the evolve-report carries the
  **Seasoning coverage** tally (`references/seasoning.md`).
- A short evolve-report + a `MEMORY.md` pointer (≤200 chars) record what shipped.
