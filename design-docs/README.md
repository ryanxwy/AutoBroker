# design-docs/ — code-local ADR stubs

> Status: Phase 0 (foundation) · 2026-06-02 · SCAFFOLD. This is a **short ADR-stub
> area** for code-level "why we implemented it this way" decisions that live close
> to the code. **Long-form planning, the phase sequence, and the harness standard
> do NOT live here** — they live in the plan repo, **AutoBroker-dev-plan**.

## What belongs here

- **Code-local ADR stubs** only: a tight record of a decision made while writing
  the code in this repo (a library choice, a module boundary, a workaround for a
  provider quirk). Each stub links **back** to the canonical decision in the plan
  repo rather than restating it.

## What does NOT belong here

- Long-range phase plans, the build order, exit criteria → plan repo
  [`phases/`](../../AutoBroker-dev-plan/ts-rebuild/phases/).
- The live-harness standard, anchors, invariants → plan repo
  [`harness-standard/`](../../AutoBroker-dev-plan/ts-rebuild/harness-standard/).
- The architecture mirror and the master decision ledger → plan repo
  [`architecture/`](../../AutoBroker-dev-plan/ts-rebuild/architecture/), especially
  [`DECISIONS.md`](../../AutoBroker-dev-plan/ts-rebuild/architecture/DECISIONS.md).

The plan repo is the **source of intent**; this code repo is the **source of
truth**. The split keeps narrative/planning prose out of the code repo and
runnable code out of the plan repo (the two-repo rule).

## Naming (final — 2026-06-02)

- **AutoBroker** — this repo (`~/vscode/AutoBroker/AutoBroker`), the new
  full-TypeScript code repo. Fresh git, branch `main`. Parity-period data dir
  `~/.autobroker-ts/`.
- **AutoBroker-Python** — `~/vscode/AutoBroker/AutoBroker-Python`, the FROZEN
  legacy Python repo (read-only parity oracle until all 17 skills are
  parity-GREEN, then single-point flip).
- **AutoBroker-dev-plan** — `~/vscode/AutoBroker/AutoBroker-dev-plan`, the
  docs/plan repo.

(Never write "AutoBroker-ts" or "AutoBroker-legacy-py" — those names are stale.)

## TODO

- [ ] First ADR stub lands when a Phase-0/1 implementation decision diverges from
      or refines a plan-repo decision (link back to `DECISIONS.md`).
- [ ] No ADR stubs exist yet — this area is intentionally empty until a
      code-local decision needs recording.
