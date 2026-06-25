# multi-profile-lane — step 3.9 reference (live-LLM, realistic)

The **concurrent multi-profile** layer of the live e2e. Runs AFTER the pinned
single-brand pass (steps 3/3.5) reaches terminal+green — the pinned lane is the
primary 全技能巡检 and is FROZEN and FIRST; 3.9 never runs concurrently with it
(rulings #4/#7). 3.9 mimics the realities of a real buyer running **several
searches at once**: different cars, different dealers, overlapping rooftops, and
ONE human servicing every approval — driven on the REAL DeepSeek lane with a live
Sonnet dealer, exactly like 3.5 but ×N profiles interleaved.

> Spend the LLM calls. The point of 3.9 is to surface the concurrency bugs the
> single-profile spine cannot: cross-profile bleed, a shared-rooftop double-send,
> an approval routed to the wrong profile, a starved/wedged profile. Realism > cost.

---

## THE REALITIES TO MIMIC

A real cross-shopper runs **3 active searches in the same segment, different
brands** — the headline collision world: **Accord (EX-L) + Camry (XSE) + Mazda6
(Signature)**. Each profile independently: scans its in-radius dealers, submits
leads, ingests replies, and negotiates multiple threads to ≥4 rounds. They
overlap on shared rooftops (a dealer group that sells more than one brand), and
every parked human gate across all three funnels into ONE "needs you" inbox.
Mirror all of it:

1. **N independent pipelines, bounded.** The real `PortfolioScheduler` fans the
   active set out under a hard concurrency cap (LRU/recency eviction); a profile
   parked at a human gate holds ZERO slots.
2. **Concurrent deep negotiation.** Each profile runs its own 3.5-grade
   negotiation (multiple threads, ≥4 rounds, ghosting, multi-titled escalation),
   the threads interleaved across profiles.
3. **Shared-dealer collision.** ≥2 profiles compete for one rooftop; exactly one
   binds, the others are excluded + voiced + silent.
4. **One inbox, one decision at a time.** Interleaved approvals across profiles,
   serviced through the unified `ApprovalInbox`; a decline touches only its own
   profile.

---

## SEED — the 3-brand world via REAL intake

Build the world by running **intake live, three times** (Accord, Camry, Mazda6),
each in its own metro+brand (`references/brand-picker.md`) so all three land
`status='active'` on the harness account (different `brand`/make → three active
slots, no `uq_search_profiles_active_account_brand` clash). This exercises intake
live AND yields the genuine multi-active world — do NOT shortcut with a fixture in
the live lane (the deterministic soak lane uses `seedMultiActiveSharedDealer`; the
live lane uses the product path). Then drive each profile's pipeline (site_scan →
lead_submit → inbox_check → reply_extract → negotiation).

For the **shared rooftop**, call `POST /__e2e/inject_replies` for ≥2 profiles with
the SAME `dealer_key` (B2 shared-dealer mode → one `dealer_id =
live-dealer-<key>`, each profile holding a `'candidate'` `profile_dealers` row) so
the live `claimDealer` step decides the exclusivity winner.

---

## THE REAL SCHEDULER — bounded hot-set + LIVE cap proof

`buildServer` does NOT mount the scheduler; the live host opts in. Launch
serve-live with the fan-out armed and the cap BELOW the active count so the bound
actually bites:

```
AUTOBROKER_PORTFOLIO_SCHEDULER=1 MAX_CONCURRENT_ACTIVE_PROFILES=2 \
  AUTOBROKER_PORTFOLIO_TICK_MS=2000  pnpm e2e:serve-live
```

(serve-live calls `startPortfolioScheduler(built.skillRuns)`, internally gated on
the env — a no-op for every other lane.) Assert LIVE:

- **cap holds**: at most `MAX_CONCURRENT_ACTIVE_PROFILES` profiles RUNNING at any
  tick; the rest deferred (warm).
- **suspended frees a slot**: a profile parked at a human gate drops out of the
  running set so a deferred profile is admitted (the human is the bottleneck, not
  Chromium/LLM).
- **no starvation / liveness**: every active profile EVENTUALLY runs and reaches a
  terminal state — none wedged past its follow-up-cap window.

