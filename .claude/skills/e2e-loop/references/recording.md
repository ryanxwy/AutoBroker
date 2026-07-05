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

**UI-monitor findings — same buckets, `monitor` provenance.** Findings returned by the UI-monitor
subagent (`references/ui-monitor.md`) enter the SAME three buckets, tagged `monitor` as provenance;
dedup against the driver's findings by surface/testid before recording — one finding, one entry.
frontend-taste keeps its own report subsection (§6d); the monitor does NOT get a separate findings
section.

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

- `quote_audit` firing `DOC_FEE_CAP` (capped CA/NY/WA + MN/MI/OH/MD), `DOC_FEE_UNCAPPED` (uncapped,
  >~$500), `MATH_SANITY` (skips bundled/null tax), `MISSING_BREAKDOWN`, `DEALER_FEE_OUTLIER` on the
  planted archetypes = the audit working. Re-flag ONLY a pill contradicting its own state/threshold rule. (baseline)
- `quote_compare` folding cash/unspecified-mode quotes into the right bucket; one "best OTD" home
  across digest + compare. Re-flag ONLY if the two surfaces disagree on best OTD. (baseline)
- `inventory_site_scan` recording a platform-specific **subset** (some platforms yield many cars,
  some none). Re-flag ONLY a *total* price loss. (baseline)
- `inventory_site_scan` "scanned 0" empty-state distinct from "never scanned". Re-flag ONLY if the
  two states render identically. (baseline)
- `dealer_closeout_email` counting fake sends correctly in test mode. Re-flag ONLY a wrong count
  (e.g. "0 sent" with fake_mailbox rows written). (baseline)
- `incentive_scrape` OEM sources = Hyundai/Toyota/Honda/Chevrolet; an off-set brand → graceful
  "no source". Re-flag ONLY a crash on an off-set brand. (baseline)
- The geocoder is a fixed metro fixture (no live Geocoding); an off-allowlist `location_query` →
  Irvine (a buyer-input trap). Re-flag ONLY an allowlisted metro misresolving. (baseline)
- NL "what's in stock" → `inventory_compare` (read existing), not `inventory_site_scan` — a router
  choice. Re-flag ONLY an explicit "scan dealer sites" ask landing on compare. (baseline)
- `search_profile_intake` freeform prefill leaves `trim` NULL on a price/superlative-only intent or an
  LLM placeholder (`sanitizePrefillTrim`) so the trimSuggestion picker fires. Re-flag ONLY a junk
  never-stated trim seeded into the form, suppressing the picker. Shipped 2026-06-26 (`phase0/search_profile_intake`).
- `dealer_web_lead_submit` batch_review card carries the `summary` preview (vehicle / buyer email /
  placeholder-phone note, NEVER budget), declared on the shared `BatchReviewSuspendSchema`. Re-flag
  ONLY a budget leak or a suspend-schema validation failure. Shipped 2026-06-26 (`phase1/dealer_web_lead_submit`).
- `dealer_web_lead_submit` batch stays responsive + bounded (per-dealer timeout + isolation); a slow
  dealer → voiced `site_unreachable` row, batch continues. Re-flag ONLY a whole-server hang or a
  zero-anchor batch. Shipped 2026-06-26 (`phase1/dealer_web_lead_submit`).
- `quote_audit` suppresses a `MISSING_REBATE` above ~20% of the quote's own price (multi-model OEM-page
  mis-attribution); a plausible ≤20% rebate still fires; no-price → `MISSING_BREAKDOWN`. Re-flag ONLY
  advising an implausible-fraction rebate. Shipped 2026-06-27 (`phase1/quote_audit` + `phase2/incentive_scrape`).
- `dealer_geosearch` EXCLUDES a cross-border (non-US) rooftop (`isUsDealer`: border cities + ", Mexico"),
  voiced in the headline; a US dealer on a Spanish-named street stays. Re-flag ONLY a non-US dealer
  reaching the scan/lead/ranked set. Shipped 2026-06-27 (`phase2/dealer_geosearch`).
- `negotiation-detail-modal` closes on Close/Escape/backdrop and STAYS closed across a `data.changed`
  refresh (visibility gated on `openId`, not the fetch cache) — DISMISS-VERIFY every run. Re-flag ONLY
  won't-dismiss or auto-reopen without a re-click (HIGH regression). Shipped 2026-06-28 (`phase0/ui`, `52d1648`).
