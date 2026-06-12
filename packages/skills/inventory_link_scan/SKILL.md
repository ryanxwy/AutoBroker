# inventory_link_scan

Visit not-yet-scanned dealer inventory URLs and match listings against the
buyer profile. Skill #4 (third browser skill), phase 2, risk class
`local_write` (writes are local product rows only — `dealer_inventory_sources`
status transitions + `inventory_listings`; no external mutation). One flat
linear Mastra workflow, 8 named steps, **one suspend** — the `batch_review`
card that gates every link visit behind an explicit per-row human decision.

## Phases

The runtime flow, grounded in the 8-step workflow
(`packages/workflows/src/inventoryLinkScan.ts`):

1. **Resolve profile** — the typed three-branch resolver: explicit pin wins;
   exactly one active → inferred-newest (logged); zero / two-plus active →
   typed STOP. `pinned | inferred_newest` provenance threads to the output.
2. **Load sources** — `dealer_inventory_sources` rows with `last_status =
   'pending'` for this profile, oldest first, joined with their dealer rows.
   Zero pending links is a normal `0/0 done` outcome, not a STOP. (In the
   dev period pending rows arrive via manual/seeded bootstrap; the email
   reply-extract skill writes them in production later.)
3. **Filter junk (pure)** — `classifySkipUrl`, five first-hit-wins rules
   (unsubscribe → google_services → social_media → crm_tracking →
   bare_homepage; a query-bearing root URL is kept). Junk links never reach
   the review card.
4. **US gate (pure)** — one batched `isUsDealer` pass; non-US rows are
   excluded and counted. Neither gate-front step writes anything.
5. **Review gate (suspend)** — the `batch_review` card, one row per link
   (same card, same wire as the site-scan skill — never a fork). Approved ids
   are enforced server-side as a subset of the shown rows; **decline = zero
   navigation, zero writes, terminal Cancelled.**
6. **Visit + extract (pure capture, zero writes)** — approved links bucketed
   by hostname, ≤4 isolated browsers, per-host nav queue holding the
   politeness interval; a host that blocks at first contact is recorded and
   never re-contacted (remaining same-host links are marked blocked without
   another request). Card collection with a voiced plain-snapshot fallback,
   then per-link no-tools structured extraction (`inventory_extract`
   useCase): fenced untrusted snapshot, Zod-revalidated rows, VIN must appear
   verbatim in the captured page, profile matching in code
   (`classifyMatchStatus` + `filterForProfile` — matching listings only).
7. **Persist** — the ONLY write step, on the shared capture-then-serial
   writer: per-source status transitions (`pending → scanned / blocked /
   failed / skipped`; a card-skipped link stays `pending` and is re-offered
   next run), dual-arm (VIN + normalized-URL) listing upserts on the frozen
   id space, stale supersession only under sources that actually scanned.
8. **Confirm (pure, zero-LLM)** — templated summary: links scanned, listings
   matched, per-status tallies. The run ends here — no auto-chain.

## Guardrails

- **Gate before any site contact** — the batch_review card renders before the
  first navigation; the decline harness case asserts both tables Δ=0 exact
  and browser-activity absent.
- **Pure-capture core** — the visit/extract path holds no DB handle and no
  gate Approver; the mutation funnel (`submitForm` behind the L2 gate) is
  structurally unreachable from this workflow.
- **Blocked is a refusal** — one contact, nothing scrolled or snapshotted,
  never escalated; a host-wide block propagates to same-host siblings WITHOUT
  re-contact (`propagated` marked in the source's error record).
- **Per-link isolation** — one dead link never fails its same-host siblings;
  a whole-bucket failure degrades to per-link failed outcomes in input order.
- **#1244 fail-closed** — the only LLM call is a no-tools structured extract
  with no HITL; a malformed/suspend-shaped return hard-aborts with a typed
  error — the run fails, persist is never reached, sources stay pending.
- **Untrusted content** — dealer pages ride the prompt between
  UNTRUSTED-content fences with a do-not-follow notice; writes are
  prepared-statement-only.
- **Profile-ASK three-branch** — never a silent newest-active pick; the
  harness `resolution` anchor asserts the provenance.
- **Frozen id space** — `computeSourceId` / `computeListingId` /
  `urlNormalize` are the parity functions shared with the site scan; seeded
  and scanned rows converge on the same ids (no reimplementation anywhere).
- **Budget never leaves the profile** — only year/make/model/trim reach
  classification; only make/model reach the prompt.

## References

In-repo paths only:

- Workflow: `packages/workflows/src/inventoryLinkScan.ts`
- Junk classifier + profile match filter: `packages/tools/src/inventory/linkScanPure.ts`
- Source loader + seed writer: `packages/tools/src/inventory/sources.ts`
- Shared deterministic core (ids, normalizers, match classify, VIN provenance):
  `packages/tools/src/inventory/pure.ts`
- Shared persist (status transitions, dual-arm upserts, supersession):
  `packages/tools/src/inventory/persist.ts`
- Browser service (isolation, politeness, block classification):
  `packages/tools/src/browser.ts`
- Server descriptor (ids⊆shown resume seam): `apps/server/src/skillRuns.ts`
- Harness seed mechanism: `harness/seed.ts` (+ the `[[seed.dealer_inventory_sources]]`
  case grammar in `harness/cases.ts`)
- Registry entry: `packages/skills/src/registry.ts`
- Harness cases: `harness/cases/inventory_link_scan.ui_button.toml`,
  `harness/cases/inventory_link_scan.ui_decline.toml`