The deterministic cap/eviction proof already lives in the `PortfolioScheduler`
unit tests + `soak mp`; this is the end-to-end LIVE corroboration.

---

## CONCURRENT PER-PROFILE NEGOTIATION (the realism core)

Run **3.5 ×N, interleaved**. For ≥2 profiles concurrently: live threads driven to
`buyer_FUs ≥ 4` (past the old flat cap), the Sonnet dealer (`references/dealer-brain.md`
— per-dealer concurrent subagents, **≤3 in-flight across the WHOLE portfolio** per the
OAuth ceiling, rounds sequential, ghosts/laggards dropped to cut email volume)
writing per-thread replies via `/__e2e/inject_reply_to_thread`, with ghosting
(unanswered → capped at the consecutive-unanswered ceiling → dropped) and
multi-titled-contact escalation. Re-extract after each round → revised
`dealer_quotes`. The threads of different profiles must be alive at the same time
(interleave the inject calls), so the concurrency machinery is genuinely exercised.

**Sustained dealer resistance applies PER profile (realism, not just round 0).**
Per `dealer-brain.md`, keep a realistic share of each profile's dealers
**come-onsite-only** (never an email OTD, even at round 4) or **ghosting** — so a
profile can legitimately finish with an OTD from only 1-2 dealers, or **none**. The
portfolio must handle that gracefully, not assume every profile yields a clean best
deal: a profile whose dealers all came-onsite / went silent is a valid **`ghosted` /
`cold`** outcome the real `profileHealth` derives (`all_threads_capped`), surfaced in
the board's COUNTS header — NOT a pipeline failure, and NOT a reason to fabricate a
quote. The portfolio "best OTD per profile" projection must tolerate null (no email
quote) and the data-quality verdict must PASS a realistic low quote-rate
(`no_quote` / `nullEscape`), reserving FAIL for a dropped-but-present OTD.

---

## ASSERT — shared-dealer collision

After the interleaved claim fan-out, verify via `/__e2e/rows` + `/__e2e/audit` +
the product DB (these mirror `assertDealershipExclusivity` in
`harness/soak/multiprofile/invariants.ts`):

- **Exactly one** profile binds the rooftop (`profile_dealers.status = 'bound'`);
  no `dealer_id` is `'bound'` to >1 profile.
- **Every other** colliding profile is `'excluded_conflict'` with a non-null
  `exclusion_reason` (`engaged_by:<holder>`) and `heldByVehicle` surfaced to the
  user — the conflict is VOICED, not silent.
- **ZERO web-form AND ZERO email send** for every loser: `lead_submissions` has no
  `outcome='submitted'` row and `messages` has no `direction='outbound'` row for
  that (profile, dealer) — `/__e2e/audit` Δ0 on send actions for losers.
- **claim precedes send**: the claim is acquired BEFORE the first outbound on the
  rooftop (the workflow orders `claimDealersStep` before `submitStep`).
- **engage-then-abort releases**: an aborted/declined flow leaves NO permanent
  claim (the rooftop is re-claimable) — no zombie lock.

---

## ASSERT — the portfolio invariants (LIVE)

After each interleaved step call `runAllInvariants({ db, profileIds, … })` from
`harness/soak/multiprofile/invariants.ts`. The exact set:

