# dealer-brain — step 3.5 reference

Runs AFTER the two-pass sweep (step 3), BEFORE frontend-taste (step 3.7).
Skipped in `--light` mode.

The dealer-brain drives the **headline realism of the whole 全技能巡检**: a deep,
mutual, multi-dealer email negotiation that mirrors how a real US buyer shops a
new car. It is NOT a 2-3 round cooperative haggle — see the reality model below.

---

## What it is

Dispatch a **local Sonnet subagent** as the dealer actor (`harness/prompts/dealer.md`). It runs on
YOUR Claude — the operator's subscription (subagents) or a `claude -p` child — entirely
SEPARATE from the SUT's DeepSeek api-key lane: it never charges the SUT's provider
budget and never sends real email. All writes flow through `inject_replies` /
`inject_reply_to_thread` / `inject_contact`; external SQLite writes are invisible to
the running server (see `harness-boundaries.md`). The subagent only GENERATES the email
text; the main agent injects it through the control routes and drives the SUT skills
through the chat rail / `/slash`.

## Dealer-actor mechanism & OAuth concurrency (how to run N live dealers)

Two ways to drive the actor — pick by lane:

- **Per-dealer concurrent subagents (recommended for multi-profile + deep realism).**
  Dispatch ONE Sonnet subagent PER dealer — each gets `harness/prompts/dealer.md` + its assigned
  archetype + the buyer's latest email + the thread transcript — and run them in
  **batches of ≤3 concurrent in-flight across the WHOLE portfolio**. Each dealer is an independent agent (no cross-context
  bleed), so sustained-resistance archetypes (quoter / come-onsite-only / ghost) stay
  distinct. The operator injects each returned reply via `inject_reply_to_thread`.
- **Batch corpus (one subagent for a whole field).** For a fast single-profile round-0,
  one subagent can emit all ~12 replies at once — cheaper, but the dealers share one
  context (less independent).

**OAUTH CONCURRENCY REALITY (researched + live-probed 2026-06-24).** On ONE Claude
subscription the honest ceiling is **~2-3 in-flight calls**; beyond ~3-7 you hit a
server-side 429 ("Server is temporarily limiting requests — *not your usage limit*")
that hard-fails the extra children, or a multi-minute hang. So **PACE**: ≤3 concurrent,
rounds sequential, drop ghosts/laggards (fewer emails over more wall-clock — the
deliberate trade). "Concurrent" buys orchestration shape (interleaved threads, the
shared-rooftop race, one approval inbox) + ~2-3× overlap, NOT N× parallelism.
`claude -p` and Claude Code subagents on the subscription are fine for local owner-run
use; the **Claude Agent SDK requires an api key** (OAuth is blocked there) — do NOT
route the dealer actor through the SDK on OAuth.

**NON-DETERMINISM (load-bearing).** Every dealer AND buyer MESSAGE is a live LLM
generation. The ONLY seeded part is the SKELETON — which dealers, archetype assignment,
reply ordering, the ghost/chaos schedule. NEVER replace a dealer reply with a canned /
replay body in a live run; the `mp-replay` corpus is a SEPARATE deterministic regression
gate recorded FROM a live run, never a substitute within it.

---

## The reality model (research-grounded — do NOT regress to "cooperative")

Sourced from the 2026-06-22 deep-research report (`AutoBroker-dev-plan/
ts-rebuild/20260622-email-negotiation-realism-research/`, 90+ cited sources: DAS
Technology 2025 NADA study, AutoAlert/CDK org charts, CarEdge/Edmunds/Consumer
Reports buyer guides, Conversica/Impel AI-BDC docs, r/askcarsales). Live-validated
2026-06-22 (RAV4 XLE / LA, 32 dealers). The dealer side MUST exhibit:

1. **One dealer ≠ one contact.** A lead flows through a titled hierarchy:
   CRM **auto-responder** (instant, no price) → **BDC rep / Internet Coordinator**
   ("sells the appointment, not the car" — withholds OTD) → **Sales Consultant**
   → **Sales/Desk Manager** (the only one who actually approves price) → **GSM**
   (escalation) → **F&I** (only after agreement). The buyer's *only* rank cue is
   the **title in the signature**.
2. **Escalation / turnover.** When a thread stalls or the buyer pushes price, a
   **higher-title person takes over** — often from a NEW `From:` address. The new
   sender must bind to the SAME dealer (model via `inject_reply_to_thread{from:
   managerEmail}` + `inject_contact{role,isPrimary:true}` — a contact-flip).