- HTML-only dealer email body recovered to text via `stripHtmlToText` (deliberate oracle-superseding fix;
  a marketing blast now yielding a quote-signal = backlog if misleading, never a blocker). Re-flag ONLY a
  quote-bearing email still persisting empty `body_text` after mapping. (baseline)
- (F1) `inventory_site_scan` listings with no labeled markup/add-ons: `markup_present==0` /
  `addons_present==0` on `/__e2e/dataquality` is the HEALTHY norm (LABELED-only detection, never inferred
  selling>MSRP). Re-flag ONLY the breakdown total-loss (`vdp_linked>0 AND breakdown_parsed==0`). (baseline)
- (F2) `dealer_reply_extract` structured-output fail-closed: when `emit_result` never fires (or its args
  fail Zod) the hop throws a typed `EmitResultNotCalledError` / `ZodError` + one ledgered failReason row —
  no retry lane, no retry button. Re-flag ONLY a silent tool-SKIP / regex-execute / fabrication. (baseline)
- (F4) the give-up/switch advisory (`dealer-verdict-hold` / `dealer-verdict-switch`) + per-thread
  `thread-class-chip` firing on a ghosted/retraded dealer = the derived-on-read engine working. Re-flag
  ONLY a competing-dealer-NAME/budget leak (inv #9) or switch advice with no cheaper same-mode quote. (baseline)
- `inventory_compare` RECOMMENDS an in-budget exact/near `inventory_status='unknown'` listing with the
  `inventory-availability-caveat` chip (score≥0.6 + exact/near gates hold; `ordered`/`sold` stay excluded).
  Re-flag ONLY a recommended row whose live VDP shows sold/pending (the H5 scraper gap). Shipped 2026-06-28 (`phase1/inventory_compare`, `0c61e0d`).
- `quote_audit` NOT firing `MATH_SANITY` on a small POSITIVE residual (stated OTD over itemized sum,
  ≤~$1000, tax present) — a dropped "TT&L" line; trust advisory, not a safety gate. Re-flag ONLY a missed
  >$1000 shortfall or a fire on computed-OVER-stated. Shipped 2026-06-28 (`phase1/quote_audit`, `1111962`).
- `dealer_geosearch` EXCLUDES an off-brand-only rooftop + MERGES a co-located same-website duplicate
  (both counted + voiced; neutral/multi-brand/unknown-make names kept, fail-open). Re-flag ONLY a dropped
  real searched-make rooftop (H3 sibling-franchise) or an over-merge. Shipped 2026-06-28 (`phase2/dealer_geosearch`, `7375aa1`).
- Lane-B (Claude OAuth) telemetry: `input_tokens` is cache-INCLUSIVE (input + cache_creation + cache_read)
  and `AUTOBROKER_RECORD_TRANSCRIPT` tees lane B to a sibling `<path>.laneB.jsonl`. Re-flag ONLY an
  implausibly-tiny lane-B `input_tokens` on a large prompt, or a missing sibling. Shipped 2026-06-29 (`phase0/provider_select`, `1d679d9`).
- `inventory_site_scan` 0-yield with `rendered_empty_count>0` = host thrash (an environment signal, NOT a
  product/lane bug — read it before blaming a provider; `==0` = genuine no-stock or blocked). Re-flag ONLY
  a had-and-lost (`vdp_linked>0 AND breakdown_parsed==0`), never a thrash 0-yield. Shipped 2026-06-29 (`phase2/inventory_site_scan`, `44c802c`).
- `negotiation_followup` drafts GROUNDED in `financing_preference` (finance ⇒ plans-to-finance/APR ask,
  never "cash"; cash ⇒ never financing/lease); `assertPaymentMethodConsistent` fail-CLOSES a contradiction
  (negation/contrast-guarded). Re-flag ONLY a draft contradicting the profile's payment method. Shipped 2026-06-30 (`phase5/negotiation_followup`, `0a0bdee`).
- A no-fresh-number reply (hold / payment-only / come-onsite) persists `otd_total` NULL (not $0) and never
  supersedes the dealer's real OTD on board/digest/compare/latest views (recorded, never ranks; migration
  `0006` healed $0 rows). Re-flag ONLY a $0/null reply ranking or hiding a real OTD. Shipped 2026-06-30 (`phase2/negotiation_followup`, `60ae1db`).
