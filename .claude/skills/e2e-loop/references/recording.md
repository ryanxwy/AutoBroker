# recording.md — write the report, capture telemetry, hand off, tear down

Loaded at steps 6 and 7. This is where the run becomes a **deliverable**: an honest HTML
report classifying every imperfection, a row in the run ledger, and a memory pointer.
The runner records; the companion `e2e-evolve` fixes. The only fixing the runner does is
the narrow trivial/safety path below.

---

## Step 6a — record every imperfection (the three buckets)

The classification rule lives in `SKILL.md` ("How to classify what you find"). Here is
how to **record** each one so `e2e-evolve` can act on it later:

- **Blocker** — a journey-stopping issue or a safety/correctness breach. Record:
  `{ what the buyer saw · the skill + route response that proves it · a screenshot ·
  whether it was fixed in-loop or handed off }`. A blocker is handled this run **only**
  by the trivial/safety path (§6b); otherwise it is surfaced as the report headline,
  **mirrored to the harvest-register's "Open blockers (handed off)" section** (below), and
  handed to `e2e-evolve`.
- **Backlog** — a real gap that did not block the journey. Record:
  `{ observed (skill/profile/route evidence) · the buyer-value gap (not "a bug") ·
  a falsifiable fix idea · a replayable evidence_ref (run-id + skill + a rows/dataquality
  snapshot) }`. **Mirror it to `harvest-register.md`** (below).
- **Polish** — correct but rough. One line each; no evidence burden beyond a pointer.

A backlog/polish note can never excuse a blocker (the anti-masking rule in `SKILL.md`).

**Diagnosing a "hang" — server-hang vs. slowness (generalizable).** When a browser-heavy
skill (`inventory_site_scan`, `dealer_web_lead_submit`) appears stuck, distinguish a
**server-hang** (a BLOCKER — the Node event loop / listener is blocked, e.g. an
un-deadlined per-dealer browser nav) from legitimate slowness: while the skill runs, poll an
UNRELATED control endpoint (`GET /__e2e/rows?table=…`). Staying HTTP 200 at low latency ⇒
the server is healthy and the skill is merely slow; HTTP 000 / a connection timeout ⇒ the
listener has stopped accepting connections ⇒ record a **server-hang blocker** (not "slow").
This is the probe that pinpoints an event-loop hang — the class behind the 2026-06-26
`dealer_web_lead_submit` batch-submit hang.

### Known-correct behaviors — do NOT re-flag these

These have been investigated in prior runs and are **correct product behavior**. Filter
them out before recording — re-surfacing them wastes a slot and pollutes the register:

- `quote_audit` firing `DOC_FEE_CAP` (capped states: CA/NY/WA + MN/MI/OH/MD) or
  `DOC_FEE_UNCAPPED` (uncapped states, doc fee over ~$500), `MATH_SANITY` (skips when tax
  is bundled/null), `MISSING_BREAKDOWN`, `DEALER_FEE_OUTLIER` on the planted dealer
  archetypes — these are the audit doing its job.
- `quote_compare` folding cash/unspecified-mode quotes into the right bucket; "best OTD"
  reconciled to one home across the digest and compare surfaces.
- `inventory_site_scan` recording a legitimate **subset** (platform-specific: some
  dealer platforms yield many cars, some none) — not a bug; only a *total* price loss is.
- `inventory_site_scan`'s "scanned 0" empty-state being distinct from "never scanned".
- `dealer_closeout_email` counting fake sends correctly under test mode.
- `incentive_scrape` having OEM sources for Hyundai/Toyota/Honda/Chevrolet; a brand
  outside that set returning a graceful "no source", not a crash.
- The geocoder being a fixed metro fixture (no live Geocoding), and an off-allowlist
  `location_query` resolving to Irvine (a buyer-input trap, not a product bug).
- A natural-language "what's in stock" routing to `inventory_compare` (read existing),
  not `inventory_site_scan` — a router choice, not a misroute.
- `search_profile_intake` freeform prefill leaving `trim` NULL when the buyer states only a
  price/superlative intent ("cheapest"/"best") or when the LLM emits a placeholder string
  (`null`/`none`) — `sanitizePrefillTrim` drops it so the web-grounded trimSuggestion picker
  fires. (A junk trim the buyer never stated, seeded into the collect form and suppressing
  the picker, WOULD still be a backlog item — the correct behavior is the picker firing.)
  Shipped 2026-06-26 (`phase0/search_profile_intake`).
