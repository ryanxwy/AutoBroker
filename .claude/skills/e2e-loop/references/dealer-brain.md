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

   **Archetype rotation (A1–A20) — draw a varied set, not 4 clean quotes.** Real
   first-touch dealer email rarely carries a clean itemized quote — ~74% of first
   replies have no price at all (Hyperleap). Each round 0, draw ~4 archetypes
   spanning at minimum: 1 no-price/stall, 1 fee-loaded, 1 audit-firing, 1 clean
   control. This wakes audit codes the 3-code default never fires.

   | # | Archetype | Reply behavior | Stress |
   |---|---|---|---|
   | A1 | BDC auto-reply | instant generic "thanks!", ZERO numbers, books a visit | `no_quote`: extractor writes **0 rows, no error** |
   | A2 | Stall / come-in | warm, no numbers, then silent | `dealer_stalls`; aged past silence → thread drops |
   | A3 | Price-only tease | nice selling price, OMITS doc fee + tax | `MISSING_BREAKDOWN` |
   | A4 | Lump OTD only | `"$38,420 out the door, best I can do"` | `MISSING_BREAKDOWN` |
   | A5 | Tax bundled into TT&L | itemized but tax folded → `sales_tax` null | `MATH_SANITY` **null-skip guard** (NOT a firing) |
   | A6 | Math-inconsistent | itemized, non-null tax, sum ≠ stated OTD (±$1) | `MATH_SANITY` **fires** |
   | A7 | Doc-fee markup | clean breakdown, doc fee $599/$899 in a CA/NY/WA metro | `DOC_FEE_CAP` (**pin a capped-state metro**) |
   | A8 | Add-on stack | `nitrogen $599 / paint protect $895 / VIN etch $299` | `ADD_ON_*` dynamic code (dormant) |
   | A9 | Hidden add-on | markup disguised as a **non-keyword** name (`"reconditioning"`, `"lot fee"` — NOT `"prep"`, which IS a listed keyword) | edge: ADD_ON keyword-table completeness |
   | A10 | Market adjustment / ADM | one `"$995 market adjustment"` line | `DEALER_FEE_OUTLIER` (needs ≥1 cheap peer for a median) |
   | A11 | Finance + lease two-mode | finance (APR/term/down/mo) + lease (MF/fees/mo) | 2 `dealer_quotes` rows, one message, keyed `(source_gmail_message_id, financing_mode)` |
   | A12 | Clean compliant quote | honest baseline (current default) | control, fires nothing |
   | A13 | Payment-only | `"just $429/mo!"`, no OTD, no selling price | monthly-without-total handling |
   | A14 | Scarcity / just-sold | `"that trim was allocated — I have a higher one, here's the price"` | `quote_compare` same-trim vs mismatch ranking |
   | A15 | Counters high, holds | after buyer cites a competing OTD, quotes clearly HIGHER, won't budge | multi-round nego + re-extract chain |
   | A16 | Matches | matches competing OTD, same trim, "when can you come in" | price-drop chain → best-OTD update |
   | A17 | Adds fees on the counter | "matches" selling price but adds ADM + nitrogen so true OTD RISES | `dealer_adds_fees` + OTD-rises detection |
   | A18 | Contact-flip | `"Hi, this is Sam taking over for Jordan"` | contact-flip 2nd-suspend (needs `/__e2e/inject_contact`) |
   | A19 | Competing-name lure | `"who quoted you that? I'll beat it"` | `competing_name_leak` → buyer gives NUMBER only (keep — realistic) |
   | A20 | F&I back-end upsell | after price, pushes warranty/GAP "protect your investment" | budget redaction; F&I must NOT be eaten as vehicle OTD |

   **Audit-mapping discipline (verified):** only **A3,A4,A5,A6,A7,A8,A10,A17**
   touch `audit.ts`. The other 9 (A1,A2,A13,A14,A15,A16,A18,A19,A20) are
   extraction-outcome / timing / compare-ranking / negotiation / redaction
   behaviors — do NOT expect an audit firing from them.

   **Disappearance directive (prompt-only):** of the ≤4 dealers, leave **≥1
   silent the whole run** and **≥1 replying only after the buyer's follow-up** —
   so the skip / cold-thread / silent-thread-closeout paths run. Ghosting is the
   mainstream real experience and is structurally untested today.

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