- The "at or below best" advisory keys on the lowest REAL competing OTD (non-itemized counts): above-best
  reads "close to"/signed gap; `give_up_switch` stays strict-itemized-BATNA-only; board + modal show the
  SAME gap. Re-flag ONLY "at or below" on an above-best quote, or `give_up_switch` on a lone non-itemized lowball. Shipped 2026-06-30 (`phase2/negotiation_followup`, `60ae1db`).

- `inventory_aggregator_scan` opening HEADED (visible) serial browser windows — deliberate
  (Cloudflare/Akamai edge-block the headless UA; honest posture, zero UA/fingerprint
  masquerade). These now often appear UNPROMPTED, right after a site_scan completes, because
  the aggregator is AUTO-CHAINED (see the chain entry below). Re-flag ONLY a headless
  regression re-appearing as both-sites-`blocked` within seconds of launch. Shipped
  2026-07-03 (`phase2/inventory_aggregator_scan`).
- `inventory_aggregator_scan` keeping <10 or 0 with the voiced kept line `Kept N listing(s)
  matching your <trim> trim` + parens ("M didn't match your exact search", "K not yet in
  stock"), or a voiced per-site drop ("blocked automated scanning" / "couldn't confirm your
  location — skipped its results this run") = the trim-match/location keep-set working
  (iSeeCars absent by design — launch adapters are Cars.com + Edmunds only). Re-flag ONLY the
  suspect-0 (kept 0 while site_scan holds ≥3 in-radius exact matches — skill-pipeline.md item
  4) or an UNVOICED site drop. Shipped 2026-07-03 (`phase2/inventory_aggregator_scan`).
- `inventory_site_scan` completing and IMMEDIATELY spawning an UNPROMPTED
  `inventory_aggregator_scan` assistant turn (+ its headed browser windows) — the
  site_scan→aggregator AUTO-CHAIN (an app-layer lifecycle listener: the parent turn voices
  `Also checking shopping sites (Cars.com, Edmunds)…` before its `done`, and the sibling
  streams as its own turn for the SAME profile). Deliberate; serve-live runs it at the
  product default ON (`AUTOBROKER_SITESCAN_CHAIN` unset). A declined/failed/profile-less
  site_scan never chains, and the aggregator never chains further (no recursion) — both
  correct. Re-flag ONLY: the chain firing while `AUTOBROKER_SITESCAN_CHAIN=0`; firing TWICE
  for one parent site_scan; or a healthy COMPLETED site_scan in the live sweep producing NO
  chained turn. Shipped 2026-07-03 (`phase2/inventory_aggregator_scan` chain).
- The chat rail MINIMIZED (`chat-rail` height 0 + `chat-launcher` present) — the designed
  session-only minimized state since the 2026-07-04 workbench rebalance; it auto-restores on
  rail-track gates. Re-flag ONLY a minimized rail that does NOT restore via the launcher or a
  rail-tracked gate. Shipped 2026-07-04 (`phase6/ui` workbench rebalance).
- The `chat-launcher` floating button bottom-right (with `needs-you-widget` raised above it
  while minimized) — a designed floating element, never an overlap/covered defect. Shipped
  2026-07-04 (`phase6/ui` workbench rebalance).
- `dealer_reply_extract` demoting a $/mo reply with an INCOMPLETE mode (lease w/o
  money-factor+residual, finance w/o APR) to a `financing_mode='unspecified'` provenance row
  with otd NULL — the number was genuinely un-completable, so this is CORRECT fail-closed
  demotion (`reclassifyRule2Failures`), NOT had-and-lost data-loss. Re-flag ONLY a `failed`
  message or a `zod_validation` fail_reason on a $/mo body, OR a COMPLETE lease/finance being
  demoted (that would lose real quote data). Shipped 2026-07-04 (`phase3/dealer_reply_extract`
  `73077c5`).
- `negotiation_followup` skipping a thread whose draft call failed (draft_body null, voiced
  `X thread(s) failed to draft`, thread stays a candidate) while gating + sending the rest —
  the designed per-thread fail-closed degradation (inv #4), never a fabricated draft. Re-flag
  ONLY a single draft failure zeroing the whole batch (0 sends) again. Shipped 2026-07-04
  (`phase3/negotiation_followup` `a3e0d78`).

- `inventory_aggregator_scan` persisting a trim EQUAL to the profile trim (no `<word> <word>`
  self-repeat) — `resegmentModelTrim` de-doubles a trim the LLM left in BOTH the model and
  trim fields (model "RAV4 XLE" + trim "XLE" no longer persists "XLE XLE"), so a genuine exact
  listing keeps `match_status='exact'`. Re-flag ONLY a self-repeated trim in an
  `aggregator_srp` row (`inventory-candidate-trim` showing "XLE XLE"), or a real exact-trim
  listing reading `near`. Shipped 2026-07-05 (`phase2/inventory_aggregator_scan` `6392ede`).
- `inventory_site_scan`/persist nulling an MSRP that is inverted below the observed listed
  price (a cross-source SRP-price + mismatched-VDP-msrp mis-parse) while keeping the observed
  price — the derived MSRP is dropped, the markup signal (a separate labeled field) is
  untouched. Re-flag ONLY a persisted `inventory_listings` row with `msrp>0 AND
  msrp<listed_price`, or a nulled msrp on an at/above-price listing. Shipped 2026-07-05
  (`phase2/inventory_site_scan` `7de7ba3`).
- The overview `canvas-summary-headline` quote count refetching after
  `dealer_reply_extract`/`quote_pipeline` (the `data.changed` pulse now carries `digest`), so
  it stays consistent with `canvas-summary-best-otd` WITHOUT a manual `daily_digest`. Re-flag
  ONLY a stale "0 quote(s)" headline sitting beside a populated best-OTD after an extract.
  Shipped 2026-07-05 (`phase4/daily_digest` `a7c927c`).
- A STOP / clarify / post-reset run NOT ACCRUING `GET /api/profiles/<null|deleted-id>` 404s
  (the Canvas explicit-fetch closure skips a null or no-longer-active pin). The null-pin path
  is fully skipped. KNOWN BOUNDED RESIDUAL: on the FIRST `pipeline_reset` pulse the closure
  can read stale `profiles.data` (the fresh list hasn't landed in that synchronous
  `invalidate()` tick) so ONE `/api/profiles/<deleted-id>` may still fire before it
  self-corrects — the fix stops the accrual (1→5), not the single reset-tick race. Re-flag
  ONLY a recurring `/api/profiles/null` on a no-profile run, or a REPEATING/accruing
  post-reset stale-pinned-id fetch (a single one on the reset tick is the known residual →
  seasoned candidate 2026-07-05 #5, live-confirm before any follow-up). Shipped 2026-07-05 (`phase0/ui` `7bcc17a`).

(When `e2e-evolve` ships a fix that resolves a recorded issue, it moves the corresponding
known-correct entry here so it is never re-flagged.)

---

### Buyer-email probe findings

When the optional buyer-email probe ran this session, record its findings in a
**"Buyer-email probe"** sub-section inside **本轮发现**, separate from the 18-skill
逐技能表. Apply the same three-bucket rules: a broken real-read capability is a
blocker or backlog; a low coverage ratio is backlog with a falsifiable fix idea;
cosmetic oddities are polish. Mirror backlog items to `harvest-register.md`
(semantic dedup, bump recurrence on re-discovery) using `probe-<YYYY-MM-DD>` as the
`evidence_ref` plus the JSON coverage object as the snapshot. `e2e-evolve` drains
this section the same way it drains any other backlog entry.

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
  "SELECT skill, provider, pricing_source, COUNT(*) calls, SUM(cost_usd) cost_usd,
          SUM(latency_ms) latency_ms, AVG(latency_ms) mean_ms, SUM(input_tokens) input_tok,
          SUM(output_tokens) output_tok,
          SUM(CASE WHEN fail_reason IS NOT NULL THEN 1 ELSE 0 END) fails,
          SUM(CASE WHEN fail_reason='emit_result_not_called' THEN 1 ELSE 0 END) emit_not_called
   FROM test_run_records GROUP BY skill, provider, pricing_source ORDER BY cost_usd DESC"
"$SQ" "$DB" "SELECT printf('\$%.4f',SUM(cost_usd)), SUM(latency_ms) FROM test_run_records"
```

If `pipeline_reset` already ran, read the pre-wipe backup:
`BK=$(ls -t <dataDir>/backups/autobroker-*.db | head -1)` then query `$BK`.

About 7 of the 18 skills emit LLM rows (`inventory_aggregator_scan` joined the emitters —
it reuses the `inventory_extract` useCase; and because the site_scan→aggregator AUTO-CHAIN
fires it after every completed site_scan, **every site_scan journey now ALSO yields
aggregator ledger rows** even when you never launched the aggregator by hand); the other 11
are zero-LLM deterministic (no row = correct). Lane-B (Claude OAuth) rows are `cost_usd` NULL + `pricing_source='subscription'` — an
honest NULL, never a fabricated $0. Render them `cost=NULL · subscription` and never sum them
into the $ totals (the `SUM` above skips NULLs — keep it that way). The dealer subagents run on
the local OAuth subscription — `$0` API-key cost (lane-independent).

---

## Step 6d — write the HTML report → plan repo

Home: `~/vscode/AutoBroker/AutoBroker-dev-plan/ts-rebuild/live-e2e/<run-id>/` where
`<run-id>` = `<YYYY-MM-DD>` for the day's first run, then `-run2`, `-run3`, … for same-day
re-runs. Self-contained `index.html`, warm-paper ledger CSS, key sections 中文.

**Required sections (in order):**

1. **本轮买家档案** — metro / car / finance mode / persona / email / provider lane
   (deepseek api-key | claude OAuth subscription) — the reproducibility anchor from
   `references/brand-picker.md`.
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

Copy any screenshots into `<report-dir>/shots/`; the UI-monitor's checkpoint shots land there
too, named `<checkpoint>-<tab>.png`.

### Time & Cost — two tables (emit every run)

**The dollar cost is tiny and stable (~$0.06–0.15/run). Wall-clock is the real cost
(~70–150 min). Never conflate them** — LLM latency is ≈7–9 min; the rest is live page
scraping, human-approval waits, builds.

**TABLE 1 — per-phase wall-clock.** Columns: `阶段 / Phase` · `墙钟 / Wall-clock (min)` ·
`$ LLM` · `备注 / Notes`. One row per journey step that ran, plus a TOTAL wall-clock and
TOTAL $. Mark any step where a trivial in-loop fix fired.

**TABLE 1b — per-skill telemetry** (from `test_run_records`, the step-6c dump). Fixed
columns so the daily sync parses them mechanically: `技能 / Skill` · `provider/lane` ·
`调用 / calls` · `成本 / $ (cost_usd)` · `LLM 延迟 / latency_ms` · `均值 / mean_ms` ·
`输入 tok` · `输出 tok` · `失败 / fails`, plus a TOTAL row. Lane-B cost cells read
`NULL·subscription` (never a fabricated $0; excluded from the $ TOTAL).

**TABLE 2 — 可削减项** (top 3–5 wall-clock sinks). Columns: `本轮慢点 / Slow this run` ·
`候选削减 / Candidate cut` · `预计节省 / Est. saving (min)` · `覆盖保留? / Coverage-kept
(Y/N)`. The top wall-clock sink always appears; mark `✓ applied` when used this run.

### The metadata line + ledger rebuild

The ledger at `ts-rebuild/live-e2e/index.html` is auto-built — never hand-edit its rows.

1. **E2E-META line** — one comment line right after `<head>`. ` | `-separated
   `key=value`, summary last; values must be free of `|`, `--`, and raw `< > &`. All 15
   fields, use `—` when N/A:
   `run | date | vehicle | metro | mode | persona | skills | nego | findings | cost | wall | commit | pr | verdict | summary`
   - `run` = the run-id · `mode` = `<mode>·<provider>` (e.g. `full·claude`, `light·deepseek`)
     — the lane rides inside `mode`: still 15 fields, no parser change (values stay free of
     `|`, `--`, raw `< > &`) · `skills` = `18/18` (or `N/N` for a sub-arc) · `nego` = e.g.
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