3. **AI first-touch.** The first reply is usually **automated** (Conversica/Impel
   style), human-sounding name, pushes the appointment, **withholds price**, runs
   a nudge cadence.
4. **74% of first replies carry NO price** (DAS 2025). Deflection is deliberate.
   4% never respond.
5. **Round depth: shallow-per-thread, deep-across-threads.** Buyers email
   **3-5 dealers in parallel (up to ~10)**; each thread is *typically* 2-4
   round-trips, but the front-runners legitimately run **>4** as trade-in /
   financing / fee disputes layer in. Depth comes from the cross-thread
   **"leapfrog"** (cite the running-best OTD, ask others to beat it).
6. **Ghosting is endemic.** Dealers go silent on lowballs / competitor-shopping;
   dealer follow-up persistence is finite (44% quit after 1, 92% after 4).
7. **Fee stack.** State-dependent doc fee (CA $85 / FL ~$999 / TX ~$225),
   non-negotiable zip-scaled tax/title/reg, bundled add-ons (nitrogen/VIN-etch/
   "recon", presented as pre-installed), ADM on hot trims (~$4k), payment-pivot,
   F&I back-end *post*-agreement, and a **lump OTD that hides add-ons** until itemized.

**Imperfection is SIGNAL across the WHOLE pipeline.** A low quote-rate / a ghosted
profile is a **VALID outcome to learn from**, never a fail and never a reason to
fabricate a quote. This applies to every surface — a sub-optimal comparison, a rough UI,
attribution ambiguity — and feeds the **backlog** (SKILL.md "How to classify what
you find" backlog tier → `references/recording.md`), not the failure ledger. The ONLY
dealer-side FAIL stays a blocker (a safety or data-loss breach): a dealer that DID email
a number whose OTD the extractor dropped (`otd_present/n < 0.5`).

---

## Owner directives (2026-06-22, load-bearing)

- **≥10 dealers per full run.** A big metro + high-volume vehicle (LA + RAV4 ⇒
  32 dealers). Negotiate the front-runners; the long tail is ghosts / auto-replies.
- **Multiple parallel DEEP threads**, each driven to **≥4 mutual rounds** — not
  one single "main" thread.
- **Realism over cost.** Spend the LLM calls; do the full negotiation + full
  pre-flight market search (geosearch + site_scan + compare + incentives).

These are enabled by the **responsive-aware follow-up cap** (product change,
2026-06-22, `replyTargets.ts followupCapDecision`, supersedes the old flat
`MAX_FOLLOWUP_ROUNDS=3`): a thread is throttled only by **consecutive UNANSWERED
follow-ups** (`MAX_UNANSWERED_FOLLOWUPS=2`, reset whenever the dealer replies)
plus a hard total ceiling (`MAX_TOTAL_FOLLOWUPS=10`). So an actively-countering
thread runs deep; a silent dealer is dropped after 2 nudges.

---

## Corpus study (once per run, before generating)

Feed the Sonnet dealer subagent(s): (1) the **register** of
`harness/cases/dealer_reply_extract.live_extract.toml` (OTD line-item layout, APR
phrasing, scarcity language) — learn the register, don't copy text; (2) this run's
**brand + metro** (match prose to brand tier); (3) the **live dealer ids + names +
websites** from geosearch (read-only `sqlite3 -readonly <dataDir>/autobroker.db
"SELECT dealer_id, name, website FROM dealers ORDER BY rowid"`) — carry each reply's
`dealer_id` into the inject payload (below) so the reply binds to the real
geosearch rooftop instead of minting a duplicate dealer card; (4) the **state doc-fee cap**
for the metro (capped: CA $85 / NY $175 / WA $200 / MN $125 / MI $260 / OH $250 /
MD $500; uncapped TX/FL/OR fire `DOC_FEE_UNCAPPED` above ~$500, Phase 5).

---

## Round 0 — initial dealer replies (the archetype mix)

Generate **~12 round-0 replies** (for a ≥10-dealer field) with a REALISTIC
distribution — most are no-price first touches:

- **~40% NO-PRICE first touches** — AI/BDC autoresponders (instant, generic,
  "still in the market? when can you come in?") + BDC reps who deflect price and
  push a call. (`no_quote`: extractor writes **0 rows, no error**.)
- **~35% ITEMIZED OTD** — draw from the audit-firing archetypes so the audit
  codes wake up:
  - clean + compliant (doc fee at the state cap) — the honest control.
  - **fee-loaded** — ADM + 2 add-ons + a high doc fee → fires `DEALER_FEE_OUTLIER`
    + (if the stack doesn't reconcile) `MATH_SANITY`, plus a doc-fee flag whose code
    depends on the metro: `DOC_FEE_CAP` over the cap in a capped state (CA/NY/WA +
    MN/MI/OH/MD), or `DOC_FEE_UNCAPPED` for a >~$500 fee in an uncapped state (TX/FL/OR,
    Phase 5 — no longer silent).
  - **math-inconsistent** — itemized, **non-null** sales_tax, line items miss the
    stated total by ~$200-500 → fires `MATH_SANITY` (null-tax would hit the
    null-skip guard — NOT a firing).
  - **honest-combined-govt-fee** (seasoned SC-628-2, advisory) — itemized, math
    CORRECT, but writes title + registration as ONE combined line ("Title &
    registration: $550" / "TT&L: $X") rather than separate fields. The live
    extractor sometimes drops the combined line, leaving the itemized fields short
    of the (correct) OTD by ≤ ~$800. After the `1111962` fix `quote_audit` must NOT
    fire a (false) `MATH_SANITY` on this honest dealer — re-flag ONLY if it fires
    on a ≤$1000 positive govt-fee residual, or FAILS to fire on a >$1000 shortfall.
  - a clean LOWER price — the eventual front-runner.
- **~15% LUMP-OTD only** ("$XX,XXX out the door, best I can do") → `MISSING_BREAKDOWN`.
- **~8% PAYMENT-ONLY** ("just $429/mo!", no OTD) → monthly-without-total handling.
- **Ghosts:** leave **≥2 dealers with no round-0 reply at all** (silent the whole
  run) — the structurally-untested mainstream experience.

These audit firings are **correct behavior**, not bugs (see the "known-correct
behaviors" list in `references/recording.md`). DON'T re-flag DOC_FEE_CAP/DOC_FEE_UNCAPPED/
MATH_SANITY/MISSING_BREAKDOWN/DEALER_FEE_OUTLIER on the planted archetypes.

POST `/__e2e/inject_replies` `{ profileId, replies:[…] }`. **Give each reply the
geosearch `dealer_id`** (`{ dealer_id, dealerName, dealerWebsite, from, subject, body }`)
so it binds to the existing rooftop — without it the route mints a duplicate
`live-dealer-*` card, splitting the Negotiations board and putting the F4 give-up
chips on the wrong tile. **Record the full `applied.threadIds[]`**
(`[{dealerName, from, threadId}]`) — the only source of valid threadIds; you
cannot mint your own.

**Anchor first:** the inbox gate needs ≥1 `lead_submissions` row, so run
`dealer_web_lead_submit` (pin → form-scout → batch gate → fake-send; ~3 min for a
32-dealer scout) BEFORE the email pipeline. inject_replies is NOT the anchor.

---

## The deep mutual-negotiation loop (the centerpiece)

A "round" = one **back-and-forth exchange** (buyer follow-up + dealer counter).
Drive the FRONT-RUNNERS (the ~4-6 dealers with competitive numbers, plus the
no-price-until-pushed ones) to **≥4 buyer rounds** by interleaving
`negotiation_followup` with dealer counters. The responsive cap makes this work:
each buyer follow-up is answered by a dealer counter (higher message rowid →
`unansweredFollowups` resets to 0), so the thread never trips the cap.

**Per-round sequence (repeat to ≥4 rounds):**
1. **`negotiation_followup`** (pin → batch gate → fake-send, AUTOBROKER_MODE=test). Pin is
   REQUIRED (it STOPs `pin_required` even with 1 active — pick the vehicle once).
   `/slash` it for rounds 2+ (faster + deterministic than NL). Confirm
   `threads.state='negotiating'`.
2. **Generate ≤N dealer counters** (per-dealer Sonnet subagents, ≤3 concurrent in-flight across the WHOLE portfolio) with a realistic floor (keep ≥$150-400
   gross), grinding the OTD DOWN with diminishing concessions. For the front-runners,
   have a **higher-title MANAGER take over at round 2** (escalation) from a NEW
   email. Match the corpus register. **But do NOT make every thread converge to a
   number — sustained resistance is mainstream (`harness/prompts/dealer.md` "Sustained resistance"):
   keep ~1-2 dealers per field as COME-ONSITE-ONLY that never email an OTD even at
   round 4 (every counter pushes the appointment / reverse-induces "tell me your
   timeline + financing first"), and let ~1-2 GHOST mid-thread (replied once, then
   silent on the lowball). Only the genuine front-runners email a real itemized OTD,
   late and grudgingly.** A run where most dealers eventually quote cleanly is the
   over-cooperation failure the realism research flags as the #1 unrealism.
3. **Inject each counter** via `/__e2e/inject_reply_to_thread {threadId, from,
   subject, body, dealerName}` (threadId from round-0). For an **escalation**,
   FIRST `/__e2e/inject_contact {threadId, email:managerEmail, displayName, role,
   isPrimary:true}` so the top of the reply-target ladder flips to the manager.
4. (Optional, for the final-OTD payoff) re-run `dealer_reply_extract` to land the
   revised (lower) `dealer_quotes` rows. NOT required between every round — the cap
   keys off message rowid, not the extracted quote — so re-extract ONCE at the end
   to capture the floor OTDs and keep wall-clock down.
5. **Ghosts:** for the dealers you want to drop, inject NO counter. After the buyer's
   2nd unanswered follow-up the responsive cap removes them from the batch.

A scripted injector (`inject_round.sh <N>` over a `counters.json` keyed by
dealerName→threadId, with the `isEscalation` contact-flip baked in) keeps the
rounds mechanical.

### Closeout (always last)
Run `dealer_closeout_email` against open threads. Verify draft + fake-send +
receipt UI via the Replies tab DOM and `/__e2e/audit`. Decline = Δ0 on `threads`
(CLAUDE.md inv #10).

---

## Verification checkpoints (rows/audit > DOM > screenshot > LLM-judge)

| after | check |
|---|---|
| `inject_replies` | `/__e2e/rows?table=messages` +N; `threadIds[]` recorded |
| each `negotiation_followup` | batch gate rendered BEFORE prose + approved; `threads.state='negotiating'`; "sent N" |
| `inject_reply_to_thread` (+contact) | `messages` +1; on escalation a new `dealer_contacts` row, `is_primary_reply_target=1` |
| **the responsive cap (the proof)** | per-thread `COUNT(outbound)` vs unanswered — **active threads reach ≥4 outbound** (past the old flat 3); **silent threads freeze at 2 outbound / unanswered=2 and DROP from the next batch** (12→6 in the live run) |
| `reply_extract` | `dealer_quotes` grows; revised OTDs grind to the floors; **#1244 CLEAN — or, if it ever trips, fail-closed-THEN-auto-recover** (2 `provider=deepseek` ledger rows, redacted `malformed_sample`, NO user retry button — see `skill-pipeline.md` item 9; a silent tool-SKIP / regex-exec'd name IS still the blocker) on the largest extraction |
| **F4 give-up / switch (derived-on-read, NEW)** | after the ghost rounds, a **ghosted/cold** dealer surfaces a `dealer-verdict-hold` chip ("gone quiet" / "paused" / "not moving") on the Dealers tab + its thread reads `thread-class-chip`="gone quiet" (dormant) on Replies. After a **retrade** where a cheaper itemized **same-mode** front-runner exists, the lagging dealer surfaces `dealer-verdict-switch` = "consider switching · $N cheaper elsewhere" where **N == currentOtd − bestCompetingRealOtd** (the DISPLAYED gap = the lowest REAL competing OTD, incl. a cheaper non-itemized bottom-line offer — matches the detail modal so board and modal never show two different $N; the give_up_switch VERDICT still fires only on the strict itemized BATNA), with **NO competing dealer NAME and NO budget** (inv #9). After a **concession** the thread reads `thread-class-chip`="countered". Read the verdict/reason/gap from the product JSON `GET /api/profiles/:id/dealers` (`verdict`/`verdict_reason`/`batna_gap_usd`) + `/threads` (`negotiation_status`) and corroborate with the DOM chip — no new test-host route. **Window note:** the give-up engine's anti-pester cap is `BATCH_SILENCE_WINDOW_DAYS=7` (`dealerComm/constants.ts`), but the inject clock backdates only ~2d (below) — so the DEFAULT run reaches the **'paused'** cap path; to drive the silent **'gone quiet'** path use the already-documented `ageHoursAgo>168` lever (`serve-live.mjs:136-148`). |
| **come-onsite / ghost (realistic no-OTD)** | the pipeline does NOT fail when most dealers never quote: each come-onsite-only / ghost thread yields **0 `dealer_quotes` rows (`no_quote`, no error — never a fabricated number)**; the data-quality verdict's `nullEscape` / `gated` escape PASSES a realistic low quote-rate; a profile's best OTD may come from only **1-2** dealers, or be legitimately **absent** (a valid terminal — "go visit / keep waiting", not a bug). Distinguish this from the real FAIL: a dealer that DID email a number whose OTD the extractor dropped (`n>0 AND otd_present==0`). |
| closeout decline | `/__e2e/rows?table=threads` Δ0 |

The cap proof SQL (run against `<dataDir>/autobroker.db`, read-only):
```sql
SELECT d.name,
  (SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.thread_id AND m.direction='outbound') buyer_FUs,
  (SELECT COUNT(*) FROM messages mo WHERE mo.thread_id=t.thread_id AND mo.direction='outbound'
     AND mo.rowid > COALESCE((SELECT MAX(mi.rowid) FROM messages mi WHERE mi.thread_id=t.thread_id AND mi.direction='inbound'),0)) unanswered
FROM threads t JOIN dealers d ON d.dealer_id=t.dealer_id ORDER BY buyer_FUs DESC;
```
Active threads → `buyer_FUs ≥ 4`; ghosts → `buyer_FUs = 2, unanswered = 2`.

### Seasoned cases (advisory — ride ON TOP of the deterministic regressions, never block CI)

These mutate a dealer behavior to reproduce a live edge a planted fixture cannot;
each is ADVISORY with a falsifiable expected outcome. Drawn from the 2026-06-29-run2
e2e-evolve round.

- **SC-629r2-3 — payment-probe dealer × finance buyer** (PIC-20260629r2-3 / `0a0bdee`).
  A come-onsite / reverse-induce dealer whose every counter asks a pointed qualifier —
  "Are you paying cash or financing with us? We sharpen the number once we know." Pair
  with a **finance** persona. EXPECT: the round-1 `negotiation_followup` draft for that
  thread, when it mentions payment at all, says **finance** (or asks for APR) and NEVER
  contains "cash" (case-insensitive); symmetrically a **cash** buyer's draft never claims
  finance/lease. Stresses the draft financing-grounding + the `assertPaymentMethodConsistent`
  belt (inv #9 hard-constraint-in-code).
- **SC-629r2-5 — re-quotes-then-holds dealer** (PIC-20260629r2-5 / `60ae1db`).
  Round-0 gives a real itemized OTD; on the follow-up the dealer replies "my $X stands,
  I won't chase" (restates the number, emits no fresh quote → extracts to $0). EXPECT after
  `dealer_reply_extract` on the hold: that dealer's board `best_otd`
  (`GET /api/profiles/:id/dealer-negotiations`) **=== the round-0 OTD** (never $0/null); the
  new `dealer_quotes` row's `otd_total IS NULL` (a `/__e2e/rows?table=dealer_quotes` +1, but
  `otd_coverage` unchanged). Stresses the $0→null write-normalization + read guards.
- **SC-629r2-4 — non-itemized cheaper front-runner** (PIC-20260629r2-4 / `60ae1db`).
  The current dealer's itemized OTD sits slightly ABOVE a cheaper **bottom-line
  (non-itemized)** competitor. EXPECT: the detail-modal advisory reads "close to the best
  competing" (moderate) / the signed gap, **never "at or below best"**; `best_competing_otd`
  === the real cheaper number; `give_up_switch` does NOT fire (the cheaper competitor is
  non-itemized). Stresses the `bestCompetingRealOtd` tone baseline + the verdict-strict split.

---

## DON'T re-discover (validated 2026-06-22)

- The inject clock backdates round-0 replies to `BASE_MS = now-2d`; counters land
  at `BASE_MS+injectSeq` (still ~2d ago). This is fine: the responsive cap keys off
  **message rowid (insertion order)**, NOT `received_at`, so the clock skew never
  breaks the unanswered count. No inject-clock change is needed.
- The timing gate's `minGapHours=24` "wait" branch never fires for these threads
  (outbound rows carry NULL `received_at`; `sendRecord` writes `processed_at`), so
  rapid same-session rounds are not throttled. The cap is the only limiter.
- `negotiation_followup` is **pin-required** (STOP even with 1 active). `/slash`
  still needs the pin picked once.
- The batch gate's `select-all` disables once everything is selected (it is NOT a
  no-op — `batch-submit` then fires). After submit, the gate buttons disable while
  the fake-sends process; wait for "sent N" / `Done`.
- `reply_extract` occasionally tags a finance quote `cash`/`unspecified`
  (`MODE_MISMATCH`) — benign LLM variance; OTD is mode-agnostic.
- `frontend-taste` skill is `disable-model-invocation` → can't Skill-invoke; apply
  its rubric inline (advisory, never blocks merge).
