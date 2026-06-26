# fix-machine.md — the gated fix + integrate pipeline (steps 3–5)

The closed loop that turns one worklist item into a merged, live-verified fix. Loaded at
steps 3, 4, 5. Every gate here is load-bearing — a small fix gets no shortcut.

## Research (step 3) — one subagent per item

Dispatch one research subagent per worklist item: find the **root cause**, the exact
`file:line`, and the **minimal** fix. Research only — **no edits**. Disjoint files run in
parallel; any file overlap runs **serial** (a later subagent reads the prior edit's plan).

## Fix (step 4a) — edits ONLY inside the worktree

Work in a fresh worktree off `origin/main` (copy `.env` in — it is gitignored, so a fresh
worktree has none, and serve-live needs the DeepSeek key). The fixer applies the **minimal**
change inside the worktree. `git status` MUST show **no out-of-worktree absolute-path
writes** — a subagent writing to the main checkout's absolute path is a real, observed bug.
Stage explicit paths only; leave unrelated worktree changes alone.

## Review (step 4b) — fresh-context auditors, separate from the fixer

A **fresh-context** code-reviewer returns **APPROVE** and a safety-invariant-auditor
returns **SAFE**. Add an **alignment-auditor** when the fix touches architecture (a
cross-layer reference, a new route's placement). They are **separate agents from the
fixer** — a fixer grading its own fix is the "confidently praising mediocre work" trap.
Any non-APPROVE / non-SAFE = **hold**, never majority-vote through.

## Green (step 4c) — the deterministic gate

`RUN_UI_FUNCTIONAL=1 bash scripts/green.sh` prints literal `GREEN` — the full UI lane is
mandatory for any UI / testid / harness diff (the default lane skips `ui:functional`, and
that gap once merged a CI-red). See the `green` skill by name. If the fix touched the
multi-profile lane, `pnpm soak mp-replay` is also `GREEN` (the deterministic backstop;
`soak mp --until-dry` is structurally live-deferred — `serverHost.ts` lacks the inject
routes + record/replay seam, so the live multi-profile lane is serve-live, not soak).

## Live re-verify (step 4d) — a fresh serve-live (owner rule)

Re-verify each fix against a **fresh serve-live** — same isolated tmp DB,
`AUTOBROKER_MODE=test`, gates live. **Re-verify in place** when you can (the biggest single
wall-clock lever, ~5–12 min/fix): restart serve-live in the **same worktree** so it picks
up the new `pnpm -r build`, reusing the worktree's `node_modules` + prebuilt
`better-sqlite3` — only `git worktree add` a fresh tree if the base diverged. The verdict
is a `/__e2e/rows` / `/__e2e/audit` delta, **not** a screenshot. "Needs live verify" is
never a defer reason — a fresh run is.

## Commit + integrate (step 5)

1. Commit with the `phaseN/<skill>:` prefix (or `phase0/live_e2e:` for a runner/harness
   fix), explicit paths, **no Claude attribution trailer**.
2. Push the branch; `gh pr create`.
3. `gh pr checks --watch` — a `--watch` timeout is benign, re-poll; the verdict is
   `gh pr checks` **exit 0**, never "looks passing".
4. All-green → `gh pr merge --rebase`.
5. Sync local `main` until `git rev-list --left-right --count HEAD...origin/main` reads
   `0  0` (CLAUDE.md "Definition of done"). Remove the worktree, delete the branch.

## Not-a-bug is still handled

Some items are not product bugs — a dealer site returning an anti-scrape **403** is real
dealer behavior, not a defect. But the fix this round is to make it **transparent to the
buyer** (a surfaced "blocked" count), not to ignore it. Every such item ends either fixed
or tagged `live-verified, no-code-change` with a one-line rationale — never silently
dropped.

## Calibration (two lines, every session)

1. Diff this session's fixes against the **owner's judgment in the prior reports**. A
   mismatch fixes the **check or the product**, not the narrative — e.g. a "red herring"
   that was really a mis-attribution means the check was reading the wrong signal; tighten
   what the check reads.
2. Confirm every `no-code-change` ruling is **visible** in the evolve-report — never
   silently absorbed.
