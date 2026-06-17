---
name: green
description: Run the repo's single pass/fail gate (scripts/green.sh), interpret the result, rerun known load-flakes isolated before believing a red, and prompt for RUN_UI_FUNCTIONAL=1 on UI / testid / harness changes. Use before committing, before an acceptance, or whenever asked "is it green?".
disable-model-invocation: true
---

You run **the single gate** for the AutoBroker (TS) repo and report a trustworthy
GREEN / RED. `scripts/green.sh` is the one pass/fail signal the agent self-check,
the Stop-hook, and CI all ask; this skill is the deliberate, interpreted way to
ask it by hand.

## Steps

1. **Pick the lane.** Default: `bash scripts/green.sh`. If the change touched the
   **UI, a `data-testid`, the harness, or a runtime/dep bump**, run the FULL gate
   instead: `RUN_UI_FUNCTIONAL=1 bash scripts/green.sh`. The default skips the
   real-DOM functional UI lane (it's heavy ~1m and off by default), and that gap
   has merged a CI-red-despite-local-green before — so opt in when UI/testid/
   harness is in the diff. If unsure which the diff touches, run the full gate.

2. **Run it and read the WHOLE output.** Never `| tail` it — the script is
   fail-fast and any step's non-zero exit fails the whole run. The final line is
   `GREEN` only on a clean pass.

3. **On a red, isolate known load-flakes before believing it.** The two known
   load-flakes are `telemetryEgress` and `spike2.crashResume` (load-ordering, not
   logic). If the red is ONLY one of those, rerun that one test file in isolation
   (e.g. `pnpm vitest run <path-to-that-file>`); if it passes alone, report the
   flake explicitly and re-run the full gate to confirm GREEN. **Never weaken
   green.sh to retry** — the isolation is a diagnosis step, not a gate change.

4. **On a real red, report the failing step + the minimal cause.** Name which of
   typecheck / harness typecheck / lint:deps / check:strings / db:check / test /
   ui:functional failed, with the relevant lines. Do not "fix while reporting" —
   surface it and let the fix be a separate, deliberate step.

## Guardrails

- **Report-only on flakes.** Diagnose, isolate, re-confirm — never edit green.sh,
  never add a retry/`|| true`, never comment out a step.
- A run is GREEN only when the unmodified script prints `GREEN`. A flake that
  passed in isolation still requires a clean full-gate re-run to claim GREEN.
- `db:check` red usually means a schema edit without a regenerated drizzle
  snapshot — say so (`pnpm db:generate` then re-inspect the diff), don't guess.