- `dealer_web_lead_submit`'s batch_review card carrying the `summary` preview block
  (vehicle / buyer email / placeholder-phone note, NEVER budget) — it survives the
  suspend-schema validation because `summary` is declared on the shared
  `BatchReviewSuspendSchema`. Shipped 2026-06-26 (`phase1/dealer_web_lead_submit`).
- `dealer_web_lead_submit` batch submit staying responsive + bounded under a multi-dealer
  batch (per-dealer timeout + isolation): a slow/failed dealer becomes a voiced
  `site_unreachable` row and the batch continues so the reachable dealers still anchor — a
  partial-failure batch is correct; only a whole-server hang / zero-anchor batch is a bug.
  Shipped 2026-06-26 (`phase1/dealer_web_lead_submit`).
- `quote_audit` NOT advising a manufacturer rebate larger than ~20% of the quote's own
  price (`selling_price ?? otd_total`): an OEM offers page is multi-model, so
  `incentive_scrape` can mis-attribute another model's cash (an EV's $7.5k onto a $31k
  compact SUV); the audit's magnitude guard suppresses the implausible `MISSING_REBATE`
  rather than advise demanding a phantom rebate. A *plausible* missing rebate (≤20%) still
  fires; a no-price quote fails open (already `MISSING_BREAKDOWN`). Re-flag ONLY if the
  audit advises a rebate that is an implausible fraction of the quote price (a regression).
  Shipped 2026-06-27 (`phase1/quote_audit` + `phase2/incentive_scrape`).
