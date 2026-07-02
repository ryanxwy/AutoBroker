# harness-boundaries.md

Contract for `pnpm e2e:serve-live` (the live e2e-loop sweep host). The functional/dry-run
host (`harness/serverHost.ts`) shares the isolation philosophy but stubs
differently — this file covers the **live** host only.

---

## Run envelope

`node apps/ui/e2e/serve-live.mjs` — plain node, no tsx loader. Imports resolve
to built `@autobroker/*` dist (build first). Boots the real `@autobroker/server`
and serves the real built `apps/ui/dist`.

**One JSON line on stdout**, then listening on fixed **port 8131**:
```json
{"liveE2e":"listening","url":"http://127.0.0.1:8131","port":8131,"dataDir":"<tmp>"}
```
Wait for this line; **record `dataDir`**.

| Property | Value |
|---|---|
| Data dir | fresh `mkdtemp(…autobroker-live-e2e-*)` unless `AUTOBROKER_LIVE_E2E_REUSE_DIR` set |
| `AUTOBROKER_DB` | **deleted** — no stray override |
| `NODE_ENV` | `test` — arms the intake-deps seam guard |
| `AUTOBROKER_TEST_AUTO_APPROVE` | **deleted — NEVER set** (CLAUDE.md inv #11; keeps decline path live) |
| `AUTOBROKER_MODE` | `"test"` — the sole send-control variable; every send resolves fake/local |
| `AUTOBROKER_AGENT_PROVIDER` | exported by the runner per `--provider` BEFORE boot; the server reads it as the default agent selection. Exact strings `claude` \| `deepseek` only — **anything else silently resolves to the DeepSeek policy default** (why the spine's lane-took-effect check exists). Unset = DeepSeek |
| `DEEPSEEK_API_KEY` | lane-A credential — **not pinned**; boot's `loadDotEnvKeys` reads it from `.env` (no-clobber) |
| `CLAUDE_CODE_OAUTH_TOKEN` | lane-B credential (read from `.env`/keys, no-clobber); absent → every lane-B call fails closed |
| `AUTOBROKER_RECORD_TRANSCRIPT` | optional; when set, records the SUT's LLM traffic to a JSONL file (the step-3.9 record/replay seam). Lane A (AI-SDK) → `<path>`; lane B (Claude OAuth) → sibling `<path>.laneB.jsonl` (diagnostic-only, since 2026-06-29) |
| `AUTOBROKER_REPLAY_TRANSCRIPT` | optional; when set, replays a prior transcript with ZERO provider cost (deterministic; dealer replies are frozen as seeds) |
| `AUTOBROKER_PORTFOLIO_SCHEDULER` | `"1"` arms the real PortfolioScheduler for step 3.9; pair with `MAX_CONCURRENT_ACTIVE_PROFILES` (set below the active count to prove the cap) and `AUTOBROKER_PORTFOLIO_TICK_MS` (e.g. 2000) |

Result: real server + real built UI + isolated throwaway DB (never touches
`~/.autobroker*`) + the run's live LLM lane (`--provider`) + fake-send floor armed +
never auto-approve.

### Mode model (test vs buyer)

1. **`AUTOBROKER_MODE` is the SOLE send-control var.** Only the literal string `"test"`
   = test; **anything else** (including a typo/garbage value) resolves buyer-capable.
2. **The L2 human-approval gate is MODE-BLIND** — always-on in BOTH modes. `test` only
   makes the FAKE adapter the target; it never removes the per-action approval floor.
3. **The irreversible boundary is exactly 2 network lines** (`adapter.send`;
   `page.click(submitSelector)`) behind **3 fresh-reading `!isBuyerMode` brakes**
   re-asserted at each network boundary.
4. **Browser nav + SRP scraping are mode-INDEPENDENT** — already REAL in test mode
   (only `submitForm` is gated). serve-live already mimics buyer maximally up to the
   safe line; **"buyer-read / fake-write" is NOT expressible** (you cannot half-arm a
   real submit).
5. **The serve-live tmp dir is under `os.tmpdir()`, NOT `~/.autobroker-ts`** — so the
   data-dir denylist does NOT protect it. The rings that hold here are the **test-mode
   floor** + the **missing OAuth token** (no real Gmail credential to send through),
   not the denylist.

**IMMUTABLE-MODE GUARDRAIL.** `assertTestModeSafe` fires **ONLY at boot**. **Never**
PUT/POST `app_mode=buyer` (or flip the TopBar) on a running serve-live host — a live
flip arms a real adapter on the NEXT send with **no second env ring** to catch it. Mode
is launch-time, immutable for the run's lifetime.

**The geocoder is the only stubbed collaborator** (`__setIntakeDepsForTests`).
`harnessGenerate` stays real — trim-verify, `dealer_reply_extract`, negotiation
drafts all hit the real provider.

Migrations: the full committed `_journal.json` set applied to the fresh DB; a
reused dir is detected via the `accounts` table and skipped (idempotent). One
seed account inserted.

---

## The control routes

All registered by the test host on `built.app` **outside `/api`** (the product
wall is untouched). Each opens its own short-lived `openDb()` handle and closes
it in `finally`. Seed ONLY through these — see "External-SQLite invisible" below.

### `POST /__e2e/inject_replies` — seed the dealer-reply corpus

**Payload:** `{ profileId: string, replies: [{ dealer_id?, dealerName, dealerWebsite, from, subject, body, attachment? }] }`

`dealer_id` (optional but **strongly preferred**): the geosearch `dealer_id` for this rooftop (read it from `SELECT dealer_id, name, website FROM dealers`). When present the reply BINDS to the existing geosearch dealer and **upgrades it to `bound`** instead of minting a duplicate `live-dealer-*` row — keeping one card per rooftop so the Negotiations board and the F4 give-up chips line up with the geosearch tiles. Omit it only for a pure inject-without-geosearch case; `dealer_key` (B2 shared-dealer) still works and is mutually exclusive with `dealer_id`.

**Side effects per reply (via `injectDealerReplies`):**
- a `dealers` row with `contact_email = reply.from` (the last-resort fallback in the reply-target ladder — without it `negotiation_followup`/`dealer_closeout_email` resolve null targets); a supplied `dealer_id` reuses the existing geosearch row (`ON CONFLICT … SET contact_email`)
- a `profile_dealers` bind (upgrade-only to `bound`: a reused geosearch `candidate` is promoted; a shared-dealer 2nd profile stays `candidate`, never downgraded)
- a `threads` row `state='replied'` with a non-null `gmail_thread_id` (`live-gthread-…`) — required; a null anchor on a non-null thread trips `thread_flag_mismatch` and closeout fails closed
- an inbound `messages` row `quote_extraction_status='pending'`
- a fake-mailbox thread+message (`fake-${threadId}`) the `FakeGmailAdapter` reads; optional attachment bytes written

**Response:** `{ ok:true, applied:{ dealers, threads, messages, attachments, threadIds } }`
where **`applied.threadIds[] = [{ dealerName, from, threadId }]`** — echo the dealer-brain needs to post in-thread counters.

**When:** after profile exists (ideally after `dealer_web_lead_submit`), before `dealer_inbox_check` / `dealer_reply_extract`.

---

### `POST /__e2e/inject_reply_to_thread` — add a same-thread dealer counter

**Payload:** `{ threadId, from, subject, body, dealerName }`

**Side effects (via `injectReplyToThread`):** looks up the thread's `search_profile_id`; returns `{ ok:false, error:"unknown threadId (call inject_replies first)" }` if the thread is unknown. Appends **one new inbound `pending` messages row** on the same `thread_id` + a sibling message into the same `fake-${threadId}` fake thread — a 2+-message conversation — using the **shared monotonic `injectSeq` clock** so round-2's timestamp is strictly after round-1.

**Response:** `{ ok:true, threadId, messageId, messages }`

**When:** a dealer's round-2+ counter in multi-round negotiation. `threadId` MUST come from a prior `inject_replies` response — you cannot mint one. Re-running `dealer_reply_extract` after injection re-extracts the new pending message → a fresh `dealer_quotes` row with the revised OTD; latest quote wins downstream.

---

### `POST /__e2e/inject_crm_threads` — seed CRM-only noise for `dealer_hygiene`

**Payload:** `{ profileId, dealers: [{ dealerName, from, subject, body, intent? }] }` (`intent` defaults to `"nurture"`)

**Side effects (via `injectCrmThreads`):** per dealer — a bound dealer; an outbound sibling thread+message (satisfies hygiene's 5b "real conversation EXISTS" clause); an inbound-only CRM thread+message; and a **`message_analysis(is_current=1, intent='nurture')` row** — the exact table hygiene's 5b CRM-only detector reads. No quotes/offers (those disqualify the thread from cleanup).

**Response:** `{ ok:true, applied:{ dealers, crmThreads, analyses } }`

**When:** BEFORE inspecting `dealer_hygiene` — otherwise its 3-stage destructive gate has nothing to triage and reports "already clean". (`inject_replies` alone does NOT write `message_analysis`.)

---

### `POST /__e2e/inject_contact` — add a new dealer-contact on a thread (manager escalation)

**Payload:** `{ threadId, email, displayName?, role?, isPrimary? }`

**Side effects (via `injectContact`):** looks up the thread's dealer + `search_profile_id`; inserts a new `dealer_contacts` row (then links it), so a round-2+ reply can arrive from a *different, higher-titled* sender (sales manager / GM) than the first salesperson — the escalation `negotiation_followup` must re-target. Returns `400` on an unknown `threadId`.

**Response:** `{ ok:true, contactId, … }`

**When:** the manager-escalation beat in step 3.5 / 3.9 — pair it with an `inject_reply_to_thread` from the new `email` so the thread shows a higher-authority counter. Verify via `/__e2e/rows?table=dealer_contacts`.

---

### `GET /__e2e/audit?action=` — verify audit_log writes

Counts `audit_log` rows, optionally filtered by `?action=` → `{ action, count }`.

**When:** prove a write landed or assert a decline produced Δ0 after any skill.

---

### `GET /__e2e/rows?table=` — count product-table rows

Counts rows in one allow-listed table → `{ table, count }`. Returns `400 { ok:false, error:"unknown table" }` for any table not in the whitelist.

**Allow-list (14 tables):** `dealer_quotes`, `quote_audits`, `messages`, `dealers`, `dealer_contacts`, `profile_dealers`, `threads`, `search_profiles`, `lead_submissions`, `manufacturer_incentives`, `inventory_listings`, `audit_log`, `fake_mailbox_messages`, `message_analysis`.

**When:** verify writes / assert decline = Δ0 after any skill; assert `search_profiles = 0` after per-PASS cleanup.

**`/__e2e/rows` is COUNT-ONLY — it returns `{table,count}` and CANNOT see a
column.** A scan that writes 10 listings with every `listed_price`/`msrp` NULL
reads `count:10`, identical to 10 good rows. For data-bearing skills the verdict
is the data-quality route below, NOT this count.

---

### `GET /__e2e/dataquality?skill=<name>&profileId=<id>` — per-skill USABILITY coverage

Returns the COVERAGE of the load-bearing fields the downstream pipeline consumes
(not a count), plus the structural escapes that distinguish a legitimately-empty
result from silent data-loss. `profileId` optional (omit = whole DB). A `skill`
not in the supported set → `400 { ok:false, error:"unknown dataquality skill" }`.
Test-host only; product wall untouched; a primary verdict signal.

- `skill=inventory_site_scan` → `{ skill, n, metric:"price_coverage", covered,
  coverage, priced, msrp_present, gated, vdp_linked, nullEscape,
  breakdown_parsed, breakdown_coverage, markup_present, addons_present,
  rendered_empty_count, scanned_sources }` over
  `inventory_listings WHERE superseded_at IS NULL`. **Hard FAIL iff `n>0 AND
  priced==0 AND msrp_present==0 AND gated==0`** (TOTAL price loss — the 2026-06-22
  miss); `coverage≥0.5` is the healthy target, below-but->0 a soft note (the
  per-dealer VDP budget bounds gated-car coverage). `nullEscape:true` (n==0) = SKIP.
  (`gated` is structurally 0 until `inventory_status='price_gated'` is persisted — a
  backlog item; an all-gated dealer still FAILs today, acceptable since in the bug the
  VDP exposed the price and the scan dropped it.) **F1 enrichment (added this round):**
  `breakdown_parsed` = listings with a non-null `pricing_breakdown_json`;
  `breakdown_coverage = breakdown_parsed/n`. **Hard FAIL iff `vdp_linked>0 AND
  breakdown_parsed==0`** (the scan reached VDPs but dropped EVERY price breakdown — a
  total had-and-lost of the new dimension). `markup_present` / `addons_present` are
  INFORMATIONAL counters ONLY — `markup_present==0`/`addons_present==0` is the healthy
  norm (most listings carry no labeled dealer markup) and is **NEVER** a fail criterion.
  **Render-quality signal (added 2026-06-29, PIC-20260629-3):** `scanned_sources` =
  `dealer_inventory_sources` rows at `last_status='scanned'`; `rendered_empty_count` = the
  subset whose `error_json` carries `{"rendered_empty":true}` — a scanned dealer whose SRP
  resolved un-blocked yet rendered 0 cards + a sub-threshold snapshot (a **blank/host-thrash
  render**, distinct from a genuine "0 vehicles found" SRP whose chrome clears the threshold).
  Use it to read a 0-yield: **`n==0 AND rendered_empty_count>0` = host thrash (browse
  collapsed), NOT a genuine no-stock and NOT a lane bug** — a single-run, deterministic thrash
  signal (no cross-provider re-run needed). It is **INFORMATIONAL** (never a fail criterion;
  thrash is an environment condition, not a product defect) — surface it, don't FAIL on it.
- `skill=dealer_reply_extract` → `{ skill, n, metric:"otd_coverage", covered,
  coverage, otd_present, extract_succeeded, extract_failed, nullEscape }` over
  `dealer_quotes` + `messages`. PASS iff `otd_present/n ≥ 0.5`; `nullEscape:true`
  (n==0, nothing extractable) = SKIP.

Ratios name no brand/metro/row-count, so the check generalizes to the next random
pick. Extend by adding a case to the route's skill switch (geosearch website
coverage, quote_audit expected-finding-code, inventory_compare real-price-axis are
recorded backlog items — add the missing verification surface).

**When:** the data-quality floor in the spine self-check — for every data-bearing
skill that wrote ≥1 row, BEFORE declaring it PASS.

---

## Cross-lane triage support (the spine owns the rule)

The four-exit triage tree lives in SKILL.md. This host supplies its three instruments:

1. **`rendered_empty_count`** (`/__e2e/dataquality?skill=inventory_site_scan`) — a scanned
   dealer whose SRP resolved un-blocked yet rendered 0 cards + a sub-threshold snapshot.
   `n==0 AND rendered_empty_count>0` = blank/host-thrash render (environment), NOT no-stock,
   NOT a lane bug — single-run, deterministic, no cross-lane re-run needed. Informational,
   never a fail criterion.
2. **Cross-lane re-run** — same skill, `AUTOBROKER_AGENT_PROVIDER` flipped, fresh dir, at
   most once. The browse path is provider-independent (tools-layer Playwright, no LLM);
   only the EXTRACTION is the lane.
3. **Controlled extraction test (decisive)** — feed a FIXED woven-card snapshot (the exact
   `weaveCardsForExtraction` `[CARD n]…URL:…` format) to the suspect lane's extractor,
   sequentially AND concurrently; extraction succeeding proves the lane and points the
   live 0 upstream at browsing.

Lane-B diagnostics (reliable): `test_run_records.input_tokens` is cache-inclusive (sums
input + cache_creation + cache_read — reads the real prompt size); with
`AUTOBROKER_RECORD_TRANSCRIPT=<path>` lane-B calls tee to the sibling `<path>.laneB.jsonl`
({lane:"claudeOAuth", model, prompt, structuredOutput|text, usage} — the main `<path>`
stays the lane-A replay file). Concurrency is a HOST property, not a lane property: both
lanes share the host-safe `AUTOBROKER_*_CONCURRENCY` defaults (env-raisable); there is no
per-provider cap.

---

## External-SQLite writes are invisible to the running server

A SQLite write made by a separate process underneath the already-running server
is **invisible** to it — `better-sqlite3` has its own page-cache/snapshot view.
The control routes write through `openDb()` **inside the server process**, so the
change is visible to subsequent `/api` reads. **Never** write the `dataDir` DB by
hand (`sqlite3 …`) to seed — it will look applied to you and absent to the dashboard.

---

## METRO_FIXTURES allowlist + the Irvine fallback trap

The geocoder is stubbed because the Places key has no Geocoding entitlement.
`resolveMetro` maps a **brand+city allowlist → real coordinates** so the
buyer-brain can search any allowlist metro deterministically with no external call.

**Matching order (resolveMetro):** lowercase the query → (1) match a `\b\d{5}\b`
ZIP against `m.zip`; (2) else city-name substring (`q.includes(m.city)`); (3) else
**fall back to `METRO_FIXTURES[0]` = Irvine**.

**THE TRAP:** if `location_query` contains neither a whitelisted ZIP nor a
whitelisted city substring, it **silently resolves to Irvine** — the search runs
in the wrong metro with no error. The buyer persona's `location_query` MUST
contain a whitelisted city name or its ZIP (e.g. `"Dallas, TX 75201"`).

**19-metro allowlist** (keep in lock-step with `METRO_FIXTURES` in `serve-live.mjs`):

> Irvine 92602 · Los Angeles 90012 · San Diego 92101 · Dallas 75201 · Houston
> 77002 · Austin 78701 · Phoenix 85004 · Denver 80202 · Seattle 98101 · Portland
> 97204 · Chicago 60601 · Atlanta 30303 · Miami 33130 · Tampa 33602 · Charlotte
> 28202 · Nashville 37203 · New York 10007 · Philadelphia 19107 · Boston 02110

Radius blank is fine — intake defaults to 125 mi, giving a wider net.

---

## Monotonic clock / ~14-day window / multi-round constraints

`BASE_MS = Date.now() − 2 days`. A module-global `injectSeq` counter shared
across all three inject routes (`inject_replies`, `inject_reply_to_thread`,
`inject_crm_threads`) ensures every injected message gets `BASE_MS + injectSeq++`
— strictly increasing, satisfying the fake-mailbox `internalDateMs` assertion and
the negotiation watermark (round-2 always lands after round-1).

The ~2-days-ago base is deliberate: replies sit inside the `negotiation_followup`
/ `dealer_closeout_email` follow-up window (≈14 days since the dealer's last
reply) so those drafts are exercisable. The deterministic func lane uses a fixed
`BASE_MS = 1_717_000_000_000` floor instead — that is not this host.

**Round protocol (per spine, 2026-06-22 — deep mutual negotiation):** ≥10 dealers,
front-runners driven to **≥4 buyer rounds** under the **responsive-aware follow-up
cap** (`MAX_UNANSWERED_FOLLOWUPS=2`, `MAX_TOTAL_FOLLOWUPS=10`; supersedes the old
flat 3-round cap). See `references/dealer-brain.md` for the full loop. Sequence:
1. `dealer_web_lead_submit` (the inbox anchor) → `inject_replies` (record `threadIds[]`)
2. `dealer_inbox_check` → `dealer_reply_extract` → `quote_audit` → `quote_compare`
3. **Loop to ≥4 rounds:** `negotiation_followup` (`/slash`, batch gate → approve) →
   dealer counters via `inject_reply_to_thread` (same `threadId`; `inject_contact`
   + `isPrimary` for a manager escalation) → repeat. A counter resets that thread's
   unanswered count, so an actively-countering thread stays eligible; a dealer you
   leave silent is dropped after the buyer's 2nd unanswered follow-up.
4. re-extract ONCE at the end (the cap keys off message **rowid**, not the quote) to
   land the floor OTDs.
5. `dealer_closeout_email` last.

**rowid, not timestamp, is the cap signal.** Because the inject clock backdates ALL
injected messages to ~`BASE_MS` (2 days ago) while the buyer's outbound carries no
`received_at` (it writes `processed_at`), the responsive cap counts trailing outbound
by **insertion order (rowid)** — immune to the clock skew. So no inject-clock change
is needed for deep rounds, and the monotonic `injectSeq` is enough for the
fake-mailbox / watermark assertions.

---

## Telemetry — read BEFORE `pipeline_reset`

~6 LLM-calling skills write rows to `test_run_records` in the isolated DB
(`skill`, `cost_usd`, `latency_ms` columns; also `calls` count). Dump before
`pipeline_reset` wipes the DB:

```bash
SQ=/Users/wangyangxu/opt/anaconda3/bin/sqlite3   # or any sqlite3 on PATH
DB="<dataDir>/autobroker.db"
"$SQ" -header -column "$DB" \
  "SELECT skill,provider,pricing_source,COUNT(*) calls,SUM(cost_usd) cost,SUM(latency_ms) ms \
   FROM test_run_records GROUP BY skill,provider,pricing_source ORDER BY cost DESC"
"$SQ" "$DB" \
  "SELECT printf('\$%.4f',SUM(cost_usd)),SUM(latency_ms) FROM test_run_records"
```

Lane-B rows carry `cost_usd` NULL + `pricing_source='subscription'` (an honest NULL —
never a fabricated $0); report the lane column, don't sum NULLs into $.

**Fallback (if already reset):** read from the pre-wipe backup:
`BK=$(ls -t <dataDir>/backups/autobroker-*.db | head -1)` then query `$BK`.

Record: total API cost, total LLM latency, sweep wall-clock. These feed the
Time & Cost tables in the HTML report (see `references/recording.md`).

---

## Quick-reference checklist

1. Export `AUTOBROKER_AGENT_PROVIDER` per `--provider` BEFORE boot (exact `claude`\|`deepseek`; unset = DeepSeek).
2. Start: `pnpm e2e:serve-live`; wait for `{"liveE2e":"listening",…}`; record `dataDir`.
3. Confirm floor automatically set by the host: tmp data-dir (not `~/.autobroker*`), `AUTOBROKER_MODE=test` (fake-send), gmail fake, `AUTO_APPROVE` deleted.
4. Verify lane-took-effect from `test_run_records` after the first LLM skill (`provider` + `pricing_source` match `--provider`).
5. **Seed ONLY via the control routes** (`inject_replies`, `inject_reply_to_thread`, `inject_crm_threads`, `inject_contact`) — never write the DB underneath the server.
6. `location_query` MUST contain a whitelisted city name or ZIP (else silent Irvine fallback).
7. After `inject_replies`, **save `applied.threadIds[]`**; dealer counters go to `inject_reply_to_thread` using those `threadId` values.
8. Call `inject_crm_threads` BEFORE `dealer_hygiene`.
9. Dump `test_run_records` BEFORE `pipeline_reset`; use backup fallback if missed.
10. Verify writes and decline-Δ0 via `/__e2e/rows?table=` (whitelist 14 tables) and `/__e2e/audit?action=`.
11. Per-PASS cleanup: assert `/__e2e/rows?table=search_profiles` returns `0`.
12. **(Step 3.9 only)** Before launching: set `AUTOBROKER_PORTFOLIO_SCHEDULER=1 MAX_CONCURRENT_ACTIVE_PROFILES=2 AUTOBROKER_PORTFOLIO_TICK_MS=2000`; optionally `AUTOBROKER_RECORD_TRANSCRIPT=<path>` to capture a replay corpus.
13. **Mode is launch-time, immutable.** `AUTOBROKER_MODE=test` is chosen at boot (`assertTestModeSafe` fires only there); **never** PUT/POST `app_mode=buyer` or flip the TopBar on the running host — a live flip arms a real adapter on the next send with no second env ring (see "Mode model").
