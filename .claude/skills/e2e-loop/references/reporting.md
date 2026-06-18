# reporting.md — HTML report, Time & Cost, Electron sync, teardown

Loaded at steps 4.5, 6, and 8 (see spine).

---

## Step 6 — HTML report → plan repo

Path: `~/vscode/AutoBroker/AutoBroker-dev-plan/ts-rebuild/<YYYYMMDD>-live-e2e-全技能巡检/`
Same-day re-runs: append `b`, `c`, … suffix. Self-contained `index.html`,
warm-paper ledger CSS, key sections 中文.

**Required sections (in order):**

1. **本轮品牌随机记录** — brand/model/metro/finance-type/persona (step 2.5; enables replay).
2. **逐技能表** — NL input · route · did-what · cost · latency · verdict · UI observation.
3. **Live 议价摘要** — per-dealer: initial OTD → counter rounds → final OTD (omit if dealer-brain skipped).
4. **时间与成本** — standing 3-sub-block section (detail below).
5. **问题与修复表** — S0–S6 findings + fixes (→ `references/backlog-state-machine.md`).
6. **Frontend-taste 可用性发现** — BLOCKER→POLISH ranked list (→ `frontend-taste` skill by name).
7. **本轮新 backlog** — must be empty **or** every entry tagged `live-verified, no-code-change` + one-line rationale. Untagged → back to step 4.
8. **桌面同步状态** — "desktop bundle refreshed @ commit `<hash>` — 可手测" OR "no apps/ui/src/testid change — skip 4.5".
9. **工件** — branch, commit hashes, PR URL.

Copy `xunjian/` → `<report-dir>/shots/`; remove at teardown.

---

## Time & Cost — standing section (emit every run)

**$ is tiny and stable (~$0.06–0.10/run). Wall-clock is the real cost
(~70–150 min; ~2.5h with fixes+reverify+desktop+CI).** LLM latency ≈ 7–9 min;
the rest is live 抓站, HITL waits, builds, CI loop. Never conflate them.

### TABLE 1 — Time & Cost

#### 1a — per-phase wall-clock

Agent records start/end per TodoWrite phase. Exact columns:

`阶段 / Phase` · `墙钟 / Wall-clock (min)` · `$ LLM` · `备注 / Notes`

Rows: phases 0, 1, 2, 2.5, 3-A, 3.5, 3-cleanup/3-B, 4, 4.5, 5, 6, 7, 8 + TOTAL wall-clock + TOTAL $.
Dealer-brain Opus = local subscription, $0 API-key. Mark fix-loop phases that fired.

#### 1b — per-skill telemetry (from `test_run_records`)

Single SQL dump (step 5); columns are fixed so `tools/new-day.sh` parses
mechanically (CLAUDE.md sync contract):

`技能 / Skill` · `调用 / calls` · `成本 / $ (cost_usd)` · `LLM 延迟 / latency_ms` · `均值 / mean_ms` · `输入 tok` · `输出 tok` · `失败 / fails`

Plus a TOTAL row. ~6 of 17 skills emit LLM rows; the other 11 are zero-LLM
deterministic (no row = correct). Footer: `deepseek / deepseek.chat` + note:
**"wall-clock ≫ Σ LLM latency; 差额 = live 抓站 + HITL 等待 + agent 核验 + build/CI"**.

#### 1c — run-level totals box

One line each: 总 API 成本 · 总 LLM 调用 · 总 LLM
延迟 · 巡检墙钟 · (if fixes) live 复验 run 成本/调用 · green.sh GREEN/RED ·
desktop smoke n/14 · 本轮是否触及 UI Y/N.

### TABLE 2 — 可削减项 (reduction mini-table)

Top 3–5 phases by wall-clock from section 1a. Exact columns:

`本轮慢点 / Slow this run` · `候选削减 / Candidate cut` · `预计节省 / Est. saving (min)` · `覆盖保留? / Coverage-preserved (Y/N)`

`Coverage-preserved` = `Y` for any actionable row; `N` = "rejected — coverage harm". Mark `✓ applied` when used this run. Top wall-clock sink must always appear.

Already-realized reductions (keep enforcing, do not re-propose) are tracked in `backlog-state-machine.md`.

---

## Step 5 — Telemetry capture (before pipeline_reset)

Read ONCE from the live isolated DB **before** `pipeline_reset`. `dataDir` from step-2 stdout:

```bash
SQ=/Users/wangyangxu/opt/anaconda3/bin/sqlite3
DB="<dataDir>/autobroker.db"          # dataDir from step-2 stdout
$SQ -header -column "$DB" \
  "SELECT skill, COUNT(*) calls, SUM(cost_usd) cost_usd, SUM(latency_ms) latency_ms,
          AVG(latency_ms) mean_ms, SUM(input_tokens) input_tok,
          SUM(output_tokens) output_tok,
          SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) fails
   FROM test_run_records GROUP BY skill ORDER BY cost_usd DESC"
$SQ "$DB" "SELECT printf('\$%.4f',SUM(cost_usd)), SUM(latency_ms) FROM test_run_records"
```

**Backup fallback** (if reset already ran):
```bash
BK=$(ls -t <dataDir>/backups/autobroker-*.db | head -1)
$SQ -header -column "$BK" "SELECT skill, COUNT(*) calls, … FROM test_run_records …"
```

---

## Step 4.5 — Electron sync (conditional)

Gate: `git diff --name-only origin/main` touches `apps/ui/src/` or any `data-testid`.

```bash
cd "$WT" && pnpm build && pnpm desktop:bundle && pnpm desktop:smoke   # expect 14/14
```

Report: **"桌面包已刷新 @ commit `<hash>` — 可手测"**. Smoke < 14/14 = BLOCKER.

---

## Plan-repo discipline

- `git add <report-dir>` only — never `git add .` / `-A`.
- After commit: refresh `CURRENT STATE (live)` box at top of `ts-rebuild/index.html`
  (date, verdict, PR URL). Box = canonical; reports = history.

---

## Step 8 — Memory write-back + teardown

**Two writes (mandatory):**

1. Topic file `memory/live_e2e_<YYYYMMDD><suffix>.md` — brand/metro/persona ·
   17/17 pass? · negotiation result · usability findings · defects+fixes · backlog · traps.
2. `MEMORY.md` pointer line ≤200 chars (file is over budget; detail stays in topic file).

**Teardown (in order):**

1. Kill serve-live (`pkill -f 'e2e:serve-live'` or by PID from step 2).
2. Step 7 PR merge handles branch→`main`.
3. `git worktree remove "$WT"` then delete local branch.
4. `rm -rf xunjian/ .playwright-mcp/` from repo root (not worktree root).
5. `.claude/.e2e-loop-active` removed (spine step 8).
