---
name: daily-sync
description: End-of-day ritual — refresh today's plan-repo daily HTML report from this code repo's git log + harness export (machine sections), then draft the human sections (narrative / decisions / risks / next-day) for review. Use when wrapping up a work session on the AutoBroker TS repo.
disable-model-invocation: true
---

You produce/refresh **today's daily progress report** in the plan repo from the
**AutoBroker (TS)** code repo's actual activity, then draft the human sections.
This is the deliberate counterpart to the passive Stop hook.

## Resolve paths

- CODE = `git rev-parse --show-toplevel` (this repo)
- PLAN = `$CODE/../AutoBroker-dev-plan`
- DAILY = `$PLAN/daily`
- NEWDAY = `$PLAN/tools/new-day.sh`
- DATE = today (`date +%Y-%m-%d`), unless the user passed one in args.

## Steps

1. **Harness export (best-effort):** if `package.json` has a `harness:export`
   script and pnpm is installed, run it so `harness/exports/$DATE.json` is current.
   Tolerate failure (pre-pnpm / no run today).

2. **Machine sections — create or refresh:**
   - If `$DAILY/$DATE.html` does NOT exist: run
     `"$NEWDAY" "$DATE" --code-repo "$CODE"`.
   - If it EXISTS: `new-day.sh` refuses to overwrite, so to refresh the machine
     tables, FIRST read the file and copy out the human sections verbatim (the
     content between the `narrative` / `decisions` / `risks` / `next-day`
     section markers), then `rm` the file, re-run `new-day.sh`, and paste the
     saved human content back into the regenerated file. NEVER discard
     human-written narrative.

3. **Draft the human sections** (then let the user edit). Read this code repo's
   commits for the day (`git -C "$CODE" log --since="$DATE 00:00" --until="$DATE 23:59"`)
   and the current phase's `exitCriteria` from
   `$PLAN/phases/PHASE_<n>_*.md`, and write:
   - **进展叙事** — which skill's 7-step loop advanced and to which step; blockers;
     the gap to the current phase's exitCriteria. (Optionally invoke the
     `burndown-scout` agent for the precise per-skill step state.)
   - **决策与偏移** — any decision settled/overturned today; link to
     `../architecture/DECISIONS.html` (use `/decision-log` to add the entry there).
   - **风险与 anchor 红灯** — any risk hit (e.g. a structured-output fail-closed fired,
     profile W-C branch) or anchor that went green→red.
   - **明日计划** — the next skill / next step, pointing to the specific
     `PHASE_<n>` deliverable.

4. **Rebuild the index** (`new-day.sh` already calls `build-index.sh`; if you
   refreshed manually, run `"$PLAN/tools/build-index.sh"`).

5. **Present.** Show the drafted human sections and the refreshed machine tables
   for the user to edit. This skill itself does NOT commit. Note, however, that the
   code-repo Stop hook `sync-daily.sh` (step 3) auto-commits + pushes the generated
   `daily/<date>.html` scaffold + `index.html` to the private plan repo's
   `origin/main`, and any human-narrative edits you make land on the next
   qualifying code-repo turn-end — so "nothing is committed until the user
   deliberately does it" is no longer an absolute guarantee.

## Guardrails

- Read-only on the code repo. Write only under `$PLAN/daily/`.
- Preserve any existing human narrative across a refresh (step 2).
- Absolute dates `YYYY-MM-DD`. Keep the report self-contained (inline CSS).
