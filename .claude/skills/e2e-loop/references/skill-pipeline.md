# skill-pipeline — the 17-skill sweep (step 3)

Loaded at step 3 (reused by `--light`). The spine owns the verdict rule and the 5
control routes; this file owns the *detail*: where each skill renders, what gate to
press, the order, and the live-only edges. The FULL matrix lives in the design doc
(`ts-rebuild/20260617-e2e-loop-skill-conversion/`); here = must-exercise +
no-coverage edges. Testids are harvested from `apps/ui/src` — if one drifts,
re-harvest live (`grep data-testid`), don't trust a stale string.

> **Scope note:** This sweep IS the pinned single-brand spine; step **3.9 multi-profile fan-out** does not begin until this sweep (and 3.5) reaches terminal+green (rulings #4/#7 — see `references/multi-profile-lane.md`).
>
> **Three-bucket classification:** per-skill outcomes are read through the three-bucket classification — blocker / backlog / polish (SKILL.md "How to classify what you find"). A correct-but-sub-optimal result — a thin comparison, a low-coverage-but-`≥0.5` scan, a graceful `no_oem_source` — is **a backlog item**, NOT a skill FAIL; only the named blockers (safety or data-loss breaches) fail a skill.

## A. Canvas-region + gate-testid cheat sheet

**Tabbed Canvas — only the ACTIVE panel renders.** Click `canvas-tab-<key>` THEN
read `canvas-panel-<key>`; reading an inactive panel returns nothing. Keys:
`overview · dealers · inventory · quotes · replies · incentives`. Tab badge counts
come from each slice's `.length`. Pager: `canvas-pager` / `-prev` / `-next` /
`-range`.

**Gate buttons (press, never bypass; never set `AUTOBROKER_TEST_AUTO_APPROVE`):**

| gate | testids |
|---|---|
| intake form | `intake-submit` (slash opens an empty 18-field form — hand-type, never auto-extract email) |
| single-send approval | `approval-prompt` · `approval-approve` · `approval-deny` · `approval-approve-all`; host banner `gate-banner` |
| batch review (`inventory_link_scan`, inbox) | `batch-review-card` · `batch-select-all` · `batch-submit` · `batch-decline` (NOT `inventory_site_scan` — it auto-scans all in-radius dealers, no gate; owner 2026-06-23) |
| hygiene 3-stage | `hygiene-review-card` · `hygiene-stage` · `hygiene-select-all` · `hygiene-submit` · `hygiene-decline` |
| pipeline_reset typed-YES | `reset-confirm-token` (type `YES`) → `reset-confirm`; card `confirmation-gate-card` |
| profile-ASK picker (0/2-active) | `stop-pick-list` · `stop-pick-option` |
| hard-delete (cleanup) | `profile-hard-delete-open` → confirm |
| inventory | `inventory-candidate-row` · `inventory-listing-link` (`<a target=_blank>`) |
| chat | `chat-input-textarea` |

**`inventory_site_scan` auto-scans ALL in-radius dealers — no batch gate** (owner
2026-06-23). It is read-only (browses dealer SRPs; never sends/submits), so there is
no human-approval suspend and no decline path; the run goes straight to scanning the
full in-radius target set. Per-site depth and cost are bounded by the product itself —
it records at most the top-20 best-match in-stock cars per website
(`PER_DEALER_RECORD_CAP`), and each site scans via its built-in make/model/year
filter. (Reverses the 2026-06-18 "scan ~5 nearest" note AND the older "select-all the
site_scan gate" note — the gate is gone.)

**SELECT ALL in `dealer_web_lead_submit`'s batch gate** — press `batch-select-all`,
never a subset. Real users research many dealerships (often 100+), so cutting dealers
destroys the market-research breadth that is the point. (The SHARED `batch-*` gate
still guards the 3 send skills + `inventory_link_scan` — only site_scan lost it.)

**KEYSTONE — email_fallback / contact-flip second-suspends have NO dedicated
testid.** The lead_submit `email_fallback` scope switch (browser.submit→gmail.send)
and the negotiation `contact-flip` recipient change each render as a *second,
independent* approval on the **same `approval-prompt`/`gate-banner` card**. Assert
it is `sensitive` (carries `data-sensitive`) and exposes **NO `approval-approve-all`**.
To exercise email_fallback you watch for the SECOND `approval-approve` after the
batch card — not a new testid.

## B. Canonical sweep ORDER

`intake → dealer_geosearch → inventory_site_scan → inventory_link_scan →
incentive_scrape → inventory_compare → dealer_web_lead_submit(fake) →`
`[dealer-brain seeds 4 differentiated quotes via inject_replies here]`
`→ dealer_inbox_check → dealer_reply_extract → quote_audit → quote_compare →
negotiation_followup(fake) → quote_pipeline → daily_digest →`
`[inject_crm_threads here]`
`→ dealer_hygiene(destructive) → dealer_closeout_email(fake) → pipeline_reset(LAST)`.

**Three hard ordering invariants (each cost a prior run):**
1. **lead_submit before the email chain (inbox→closeout).** Approving ≥1 lead
   creates the `lead_submissions` ANCHOR the whole chain needs; `inject_replies`
   makes threads but NOT an anchor.
2. **`inject_crm_threads` before hygiene.** No CRM seed → "already clean" → the
   3-stage destructive gate is untestable.
3. **closeout SECOND-LAST, pipeline_reset LAST after telemetry.** Closeout CLOSES
   the profile — earlier ends the profile mid-sweep. Reset wipes
   the DB; telemetry (step 5) must be read first (trap #9).

## C. Per-skill must-exercise (terse — one line each)

1. **search_profile_intake** · `/search_profile_intake` · topbar ProfileCard · `intake-submit` — never-guess-email (slash form hand-typed, NL must not auto-extract); decline=Δ0; ambiguous-city `gate-location-pick` (no func case).
2. **dealer_geosearch** · `/dealer_geosearch` · dealers tab · STOP `stop-pick-option` — metro∈allowlist or `resolveMetro` falls to Irvine; 0-active→intake CTA, 2-active→picker; radius 125mi.
3. **inventory_site_scan** · `/inventory_site_scan` · inventory tab · (no gate — auto-scans all in-radius dealers, owner 2026-06-23) — scanned-0 vs never-scanned empty-state; platform-specificity (Toyota/Dallas 0, Honda DealerOn ~12) is NOT a bug; **no batch gate / no decline path** (read-only). **DATA-QUALITY (not count):** after the scan writes ≥1 listing, `GET /__e2e/dataquality?skill=inventory_site_scan` — **hard FAIL iff `priced==0 AND msrp_present==0 AND gated==0`** (TOTAL price loss; 2026-06-22: 10 rows all `listed_price`/`msrp` NULL because the SRP gated price behind "Get Instant Price"). The VDP-price harvest now captures it off the already-loaded detail page; `coverage≥0.5` is the healthy target, below-but->0 a soft note (per-dealer VDP budget bounds gated-car coverage). **NEW (F1 enrichment) — markup/add-on breakdown coverage:** the same `dataquality` response also carries `breakdown_parsed`/`breakdown_coverage` (+ informational `markup_present`/`addons_present`); **hard FAIL ONLY iff `vdp_linked>0 AND breakdown_parsed==0`** (reached VDPs but dropped EVERY price breakdown — a total had-and-lost of the new dimension). `markup_present==0`/`addons_present==0` is the HEALTHY norm (most listings carry no labeled dealer markup) and is NEVER a fail. **MUST-EXERCISE (conditional, mirrors the Negotiations protocol):** read `inventory-markup-flag`/`inventory-addons-flag` on the candidate rows; IF a row carries a labeled markup, `browser_click` it → assert the opened `inventory-detail-modal` renders `inventory-detail-markup`/`inventory-detail-addons` (an unread breakdown shows `inventory-detail-breakdown-unknown`, never a silently-clean card). IF an `inventory-color-crosscheck` advisory surfaces (loose color pref vs stocked names), confirm it offers `inventory-color-add` + `inventory-color-crosscheck-dismiss` and shows NO budget. All conditional on the data being present so it never over-fits a metro.
4. **inventory_link_scan** · `/inventory_link_scan` · inventory tab · `batch-*` — no-pending-links empty path; listing-link click-through; decline=Δ0.
5. **incentive_scrape** · `/incentive_scrape` · incentives tab · (no gate — new OEM sources auto-approved, owner 2026-06-23; the `approval-*` first-encounter gate is GONE) — a brand outside Hyundai/Toyota/Honda/Chevrolet → graceful `no_oem_source`, not a crash; OEM page unreachable / 0 current incentives → graceful valid result; 403→graceful-blocked, fast.
6. **inventory_compare** · `/inventory_compare` · inventory tab · (none) — bare-0 must give an actionable "scan first" message; Recommended/All split; NL "what's in stock" routes here (read existing), not site_scan — a routing artifact, not a bug.
7. **dealer_web_lead_submit** · `/dealer_web_lead_submit` · chat receipt + `gate-banner` · `batch-*`+`approval-approve` — approve ≥1 (the ANCHOR); decline=Δ0; **email_fallback 2nd `sensitive` suspend** no bulk-approve; fake-phone default; fuse-blocked → zero real send. Card shows a `batch-summary` (vehicle/email/placeholder-phone, never budget) + a height-capped scrollable `batch-rows`; question is "Submit lead inquiries to these dealers?" (not the scan verb). [fake-send]
8. **dealer_inbox_check** · `/dealer_inbox_check` · replies tab / InboxReviewCard · `stop-pick-option`+`batch-*` — needs the lead anchor (else `no_lead`); pin STOP `no_pin`; decline=Δ0 + watermark does not advance; reading writes no outbound row.
9. **dealer_reply_extract** · `/dealer_reply_extract` · quotes tab · (autonomous) — **#1244 fail-closed-THEN-AUTO-RECOVER on the largest extraction (lane A / deepseek ONLY)** (highest-value live check): a high-precision malformed signal (finish_reason≠tool_calls / empty `tool_calls` / `AI_InvalidToolInputError`) → the hop FAILS CLOSED + ledgers a `malformed_tool_call` row, then an **AUTOMATIC, no-HITL, same-provider one-hop retry** (deepseek-v4-flash → deepseek-v4-pro WITH thinking) — **NOT a user-surfaced/"disclosed retry" button, NOT a silent fallback, NEVER a regex-executed tool name**. A SECOND malformed (or a blob-only signal) fails closed at the typed terminus. Live anchors (the contract changed — do NOT expect a retry affordance): the malformed extraction leaves **2 ledger rows** (the v4-flash malformed-capture + the v4-pro recovery hop), **both `provider=deepseek`**; the captured `malformed_sample` is redacted (privacy-clean); no manual-retry control appears in the UI. (A HITL-bearing emit path still SUSPENDS first — unchanged; this auto-recovery is no-HITL-only.) **Lane B (claude OAuth) is structurally #1244-exempt** (no structured+tools mixing; a single structured call; the Zod parse is the fail-closed belt; the known deterministic lane-B fault is the Agent-SDK-rejects-`$schema` surface, stripped in `claudeOAuth.ts` — success-with-no-structured-output would mean that strip regressed) — its live check: the extraction returns typed rows or fails CLOSED with a ledgered failure row; NO recovery hop on lane B (`recoverEmitWithRetry` is deepseek-asserted), NEVER a silent fabrication. no_quote→0 rows; bundled-tax `sales_tax`=null is VALID. **DATA-QUALITY (not count):** `GET /__e2e/dataquality?skill=dealer_reply_extract` must show `otd_present/n ≥ 0.5` — a `dealer_quotes` row with NULL `otd_total` on a visibly-priced reply is a FAIL, distinct from the legit `no_quote`→0-rows and bundled-tax `sales_tax`=null.
10. **quote_audit** · `/quote_audit` · quotes-tab audit pills · (none) — DOC_FEE_CAP fires over the cap in capped states (CA/NY/WA + MN/MI/OH/MD); an uncapped state (TX/FL/OR) now fires DOC_FEE_UNCAPPED for a doc fee >~$500 (Phase 5 — no longer silent at $899); MATH_SANITY null-skip when tax bundled; MISSING_BREAKDOWN covers it; idempotent re-run = same rows.
11. **quote_compare** · `/quote_compare` · quotes tab · (none) — cash bucket ("cash:N", not "Compared 0"); off-mode/unspecified OTD folded into finance OTD-only; Best-OTD = min over digest+compare. **Cross-state (Phase 5):** when the profile has a home state the panel shows a `quote-compare-tax-note` (tax normalized to the home state, "wins on price/doc-fee/incentives, not tax"); each row carries home-state `normalized_tax`/`normalized_otd` + an OTD-delta `attribution` (sale-price/doc-fee/tax/incentive/other) vs the lowest-normalized-OTD baseline. Raw-OTD rank order is UNCHANGED (additive) — two different-state dealers on the same vehicle show IDENTICAL normalized tax.
12. **negotiation_followup** · `/negotiation_followup` · draft + `gate-banner` · `approval-approve` — code picks the tone; **budget NEVER in the draft** (`_redact_budget`, BLOCKER if it leaks); no competing dealer names; decline=Δ0; **contact-flip 2nd `sensitive` suspend** on recipient change (no func case); drives the dealer-brain multi-round loop. [fake-send]
    - **MUST-EXERCISE (Negotiations board):** after a follow-up round, open the board (`canvas-negotiation-grid`) → `browser_click` one `canvas-negotiation-card` → assert the per-card OTD/round-count (`canvas-negotiation-otd`, `canvas-negotiation-email-count`) UPDATED, the opened `negotiation-detail-modal` sections present (`negotiation-status-summary`, `negotiation-strategy`, `negotiation-next-steps`, `negotiation-competing-quote`), and `negotiation-reply-row`s render NEWEST-FIRST with the seeded auto-reply/ad ABSENT. Budget never shown (inv #9).
        - **F3 AI-summary (live-only — NEVER a func anchor):** the `negotiation-status-summary` WRAPPER is always present (the deterministic `status_line` floor). The subordinate lazy LLM "AI summary" is a SEPARATE element `data-testid="negotiation-ai-summary"` (the RESOLVED `<p>`, not the "summarizing…" loading one). In a live/buyer run assert the resolved `negotiation-ai-summary` is PRESENT and its text ≠ "summarizing…" (primary check); text differing from `status_line` is a secondary belt. This is LIVE-ONLY — the func lane is keyless and degrades to `{summary:null}` by design, so NEVER pin AI-summary presence in a `*.func.toml`. Budget never appears here (inv #9).
13. **quote_pipeline** · `/quote_pipeline` · chat report + quotes/incentives · pin STOP + nested child suspends — **child-suspend RESUME** (the hard part of the orchestrator, only decline has a func case); `dry_run` previews without writing; targeted-VIN decline=Δ0.
14. **daily_digest** · `/daily_digest` · `/digest` / overview headline · (none) — budget NEVER in the digest (text AND headline); Best-OTD agrees with compare; zero-active → graceful SKIP, never an ASK (it is `infer_ok`, all-profile by design); `digest.last_at` advances.
15. **dealer_hygiene** · `/dealer_hygiene` · `hygiene-review-card` · 3 stages — seed `inject_crm_threads` FIRST or it's "already clean"; **decline at ANY of the 3 stages = Δ0** (one atomic txn); orphan-thread red line; soft-delete + full rollback on typed-guard mismatch.
16. **dealer_closeout_email** · `/dealer_closeout_email` · receipt + suppress · `approval-approve`/`batch-skip-all` — run SECOND-LAST (closes the profile); count fake sends ("0 sent" was a bug; under AUTOBROKER_MODE=test (fake-send) writes 0 fake_mailbox); decline=Δ0; atomic send+close+suppress; SKIP-ALL typed-return. [fake-send]
17. **pipeline_reset** · `/pipeline_reset` · `confirmation-gate-card` · typed-YES — run LAST (full wipe, telemetry first); bad/empty token → no wipe (server re-validates); decline=Δ0; typed-YES is the load-bearing floor; VACUUM backup pre-wipe.

## D. Exercise EACH run — under-tested edges (live-only)

The deterministic `*.func.toml` corpus does NOT pin these (the per-skill lines in
C flag each in place); ranked by value, the top live-only checks are: (1) **#1244
fail-closed-THEN-auto-recover on reply_extract's largest extraction (lane A only)**
(2 `provider=deepseek` ledger rows + redacted `malformed_sample` + NO retry button — the
contract changed; on lane B: typed rows or a CLOSED ledgered failure row — no recovery hop,
never a silent fabrication; see item 9) — the single highest-value check; (2) **a doc-fee flag fires** — `DOC_FEE_CAP` in a capped metro (CA/NY/WA +
MN/MI/OH/MD) on an over-cap fee, OR `DOC_FEE_UNCAPPED` in an uncapped metro (TX/FL/OR)
on a >~$500 fee (Phase 5); (3)
**MATH_SANITY null-skip** on a bundled-tax quote; (4) **email_fallback
+ contact-flip 2nd suspends** (both `sensitive`, no `approval-approve-all`;
contact-flip has no func case at all); (5) **decline = Δ0 via `/__e2e/rows`** for
every gated skill; (6) **empty-state hints** (site_scan empty-state, compare bare-0 scan-first hint);
(7) **incentive `no_oem_source`** graceful path; (8) **child-suspend RESUME** in
quote_pipeline; (9) **budget never leaks** in negotiation drafts and the digest;
(10) **location-ambiguity picker**.

**Plus these cross-cutting edges:**

- **A one-lane fault gets the cross-lane triage tree** (SKILL.md) — never an ad-hoc provider flip, never a mid-run lane switch.
- **Concurrent / interleaved suspends** — start a sibling skill while `quote_pipeline` is mid child-suspend; confirm the two gates don't cross-contaminate or auto-resolve.
- **SSE reconnect / serve-live restart mid-run** — the reverify-in-place reduction restarts serve-live; exercise a skill in-flight across a restart / an SSE break and confirm state recovers.
- **Provider 429 / timeout (non-#1244, either lane; on lane B also a subprocess failure)** — must degrade gracefully (surfaced, retryable), distinct from the malformed-tool path.
- **Stale/wrong `inject_reply_to_thread` threadId** — feed an unknown threadId and confirm the documented **400** path, not a silent new thread.
- **pipeline_reset mastra.db partition** — preserving Memory threads while deleting only snapshots is asserted as a MUST, but it is **NOT verifiable via the current `/__e2e/rows`** (no mastra table in the whitelist). Flag honestly: a candidate test-host check the loop MAY add through its own gated e2e-evolve fix machine as a recorded backlog item (add the missing verification surface) — **NOT a check to assert today.**

**Plus these NEW-feature cross-cutting live checks (last-3-days wave):**

- **F1 markup/add-on breakdown coverage** (item 3) — after the scan, read the F1-enrichment fields off `/__e2e/dataquality?skill=inventory_site_scan` (`breakdown_parsed`/`breakdown_coverage`); FAIL only on `vdp_linked>0 AND breakdown_parsed==0`. Conditionally open the inventory detail modal on a flagged-markup row.
- **F4 give-up / negotiation-status overlay** — after the dealer-brain ghost/retrade rounds, read the derived verdict surfaces (see `references/dealer-brain.md` "Verification checkpoints"): the Dealers tab `dealer-verdict-hold` / `dealer-verdict-switch` chips and the Replies tab `thread-class-chip`. These are derived-on-read off the product JSON (`/api/profiles/:id/dealers` + `/threads`) — corroborate the JSON with the DOM chip; no new test-host route.
- **F3 AI-summary present (live-only)** — see item 12: `negotiation-ai-summary` resolved + ≠ "summarizing…"; never a func anchor.

## E. Per-PASS cleanup

After EACH pass: hard-delete the profile (`profile-hard-delete-open` → confirm —
deferred-FK cascade over threads/messages/quotes/incentives/leads), THEN run
`pipeline_reset` (typed-YES) as a coverage run + belt-and-suspenders wipe. Assert
`search_profiles = 0` via `GET /__e2e/rows?table=search_profiles`. PASS-A
cleanup → re-brand-pick a NEW profile for PASS-B from scratch.
