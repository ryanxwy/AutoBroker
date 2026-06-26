# evolving.md — read history, prioritize, improve the runner, write back (steps 1, 2, 6, 7)

The half of `e2e-evolve` that turns a pile of recorded runs into a ranked plan and a
better runner. Loaded at steps 1, 2, 6, 7.

## Step 1 — read the history

Read, in this order:

1. `ts-rebuild/live-e2e/harvest-register.md`'s **"Open blockers (handed off)"** section
   FIRST — these are the highest priority; carry every open blocker forward across sessions
   until it is fixed (a blocker never ages out of the worklist).
2. The last few `ts-rebuild/live-e2e/<run-id>/index.html` reports — pull their **本轮发现**
   sections (the three buckets) and any headline blocker.
3. The rest of `harvest-register.md` — the cross-run backlog accumulator (open items + their
   recurrence counts + the realized-harvest tail). You **read** recurrence to prioritize and
   graduate; the runner owns bumping it.
4. The `MEMORY.md` live-e2e pointers + their topic files — the traps and prior rulings.

Produce a **deduped worklist** (one item per row: blocker / backlog / polish, with its
evidence_ref) and a short **"what recurs / what's new"** note — the longitudinal view a
single run cannot see.

**Calibration:** if a finding the owner treated as a blocker was filed as backlog in a
prior report (or vice-versa), that drift is a calibration bug — the fix is to tighten the
data-quality CHECK that should have caught it (a runner improvement, step 6), not the prose.

## Step 2 — prioritize

Rank by **buyer-value × recurrence × tractability**:

- **Open blockers first, always** (safety/correctness/journey-stopping). Non-negotiable.
- Then **high-value, tractable backlog** — the gaps that most hurt a real buyer and have a
  clear minimal fix.
- A backlog item observed in **≥3 runs graduates**: it is systemic, not a one-run artifact,
  so it earns a **designed plan-repo round** (an ADR / feature doc + its own build), not a
  quick point fix. Flag it; do the design round deliberately.
- **Polish** last; batch the cheap ones.

### harvest-register lifecycle

- **Recurrence is read-only here**: the runner bumps `recurrence` when it re-observes a gap
  live. You match a re-discovery on *the buyer-value gap* (semantic dedup) to **read** the
  count and decide graduation — you never increment it yourself (double-counting one event
  would graduate a round early).
- **`recurrence ≥ 3` graduates** into a plan-repo round (above).
- **Elective promotion**: any backlog item may be pulled into the fix machine
  (`references/fix-machine.md`) at any recurrence if it is small and high-value.
- **Shipped** items move to the register's **realized-harvest tail** with the landing
  commit, and their resolved behavior moves into the runner's **known-correct list**
  (`e2e-loop/references/recording.md`) so the runner never re-flags it.

## Step 6 — improve the runner

The point of this skill is that the **next** `/e2e-loop` run is better. After fixing the
product, ask what the runner missed and close that gap:

- **A blind spot** — a skill "completed but couldn't be verified" because no row / route /
  audit / committed `data-testid` exposed its result → add that verification surface, in
  the **test host** (`serve-live.mjs` control routes, committed testids), never the product
  `/api` layer. A new check must **generalize to the next random buyer** (the brand-picker
  randomness is the held-out set), not over-fit this run's metro.
- **A stale detail** — a drifted testid, a removed route, a changed threshold, a persona
  that no longer triggers its edge → refresh the relevant `/e2e-loop` reference so the next
  run doesn't trip on it.
- **A missed reality** — the run under-exercised something a real buyer hits (a finance
  edge, a dealer archetype, a cross-shop collision) → raise the realism in
  `e2e-loop/references/dealer-brain.md` / `multi-profile-lane.md` / `ui-lane-personas.md`.

If the run was clean and the runner needs no change, **write that down** — a deliberate
"no runner change needed" is a valid outcome, a silent skip is not.

### Electron / desktop sync (conditional)

If a fix this session touched `apps/ui/src/` or a `data-testid`, rebuild the desktop
bundle and smoke it:

```bash
cd "$WT" && pnpm build && pnpm desktop:bundle && pnpm desktop:smoke   # expect 14/14
```

Note "桌面包已刷新 @ commit `<hash>`" in the evolve-report. Smoke < 14/14 is a blocker —
do not merge a UI change that breaks the desktop bundle.

## Step 7 — record (evolve-report + write-back)

- **Evolve-report** — a short self-contained HTML page under
  `ts-rebuild/<date>-e2e-evolve/index.html` (warm-paper style, key sections 中文):
  what was read, the ranked worklist, what shipped (with commits + live re-verify
  evidence), what was graduated, what changed in `/e2e-loop`, and the calibration two-liner.
- **harvest-register** — updated per the lifecycle above.
- **Memory** — a `MEMORY.md` pointer (≤200 chars) + a `memory/` topic file with the
  session's shipped fixes, graduations, runner changes, and any new trap. This is the
  deeper lessons write-back the runner deliberately leaves to you.
- **Plan-repo discipline** — explicit-path `git add` only (the new evolve-report dir + any
  touched register/index), never `git add .` / `-A`. The plan repo is committed directly on
  `main` (docs convention); the code fixes went through the PR machine in
  `references/fix-machine.md`.
