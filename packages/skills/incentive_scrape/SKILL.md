# incentive_scrape

Scrape current manufacturer incentives for each active profile's vehicle.
Skill #5 (fourth browser skill, the Phase-2 capstone), phase 2, risk class
`local_write` (writes are local product rows only — `manufacturer_incentives`;
no external mutation). One flat linear Mastra workflow, 7 named steps, **one
suspend** — the OEM first-encounter approval that gates the first contact with
any incentive source the user has never approved before.

## Phases

The runtime flow, grounded in the 7-step workflow
(`packages/workflows/src/incentiveScrape.ts`):

1. **Resolve profile** — pinned id wins; otherwise this skill's documented
   exception to the three-branch rule applies: it enumerates **all** active
   profiles (one scrape target per profile, never a silent newest pick;
   provenance is `pinned | all_active`). Zero active profiles → typed STOP.
2. **Load targets** — per profile: US gate, ZIP requirement (a profile that
   never geocoded a postal code fails its target loud), and the 7-day cache
   gate in code — same `(make, model, zip)` scraped within 7 days from an
   unchanged URL → the brand is skipped and counted, no navigation.
3. **Resolve OEM source (suspend on first encounter)** — registry file lookup
   (`<AUTOBROKER_DATA_DIR>/incentive_sources.toml`, atomic + lock-disciplined)
   → on miss, the in-code per-brand seed table → still unresolved or
   unregistered → the **approval suspend**: "first encounter with a new
   incentive source — scrape this URL?" Save writes the registry entry (the
   cross-run memory; later runs never ask again), Skip parks the brand for
   this run, **Decline ends the whole run: zero navigation, zero writes, no
   registry entry.** Aggregator hosts (KBB/Edmunds/Cars.com/CarGurus/TrueCar/
   Autoblog) and non-US OEM domains are rejected in code and are never
   suggested or approvable.
4. **Render + extract** — Playwright render of the offers page via the read
   face (navigation cap, bounded lazy scroll, offer-card collection with a
   voiced plain-snapshot fallback). The render localizes so region-priced cash
   appears: it accepts the page's cookie consent (raises access rate; the click
   carries no PII) and, when the page exposes its own location/ZIP picker, types
   the profile's ZIP DIGITS ONLY into it — never a name, phone, or address. The
   page then makes its OWN region request, so no two-parameter URL is ever
   built (the single-parameter source-URL rule is untouched). A collapsed picker
   is force-filled with a voiced fallback. Then the no-tools structured
   `incentive_extract` call (fenced untrusted snapshot, flat all-required
   schema, Zod-revalidated rows dropped + counted on mismatch; a card with no
   inline expiration keeps `expires` null — never inferred from footer/legal
   copy). Dual-source shape: the OEM brand site is primary; when a profile
   dealer is bound, its rooftop specials page is the secondary arm —
   agreement boosts confidence, a same-program amount/expiry split is voiced
   as a `source_discrepancy` span while the OEM truth persists unchanged. A
   blocked page is recorded at first contact and never escalated; an OEM
   block can fail over to the rooftop arm (voiced), both arms refused = an
   honest blocked failure with exactly one contact per arm.
5. **Filter cash types (pure)** — the 5-class whitelist in code
   (customer_cash / loyalty / military / conquest / lease_cash); APR,
   lease-payment pricing and deferrals are dropped and counted. The LLM never
   sees this gate.
6. **Persist** — the ONLY write step: DELETE-then-INSERT keyed
   `(make, model, zip)` in one transaction; partial failure rolls back and
   existing rows survive.
7. **Confirm (pure, zero-LLM)** — templated summary of
   `brands_scraped / brands_skipped / brands_extraction_failed`; an
   empty-offers world is a valid outcome, not an error. The run ends here.

## Guardrails

- **First contact is gated** — an unregistered source never gets navigated
  before the approval decision; decline = zero navigation, zero writes, no
  registry entry (and the next run asks again).
- **The registry is user consent, not cache** — only an explicit Save writes
  it; it lives in the data dir (isolated per harness run), is read with a
  fail-loud parser, and written atomically under a lock.
- **Pure-capture core** — the render/extract path holds no DB handle and no
  gate Approver; the L2 mutation funnel is structurally unreachable.
- **Source discipline in code** — SSRF validation on every candidate URL
  (https-only, no credentials, no traversal, single-placeholder templates at
  most), aggregator and non-US rejection tables, blocked-never-escalated.
- **#1244 fail-closed** — capture and structured extraction never mix; the
  only LLM call runs with no HITL and a malformed/suspend-shaped return
  hard-aborts before persist (zero rows from a failed run).
- **Untrusted content** — offer pages ride the prompt between
  UNTRUSTED-content fences with a do-not-follow notice.
- **Deterministic gates the LLM never sees** — the 7-day cache gate and the
  cash-type whitelist are tools code; prompt text cannot widen them.
- **Budget never leaves the profile** — the extraction schema carries no
  budget-shaped field.
- **Idempotent persist** — DELETE-then-INSERT per (make, model, zip) makes
  re-scrapes converge; a rolled-back failure leaves the previous truth intact.

## References

In-repo paths only:

- Workflow: `packages/workflows/src/incentiveScrape.ts`
- Typed contracts (input/output, suspend/resume, fenced prompt):
  `packages/workflows/src/incentiveScrapeContracts.ts`
- Deterministic core (OEM host classify, cache gate, cash whitelist, merge,
  cross-verify, seed table): `packages/tools/src/incentives/pure.ts`
- Consent registry (TOML, lock + atomic write):
  `packages/tools/src/incentives/registry.ts`
- Persist (DELETE-then-INSERT transaction):
  `packages/tools/src/incentives/persist.ts`
- Source-URL validation: `packages/tools/src/ssrf.ts`
- Incentive schema (closed type/eligibility vocabularies):
  `packages/core/src/schema/incentive.ts`
- Server descriptor (approval resume seam): `apps/server/src/skillRuns.ts`
- Registry entry: `packages/skills/src/registry.ts`
- Harness cases: `harness/cases/incentive_scrape.ui_first_encounter.toml`,
  `harness/cases/incentive_scrape.ui_decline.toml`
