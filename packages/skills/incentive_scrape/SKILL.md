# incentive_scrape

Scrape current manufacturer incentives for each active profile's vehicle.
Skill #5 (fourth browser skill, the Phase-2 capstone), phase 2, risk class
`local_write` (writes are local product rows only — `manufacturer_incentives`;
no external mutation). One flat linear Mastra workflow, 7 named steps, **no
suspend**: because the skill is READ-ONLY (it fetches public OEM offers pages
and writes only local rows — it never sends email or submits a form), a
brand-new incentive source is recorded and scraped **automatically**, never
gated by a human approval (owner directive 2026-06-23).

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
3. **Resolve OEM source (auto-record on first encounter)** — registry file
   lookup (`<AUTOBROKER_DATA_DIR>/incentive_sources.toml`, atomic +
   lock-disciplined) → on miss, the in-code per-brand seed table. On a first
   encounter the seed source is **recorded automatically** (the registry entry
   is written — the cross-run memory) and the run proceeds, with NO human
   approval. No registry entry and no seed → an honest `no_oem_source` failure.
   Aggregator hosts (KBB/Edmunds/Cars.com/CarGurus/TrueCar/Autoblog) and non-US
   OEM domains are still rejected in code and are never recorded or scraped.
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

- **First contact is ungated (read-only)** — a brand-new source is recorded
  and scraped automatically; the read-only scrape sends nothing and submits
  nothing, so there is no human approval to render.
- **The registry is cross-run memory** — the first encounter writes it; it
  lives in the data dir (isolated per harness run), is read with a fail-loud
  parser, and written atomically under a lock.
- **Pure-capture core** — the render/extract path holds no DB handle and no
  gate Approver; the L2 mutation funnel is structurally unreachable.
- **Source discipline in code** — SSRF validation on every candidate URL
  (https-only, no credentials, no traversal, single-placeholder templates at
  most), aggregator and non-US rejection tables, blocked-never-escalated.
- **Structured-output fail-closed** — capture and structured extraction never mix;
  the only LLM call runs with no HITL and if `emit_result` never fires (or its args
  fail Zod) the run hard-fails before persist (zero rows from a failed run).
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
- Typed contracts (input/output, fenced prompt):
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
- Server descriptor: `apps/server/src/skillRuns.ts`
- Registry entry: `packages/skills/src/registry.ts`
- Harness case: `harness/cases/incentive_scrape.ui_first_encounter.toml`
