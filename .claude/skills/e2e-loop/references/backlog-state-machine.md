# backlog-state-machine — the S0→S6 closed-loop fix machine (step 4) + integrate (step 7)

Loaded at step 4; reused at step 7. The owner rule is hard: **handle EVERY issue
this round — backlog is not an acceptable ending.** "Needs live verify" is NOT a
defer reason; a fresh serve-live run is. The report's "本轮新 backlog" section is
**empty** OR every entry tagged `live-verified, no-code-change`.

## S0 — enumerate every issue, then filter the already-fixed

Collect, this round, EVERY one of: skill **completed but the UI is wrong**
(terminal `skill_runs` row exists yet the active panel / testid / count is off);
`frontend-taste` findings of **every** severity (incl. POLISH); anything
**anomalous / slow / counter-intuitive** in the sweep (silent multi-min
"RUNNING", a number disagreeing with another surface); prior-round backlog from
step-0's read-list. **FIRST filter out the DON'T-RE-PROPOSE LEDGER (bottom).**
Those are fixed — never research or re-surface them. What survives is the round's
work-queue, one item per row.

## S1 — research subagent per item (root cause → file:line → minimal fix)

One research subagent per surviving item: root cause, exact `file:line`, the
**minimal** fix. **Disjoint files run in parallel**; any file overlap runs
**serial** (a later subagent reads the prior edit). Research only — no edits.

## S2 — fix subagent, edits ONLY inside the worktree

The fixer applies the minimal change inside `$WT` (the step-1 worktree). **`git
status` MUST assert no out-of-worktree absolute-path writes** — a subagent writing
to the main checkout's absolute path is a real, observed D-wave bug. Stage
explicit paths only; leave unrelated worktree changes alone.

## S3 — fresh-context auditors, separate from the fixer

A **fresh-context** code-reviewer returns **APPROVE** and a
safety-invariant-auditor returns **SAFE** (add an alignment-auditor when the fix
touches architecture — a cross-layer reference, a new route's placement). They are
**separate agents from the fixer** (a fixer grading its own fix is the
"confidently praising mediocre work" trap). Any non-APPROVE / non-SAFE = **hold**,
never majority-vote through.

## S4 — repo green

`RUN_UI_FUNCTIONAL=1 bash scripts/green.sh` prints literal `GREEN` — the full UI
lane is mandatory for any UI / testid / harness diff (the default lane skips
`ui:functional` and that gap once merged a CI-red). See the `green` skill by name.

## S5 — fresh serve-live live re-verify (owner rule)

Re-verify each fix against a **fresh serve-live run** — same isolated tmp DB,
`BLOCK=1` floor, gates. **Reverify in place** (the biggest single wall-clock
lever, ~5–12 min/fix): restart serve-live in the **same `$WT`** so it picks up the
new `pnpm -r build`, reusing the worktree's `node_modules` + prebuilt
`better-sqlite3` — only `git worktree add` a fresh tree if base diverged. The
verdict is a `/__e2e/rows` / `/__e2e/audit` delta, not a screenshot.

## S6 — commit

Commit with the `phase0/live_e2e:` prefix, explicit paths, no Claude attribution
trailer. The fix is recorded; loop to the next S0 item.

## Not-a-bug is still handled

The owner rule covers items that aren't product bugs. A dealer site returning an
anti-scrape **403** is not a defect — but the fix this round is to make it
**transparent to the buyer** (a surfaced "blocked" count), not ignore it. Every
such item ends fixed or tagged `live-verified, no-code-change` — never dropped.

## T7 — a missing or unreliable CHECK is itself a fix item this round

If a skill "completed but couldn't be verified" because no row / route / audit
action / committed `data-testid` exposed the result, the fix is to **add that
verification surface** — in the **TEST HOST** (`serve-live.mjs` control routes,
committed testids), never the product `/api` layer — through **this same gated
S0→S6 machine**. That authority belongs to the running loop, not to anyone
pre-authoring it. A new check must generalize to the next random brand
(brand-picker randomness = the held-out set), not over-fit this round's metro.

## Evaluator calibration (two lines, every round)

1. Diff this round's verdicts/waivers against the **owner's judgment in the prior
   report**. A mismatch fixes the **CHECK**, not the narrative — e.g. the run-d
   `fake_mailbox` 4→8 "red herring" was a mis-attribution (a routing call, not a
   send), so the calibrated fix tightens what the check reads.
2. Confirm every waiver is **visible** in the report — never silently absorbed.

## Integrate — step 7 (full mode only)

All-green and all auditors APPROVE/SAFE →
1. push the branch;
2. `gh pr create`;
3. `gh pr checks --watch` (a `--watch` timeout is benign — re-poll; the verdict
   is `gh pr checks` exit 0, never "looks passing");
4. all-green → auto `gh pr merge --rebase`;
5. sync local `main` until `git rev-list --left-right --count HEAD...origin/main`
   reads `0  0` (CLAUDE.md "Definition of done").

## DON'T-RE-PROPOSE LEDGER (filtered out at S0, never re-surfaced)

MATH_SANITY null-skip (FINDING I) · DOC_FEE_CAP only CA/NY/WA, state-from-geocoder
(A4) · cash/unspecified compare-bucket fold (FINDING J/A5) · closeout fake-count
(A8) · site_scan scanned-0 vs never-scanned empty-state (A2) · incentive sources
Hyundai/Toyota/Honda/Chevrolet added · scout `boundedConcurrentMap` parallelize
(FINDING H) · Best-OTD bento reconcile / one-number-one-home (FINDING G) · audit
pills on off-mode quotes (FINDING C) · sensitivity-clarify `clarify-run-explicit`
button (PR#22) · tabbed-Canvas click-before-read · inventory/dealers/replies
pagination · stock-link click-through · de-jargoned empty-state hints · geocoder =
METRO_FIXTURES (not live) · "site_scan 0 Toyota/Dallas" = routing misattribution to
inventory_compare.