- `dealer_geosearch` EXCLUDING a cross-border (non-US) dealer from the discovered/ranked
  set + the DB: a border metro (San Diego/El Paso/Laredo) can surface an in-radius foreign
  rooftop (e.g. "Hyundai Premier Tijuana", MX) that is non-transactable for a US buyer;
  `isUsDealer` now detects Mexican border cities (name/city) + a trailing ", Mexico"
  address word, and the pure filter drops it before ranking (the headline surfaces "N
  cross-border dealer(s) excluded"). A US dealer on a Spanish-named street ("Ensenada Dr")
  correctly stays. Re-flag ONLY if a non-US dealer reaches the scan/lead/ranked set.
  Shipped 2026-06-27 (`phase2/dealer_geosearch`).

(When `e2e-evolve` ships a fix that resolves a recorded issue, it moves the corresponding
known-correct entry here so it is never re-flagged.)

---

## Step 6b — the trivial / safety in-loop fix (the ONLY fixing the runner does)

A blocker qualifies for an in-loop fix **only if both**: (a) it is a **localized** fix —
a genuine one-liner or small diff with an obvious root cause (a *localized* safety stop
counts), AND (b) it can be verified against this same serve-live. Anything research-heavy,
multi-file, or design-level — **including a multi-file safety stop** — is **recorded,
surfaced as the report headline, and handed to `e2e-evolve`** (per `SKILL.md` "How to
classify what you find": fix in-loop, or if you can't, make it the headline). "Safety
stop" is not a blanket override of the multi-file hand-off rule. Do not let the runner
grow back into the fix-everything monolith.

When a blocker does qualify, the same gates still apply (no shortcut for being small):

1. Make the minimal change inside the worktree (`$WT`); stage explicit paths only.
2. A **fresh-context** code-reviewer returns APPROVE and a safety-invariant-auditor
   returns SAFE — both **separate agents from whoever wrote the fix**.
3. `RUN_UI_FUNCTIONAL=1 bash scripts/green.sh` prints literal `GREEN` (the full UI lane
   is mandatory for any UI / testid / harness diff). See the `green` skill by name.
4. Re-verify against a **fresh serve-live** in the same `$WT` (it picks up the new build);
   the verdict is a `/__e2e/rows` / `/__e2e/audit` delta, not a screenshot.
5. Commit with the `phase0/live_e2e:` prefix (explicit paths, no Claude attribution), then
   **land it on `main`**: push, fast-forward merge, and sync local `main` to `origin`
   (`0  0`). A worktree-only commit is **lost** when teardown removes the worktree
   — and `e2e-evolve` branches off `origin/main`, so an unmerged fix would let the blocker
   silently reappear at the next hand-off.

Record the fix in the report's 工件 section. This narrow merge is the runner's ONLY write
to `main`; the deeper evolution (researching the handed-off items, working the backlog) is
`e2e-evolve`.

---

## Step 6c — capture telemetry (BEFORE pipeline_reset)

Read once from the live isolated DB **before** `pipeline_reset` wipes it. `dataDir` is
from the step-1 stdout line.

```bash
SQ=/Users/wangyangxu/opt/anaconda3/bin/sqlite3   # or any sqlite3 on PATH
DB="<dataDir>/autobroker.db"
"$SQ" -header -column "$DB" \
  "SELECT skill, COUNT(*) calls, SUM(cost_usd) cost_usd, SUM(latency_ms) latency_ms,
          AVG(latency_ms) mean_ms, SUM(input_tokens) input_tok,
          SUM(output_tokens) output_tok,
          SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) fails
   FROM test_run_records GROUP BY skill ORDER BY cost_usd DESC"
"$SQ" "$DB" "SELECT printf('\$%.4f',SUM(cost_usd)), SUM(latency_ms) FROM test_run_records"
```

If `pipeline_reset` already ran, read the pre-wipe backup:
`BK=$(ls -t <dataDir>/backups/autobroker-*.db | head -1)` then query `$BK`.

About 6 of the 17 skills emit LLM rows; the other 11 are zero-LLM deterministic (no row =
correct). The dealer subagents run on the local OAuth subscription — `$0` API-key cost.

---

## Step 6d — write the HTML report → plan repo

Home: `~/vscode/AutoBroker/AutoBroker-dev-plan/ts-rebuild/live-e2e/<run-id>/` where
`<run-id>` = `<YYYY-MM-DD>` for the day's first run, then `-run2`, `-run3`, … for same-day
re-runs. Self-contained `index.html`, warm-paper ledger CSS, key sections 中文.

**Required sections (in order):**

1. **本轮买家档案** — metro / car / finance mode / persona / email (the reproducibility
   anchor from `references/brand-picker.md`).
2. **逐技能表** — per skill: NL input · route · did-what · cost · latency · verdict · UI
   observation.
3. **Live 议价摘要** — per dealer: initial OTD → counter rounds → final OTD (omit if step
   3 was skipped).
4. **时间与成本** — the two tables below.
5. **本轮发现 (Blockers / Backlog / Polish)** — the core deliverable. Three labelled
   sub-lists, each entry with its evidence_ref. Backlog/polish are the normal, healthy
   output of a working run; a non-empty list is good.
6. **Frontend-taste 可用性发现** — the ranked usability list from step 5.
7. **桌面同步状态** — "no UI change — n/a" unless a trivial in-loop fix (§6b) touched
   `apps/ui/src` or a `data-testid`, in which case rebuild + `pnpm desktop:smoke` (expect
   14/14) and note the commit.
8. **多档案 cross-shop 摘要** *(only when step 4 ran)* — assert the
   `MAX_CONCURRENT_ACTIVE_PROFILES` value the cap held at; each profile's terminal status
   (no starve/wedge); the shared-dealer winner + voiced losers (zero send confirmed);
   nothing sent for real; `runAllInvariants` all-ok (or violations frozen to the replay
   corpus); and `pnpm soak mp-replay` GREEN as the deterministic backstop.
9. **工件** — branch, commit hashes, any in-loop trivial fix, links.

Copy any screenshots into `<report-dir>/shots/`.

### Time & Cost — two tables (emit every run)

**The dollar cost is tiny and stable (~$0.06–0.15/run). Wall-clock is the real cost
(~70–150 min). Never conflate them** — LLM latency is ≈7–9 min; the rest is live page
scraping, human-approval waits, builds.

**TABLE 1 — per-phase wall-clock.** Columns: `阶段 / Phase` · `墙钟 / Wall-clock (min)` ·
`$ LLM` · `备注 / Notes`. One row per journey step that ran, plus a TOTAL wall-clock and
TOTAL $. Mark any step where a trivial in-loop fix fired.

**TABLE 1b — per-skill telemetry** (from `test_run_records`, the step-6c dump). Fixed
columns so the daily sync parses them mechanically: `技能 / Skill` · `调用 / calls` ·
`成本 / $ (cost_usd)` · `LLM 延迟 / latency_ms` · `均值 / mean_ms` · `输入 tok` ·
`输出 tok` · `失败 / fails`, plus a TOTAL row.

**TABLE 2 — 可削减项** (top 3–5 wall-clock sinks). Columns: `本轮慢点 / Slow this run` ·
`候选削减 / Candidate cut` · `预计节省 / Est. saving (min)` · `覆盖保留? / Coverage-kept
(Y/N)`. The top wall-clock sink always appears; mark `✓ applied` when used this run.

### The metadata line + ledger rebuild

The ledger at `ts-rebuild/live-e2e/index.html` is auto-built — never hand-edit its rows.

1. **E2E-META line** — one comment line right after `<head>`. ` | `-separated
   `key=value`, summary last; values must be free of `|`, `--`, and raw `< > &`. All 15
   fields, use `—` when N/A:
   `run | date | vehicle | metro | mode | persona | skills | nego | findings | cost | wall | commit | pr | verdict | summary`
   - `run` = the run-id · `skills` = `17/17` (or `N/N` for a sub-arc) · `nego` = e.g.
     `2r → $33,400` or `—` · `findings` = the bucket counts, e.g. `0 blk · 5 bklg · 3 pol`
     · `pr` = `—` for the runner (it does not open PRs) · `verdict` = one of
     **`complete` | `partial` | `blocked`** (the journey outcome — `partial` = some step
     incomplete; `blocked` = an unworked safety blocker; the bucket counts live in
     `findings`).
2. **Rebuild** — from `ts-rebuild/`, run `bash tools/build-e2e-index.sh`. It rescans every
   report's E2E-META line and regenerates the reverse-chron ledger table (pure bash +
   python3, read-only on the code repo).

### Mirror backlog to the harvest-register

Append each new backlog item to `ts-rebuild/live-e2e/harvest-register.md` — the cross-run
accumulator `e2e-evolve` reads. Use **semantic dedup**: if the same buyer-value gap was
recorded in a prior run, **bump its `recurrence`** rather than adding a duplicate row. The
runner is the only actor that re-observes a gap live, so the **runner owns the recurrence
counter**; `e2e-evolve` only reads it (to prioritize and graduate), never increments it.
Explicit-path `git add` only — never `git add .` / `-A`.

**Handed-off blockers go here too.** A blocker you did NOT fix in-loop is the
highest-priority item there is — it must not fall off the rolling report window. Mirror it
to the harvest-register's **"Open blockers (handed off)"** section (run-id + a one-line
headline + evidence_ref). `e2e-evolve` drains that section first and carries every open
blocker forward across sessions until it is fixed. (The runner appends observations + bumps
recurrence; `e2e-evolve` prioritizes, graduates, fixes, and clears.)

### Refresh the live-status box

Replace (do not append) the single latest-run paragraph in the `CURRENT STATE (live)` box
at the top of `ts-rebuild/index.html` with this run's (date, verdict, the bucket counts, a
`Full report →` link to `live-e2e/<run-id>/index.html`). The box keeps only the newest
run + the ledger link; the ledger is the canonical history.

---

## Step 7 — teardown + memory pointer

**Memory pointer (one write):** add a `MEMORY.md` pointer line ≤200 chars
(`memory/live_e2e_<YYYYMMDD><suffix>.md` topic file for the detail: buyer profile · journey
complete? · negotiation result · the bucket counts + the top 2–3 findings · any in-loop
fix · traps). The runner records the run; the deeper lessons write-back is `e2e-evolve`'s.

**Teardown (in order):**

1. Kill serve-live (`pkill -f 'e2e:serve-live'` or by the PID from step 1).
2. `git worktree remove "$WT"` then delete the local branch (a full run with no in-loop
   fix leaves nothing to merge; a trivial in-loop fix was already committed + merged in
   §6b).
3. `rm -rf .playwright-mcp/` from the repo root and any `shots/` staging dir.
4. `rm .claude/.e2e-loop-active` (also on any abort).