| invariant (assertionId) | when | holds iff |
|---|---|---|
| `dealership_exclusivity` | always (DB) | ≤1 `'bound'` per dealer; every `excluded_conflict` voiced; loser has ZERO submitted lead AND ZERO outbound |
| `no_cross_profile_bleed` | always (DB) | every row in the profile-scoped tables (`profile_dealers`, `dealer_quotes`, `inventory_listings`, `dealer_inventory_sources`, `quote_audits`, `thread_routing`) scopes to a KNOWN profile |
| `budget_no_leak` (#9) | always (DB) | no profile's OUTBOUND message body echoes its `budget_max` in any rendering (38000 / 38,000 / $38,000 / 38k); the failure names the message_id, never the figure |
| `history_id_no_skip` | always (DB) | every `direction='inbound'` message is attributed to a known profile (no skipped historyId orphans a reply) |
| `followup_cap` | always (DB) | per thread, the trailing-unanswered outbound run ≤ ceiling (default 10), ordered by rowid not received_at |
| `l2_gate_before_send` | when `traces` given | every `send` event is preceded by an armed `approval_gate` (one-shot, consumed per send) |
| `profile_ask_branch` | when `profileAsk` given | pinned→run; activeCount==1→run; 0 or ≥2→stop |
| `monotonic_best_otd` | when `otdSeries` given | per profile, best OTD is non-increasing over time (a search never gets a WORSE best deal) |

Plus the portfolio floor the prompt names, asserted per-profile AND in aggregate:

- **no un-gated outbound on ANY profile** (covered by `l2_gate_before_send` +
  the audit Δ check);
- **`no_external_mutation` keystone == 0 in test mode** (the harness keystone
  counter is 0 per-profile and portfolio-aggregate — nothing physically reached a
  real dealer);
- **decline = zero-write for that profile, no-op for others** (see ApprovalInbox
  below);
- **every still-live profile EVENTUALLY reaches a terminal state** (liveness — no
  profile wedged past its follow-up-cap window).

A failing invariant FREEZES the run immediately (see CHAOS).

---

## ASSERT — interleaved human approvals (the unified ApprovalInbox)

The "needs you" queue aggregates EVERY parked gate across all concurrent profiles
(the 3 irreversible sends + `dealer_inbox_check` + `inventory_link_scan` + saga
retraction tasks), ranked action-required first, keyed `(profileId, runId,
decisionId)`, tagged with reason + the budget-free `BatchReviewCard` summary.

Drive it like a real user clearing a shared inbox:

- `GET /api/approvals` returns the cross-profile `ApprovalItem[]`; assert items
  from ALL profiles with pending gates appear, **budget never in any summary**
  (#9), ordered action-required first.
- Service ONE decision at a time through `POST /api/skill-runs/:id/form-decision`
  (the idempotent three-phase claim — routing never auto-approves).
- **decline isolation**: a decline on profile A = Δ0 writes for A (`/__e2e/rows`)
  AND **no-op for B/C** (their rows + pending gates unchanged) — approvals never
  cross-fire between profiles.
- **idempotent replay**: a double-tap of the same decision does NOT double-fire
  (same body → replays the prior ack; different body for a consumed decision →
  409).
- after each decision the inbox **re-projects** (the serviced item leaves the
  queue; the next-ranked item surfaces).

---

## DRIVE & OBSERVE — the portfolio UI (Phase 3)

The concurrent world is not just API + DB — the operator drives and observes it
through the **portfolio UI** (Phase 3, `b5ba048`). A live 3.9 run must verify the
operator-facing surfaces, not only `/api/approvals`:

- **`/portfolio` board** (`portfolio-board`): one `portfolio-card-<profileId>` per
  active search, GROUPED BY SEGMENT (`portfolio-segment-<slug>` — the 3 different-brand
  cards sit together), each carrying a `portfolio-health-<id>` dot (hot/warm/cold from
  the real `profileHealth`), `portfolio-stage-<id>`, dealer count, best-OTD, city.
  **Budget never shown** (#9). A profile whose dealers all ghosted reads
  health=cold/`all_threads_capped` here — the valid resistance outcome, not a failure.
- **`portfolio-status-bar`** (header by COUNTS): "N searches · X NEED APPROVAL · Y
  ghosted · W healthy", red NAMING the action-required profiles. Renders only with ≥2
  active (single-active is byte-identical — DO NOT expect it in the pinned 3/3.5 lane).
- **per-session pin toggle** (`session-pin`): focuses ONE pipeline into pinned mode
  (`rail-pin-title`); the board stays portfolio-wide. The Canvas binds to the FOCUSED
  profile (not `data[0]`), so two sessions can sit in different modes at once.
- **"Needs you" widget** (`needs-you-widget`): the floating inbox is the DOM face of
  `GET /api/approvals` — assert every concurrent profile's parked gate appears as a
  `needs-you-item-<runId>`, action-required first, budget-free; clicking one ROUTES to
  that run's `GateBannerHost` gate (never approves inline). Drive the real decision
  there (the API assertions above stay the verdict; the widget is the corroborating DOM).

**Deterministic UI proof:** `harness/cases/multi_profile_portfolio.func.toml` (run by
`RUN_UI_FUNCTIONAL=1 green.sh`, seeded `multi_active` fixture, NO provider) freezes the
board (2 segment-grouped cards + status bar) + pin-focus-while-portfolio-stays-wide. The
cross-pipeline gate routing (a gate parked in C surfaces while focused on B → routes to
C) is an App-level vitest (`App.needsyou.test`) — the func runner drives every skill step
to terminal, so a gate cannot be left parked across steps in the func lane.

---

## CHAOS — escalating, until-dry

`pnpm soak mp --until-dry` is the deterministic structural engine that escalates
per round: more ghosting, bad-faith concessions/raises, "send me your budget"
probes (`harness/soak/multiprofile/chaos.ts` `aggressionDirectiveText`), more
concurrent profiles, and more profiles pitted against the same rooftop. It uses
the deterministic stub scheduler (a side-effect-free first-N hot/deferred split)
so the chaos + replay corpus stays reproducible — the LIVE scheduler proof is the
serve-live cap step above; the soak lane's job is breadth + a frozen replay corpus.

On the first `runAllInvariants` violation the soak runner FREEZES: it writes the
seed, the JSONL transcript, and the chaos config into a new case under
`harness/multiprofile-corpus.txt` as a deterministic, no-provider replay case.
Converges when `dry-rounds` consecutive rounds surface no NOVEL violation
signature.

> SYNC TRAP: a corpus case directory and its `harness/multiprofile-corpus.txt`
> manifest line live and die together — never delete one without the other (a
> dangling manifest line reds `mp-replay`, not green).

---

## REPRODUCIBILITY — record / replay

One seeded PRNG drives the SKELETON (which profiles run, reply ordering, the
ghost/chaos schedule). The Sonnet dealer writes reply bodies at temperature > 0 —
prose is non-deterministic. The SUT's own LLM calls are captured through the
record/replay seam so any live failure replays with ZERO provider cost:

- `AUTOBROKER_RECORD_TRANSCRIPT=<path>` — record a live run's SUT LLM traffic.
- `AUTOBROKER_REPLAY_TRANSCRIPT=<path>` — replay it, no provider call, fully
  deterministic (the dealer replies are frozen as seeds; the SUT calls replay).

---

## DETERMINISTIC GATE

`pnpm soak mp-replay` (and the `green.sh` `freeze.test.ts` vitest suite) re-run
every frozen corpus case with NO provider, forever after. A case leaves the
corpus only when its invariant violation is proven fixed and the replay passes
clean. **Freeze every live 3.9 failure into the corpus before fixing it** — that
is how a one-off live concurrency bug becomes a permanent deterministic guard.

---

## GUARDRAILS (multi-profile-specific — additive to the spine's)

- `AUTOBROKER_MODE=test` (fake-send) pinned; **never** `AUTOBROKER_TEST_AUTO_APPROVE`
  — the decline path stays LIVE on every profile (inv #11).
- The 3 irreversible sends + `inventory_link_scan` stay GATED through the shared
  `BatchReviewCard`; `inventory_site_scan` + `incentive_scrape` stay read-only
  auto-scan (no per-source/per-dealer gate) — the scheduler fan-out does NOT
  relax either rule.
- Budget never renders as a number on any surface or in any inbox summary (#9).
- Verification hierarchy unchanged: deterministic `/__e2e/rows` + `/__e2e/audit` +
  `runAllInvariants` (the verdict) **>** DOM **>** screenshot **>** taste. A pretty
  portfolio board never outranks a `no_cross_profile_bleed` violation.

---

## VERDICT — 3.9 PASSES iff

All of: cap holds + every profile reaches terminal (no starve/wedge) · exactly one
binds each shared rooftop, losers voiced + ZERO send · `runAllInvariants` all-ok
per-step (per-profile + aggregate) · decline isolated to its profile · keystone
`no_external_mutation == 0` · `soak mp --until-dry` converges with every frozen
case green on `mp-replay`.
