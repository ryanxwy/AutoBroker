---
name: debt-sweep
description: Read-only debt inventory — deferred harness cases, cross-provider smoke debt, regression-report staleness, unregistered plan-repo rounds, missing daily report. Use for a recurring sweep (e.g. via /loop) or whenever asking "what's owed". Never edits anything.
---

Run `bash scripts/debt-sweep.sh` and report what it prints, plus any debt you
know of that the script cannot see mechanically (e.g. a live LLM branch that
has never fired, doc erratas promised but not written).

Rules:

- **Report only. Never edit files, never commit, never "fix while you're
  here".** If a debt is worth acting on, say so and stop — acting is a separate
  deliberate step.
- Order findings by risk: anything that can silently rot an accepted GREEN
  (stale regression, evaluator drift) first; doc bookkeeping last.
- Keep it short: one line per debt, with the exact file/command to settle it.
