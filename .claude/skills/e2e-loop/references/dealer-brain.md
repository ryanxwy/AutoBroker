# dealer-brain — step 3.5 reference

Runs AFTER the two-pass sweep (step 3), BEFORE frontend-taste (step 3.7).
Skipped in `--light` mode.

---

## What it is

Dispatch a **local Opus subagent** as the dealer-brain. Same api-key lane —
no charge to the SUT, no outbound email. All writes flow through
`inject_replies` / `inject_reply_to_thread`; external SQLite writes are
invisible to the running server (see `harness-boundaries.md`).

---

## Corpus study (once per run, before generating)

Feed the subagent:

1. **Real phrasing corpus** — read
   `harness/cases/dealer_reply_extract.live_extract.toml`. Learn the email
   register: greetings, OTD line-item breakdown layout (MSRP / destination /
   dealer adj / rebate / net vehicle / doc fee / tax / title / total OTD),
   APR disclosure phrasing, add-on mentions, urgency/scarcity language
   ("this unit is allocated", "offer expires Friday"). Goal = learning the
   register, not copying fixed text.

2. **This run's brand and metro** (from step 2.5). Match prose register to
   brand tier (luxury = formal; high-volume = conversational).

3. **Live dealers** from geosearch — use actual names/websites.

---

## Round protocol (invariants, sourced from `harness-boundaries.md` §f)

- **≤4 dealers** across all quotes.
- **≤2 counter-cycles** (initial injection = round 0; each
  `inject_reply_to_thread` pair = one cycle).
- **7-day window** — serve-live's monotonic clock (`BASE_MS = Date.now() − 2d`
  + `injectSeq++`) handles timestamps automatically. Do NOT set
  `internalDate` manually.
- **3-round cap** per thread across all injections.

---

## Execution

### Round 0 — initial quotes

After `dealer_web_lead_submit`:

1. **Generate 4 initial dealer reply emails** with deliberate OTD/doc-fee/APR
   variance to fire three audit codes:
   - **≥1 doc fee over the state cap** → fires `DOC_FEE_CAP`. Only CA/NY/WA
     have statutory caps; TX/FL correctly produce no firing — that is not
     a bug. See the don't-re-propose ledger in `backlog-state-machine.md`.
   - **≥1 with no line-item breakdown** (lump OTD only) → fires
     `MISSING_BREAKDOWN`.
   - **≥1 math-inconsistent** (components don't sum to stated total), but set
     `sales_tax` to a **non-null** value — `MATH_SANITY` skips rows where
     `sales_tax IS NULL` (null-skip is intentional; see don't-re-propose
     ledger).

   These audit firings are **correct behavior**, not bugs. Do not add them to
   the backlog.

2. **POST `/__e2e/inject_replies`** `{ profileId, replies:[…] }`. **Record
   the full `applied.threadIds[]` array** (`[{ dealerName, from, threadId }]`)
   — this is the only source of valid threadIds; you cannot mint your own.

3. Run: `dealer_inbox_check` → `dealer_reply_extract` → `quote_audit` →
   `quote_compare`.

### Round 1 — buyer negotiates, dealer counters

4. Run `negotiation_followup` (pin → batch gate → fake-send, `BLOCK=1`).
   Confirm `threads.state = 'negotiating'` via `/__e2e/rows?table=threads`.

5. **Generate ≤4 dealer counter-reply emails.** Revise OTD downward with a
   realistic floor (keep ≥$200 gross). Match the corpus register.

6. For each counter, **POST `/__e2e/inject_reply_to_thread`**:
   ```
   { threadId, from, subject, body, dealerName }
   ```
   `threadId` MUST come from `applied.threadIds[].threadId` (step 2). A
   different threadId = a different dealer thread — the same-dealer
   price-drop chain breaks and negotiation/closeout will not connect.

7. Re-run `dealer_reply_extract`. New pending messages → new `dealer_quotes`
   rows with revised OTDs. Confirm via `/__e2e/rows?table=dealer_quotes`.

### Round 2 (optional, ≤1 more cycle)

8. If exercising a second counter-cycle, repeat steps 5–7 once. Honor the
   3-round cap: do NOT inject a third message on any thread already at 2.

### Closeout (always last)

9. Run `dealer_closeout_email` against open threads. Verify draft + fake-send
   + receipt UI via the Replies tab DOM and `/__e2e/audit`. Decline = Δ0 on
   `threads` (CLAUDE.md inv #10).

---

## Verification checkpoints

| after | check |
|---|---|
| `inject_replies` | `/__e2e/rows?table=messages` +4 |
| `inject_reply_to_thread` | `messages` +1; thread has 2+ messages |
| `reply_extract` | `/__e2e/rows?table=dealer_quotes` increases |
| `negotiation_followup` | batch-gate rendered + approved; `threads.state='negotiating'` |
| closeout decline | `/__e2e/rows?table=threads` Δ0 |

Spine hierarchy: rows/audit > DOM > screenshot > LLM-judge.
