# inventory_site_scan

Scan the profile's approved dealer rooftops for matching new-car inventory.
Skill #3 (second browser skill), phase 2, risk class `local_write` (writes are
local product rows only — `dealer_inventory_sources` + `inventory_listings`;
no external mutation). One flat linear Mastra workflow, 6 named steps, **no
human gate** — the scan is read-only (it browses dealer SRPs; it never sends or
submits), so it auto-scans every in-radius rooftop with no per-dealer approval
(owner directive 2026-06-23).

## Phases

The runtime flow, grounded in the 6-step workflow
(`packages/workflows/src/inventorySiteScan.ts`):

1. **Resolve profile** — the typed three-branch resolver
   (`packages/tools/src/profile/resolver.ts`): explicit pin wins; exactly one
   active → inferred-newest (logged); zero / two-plus active → typed STOP. The
   `pinned | inferred_newest` provenance threads through to the run output.
2. **Build targets** — full-radius default: every approved rooftop for the
   profile, distance recomputed by haversine from the profile×dealer
   coordinates (never the stored cross-profile column). Non-US, no-website,
   malformed-URL and distance-unknown rows are skipped *and counted*;
   `max_targets` is an optional emergency valve, not a default truncation. No
   targets → typed STOP.
3. **Auto-approve targets (no gate)** — the scan is read-only, so there is no
   human-approval suspend: every in-radius target from step 2 is auto-approved
   and the run proceeds straight to scanning. (The shared `batch_review` gate
   still guards the irreversible send skills + `inventory_link_scan`; only this
   read-only scan skips it.)
4. **Scan dealers (pure capture, zero writes)** — one isolated browser per
   rooftop, up to 4 concurrent, launch-staggered; per-host nav queue keeps the
   politeness interval even across same-host rooftops. Per dealer: SRP
   resolution (platform fingerprint → canned path probe → browser-walk
   fallback), the three-rung filter ladder (URL template → whitelisted DOM
   filter widgets → unfiltered floor; every exit voiced), card collection, and
   bounded VDP tab fan-out (≤3 open / ≤2 active) for VIN-less candidates. A
   blocked rooftop (403/429/challenge signature) is recorded at first contact
   and never retried harder.
5. **Extract** — per-dealer structured LLM extraction (`inventory_extract`
   useCase) in the two-phase posture: the capture phase used tools only; this
   phase is a no-tools structured call. Snapshots ride the prompt between
   UNTRUSTED-content fences; every row is Zod-revalidated and dropped (and
   counted) on mismatch; a VIN must appear verbatim in the captured snapshot to
   survive (`validateVinProvenance`). If `emit_result` never fires (or its args fail
   Zod) the run hard-fails with a thrown typed error.
6. **Persist + confirm** — ONE capture-then-serial write
   (`packages/tools/src/inventory/persist.ts`): VIN-arm and listing-URL-arm
   upserts with their composite UNIQUE keys, atomic VIN promotion, stale
   listings superseded only under sources whose scan actually succeeded. Each row
   also carries the **deterministically-harvested price detail** (no LLM): `msrp`
   + `listed_price`, plus `dealer_markup` (a **LABELED** market-adjustment / ADM
   line only — the `selling>MSRP` inference is intentionally NOT used) and
   `pricing_breakdown_json` (dealer add-on line items + `priceGated`). These two
   columns merge **harvest-aware**: a re-scanned VDP that reads cleanly and finds
   no markup CLEARS it (sentinel `0` / empty blob → `COALESCE` clears), a VDP not
   visited PRESERVES the prior value (`null` → `COALESCE` keeps), so a red markup
   flag de-ratchets honestly when the dealer removes it.
   Confirm is a zero-LLM templated summary; the run ends here — no auto-chain
   into lead submission.

## Guardrails

- **No external mutation, gate or not** — the scan is read-only, so it ships
  with no human-approval gate; safety comes from structure, not a confirm: the
  scan path can reach no mutation face at all (next bullet).
- **Pure-capture core** — steps 4–5 hold no DB handle and no gate Approver;
  the L2 gate wraps only mutation faces (`submitForm` et al.), so a mutation is
  structurally uncallable from the scan path. A scan run must produce zero
  gate events, zero `lead_submissions` rows, zero `gmail.send` events.
- **Filter ≠ mutation** — the DOM filter face is a positive whitelist
  (select / checkbox / apply) behind a denylist-first fence that rejects
  lead-form-shaped widgets; this skill's filter verbs never type free text. The
  shared browser layer also offers a sibling location-ZIP face (opt-in, NOT
  wired here) that types ZIP DIGITS ONLY into a page's own location picker
  behind the same fences plus a US-ZIP value gate — never a name/phone/address,
  never a mutation. The shared navigate also accepts cookie consent (no PII).
- **Politeness over coverage** — per-host minimum interval, bounded lazy
  scroll, bounded snapshot, post-capture cool-down; blocked rooftops are
  refusals, never escalation targets (no stealth, no fingerprint tricks).
- **Untrusted content** — dealer pages are untrusted; snapshots are fenced in
  the LLM prompt with a do-not-follow notice; extraction output is
  Zod-revalidated; writes are prepared-statement-only.
- **Structured-output fail-closed** — tools-only capture and no-tools structured
  extract never mix in one step; if `emit_result` never fires (or its args fail Zod)
  the run hard-fails with a thrown typed error — never a silent tool-skip.
- **Profile-ASK three-branch** — never silently picks newest-active; pinned vs
  inferred-newest is typed, logged, and asserted by the harness `resolution`
  anchor.
- **Budget never leaves the profile** — the extraction schema has no budget
  field at all; nothing budget-shaped can ride a prompt or a row.
- **Re-scan is non-destructive** — superseding stale listings is gated to
  sources whose latest status is `scanned`; blocked/failed scans never
  invalidate previously captured rows.

## References

In-repo paths only:

- Workflow: `packages/workflows/src/inventorySiteScan.ts`
- Deterministic core (ids, normalizers, match classify, VIN provenance):
  `packages/tools/src/inventory/pure.ts`
- Filter ladder (URL templates + DOM widget whitelist):
  `packages/tools/src/inventory/filter.ts`
- Persist (capture-then-serial writer, supersede rules, harvest-aware
  markup/breakdown merge): `packages/tools/src/inventory/persist.ts`
- VDP price + breakdown harvest (deterministic, regex-only, no LLM):
  `packages/workflows/src/inventoryPriceHarvest.ts` (MSRP / selling / priceGated),
  `packages/tools/src/inventory/inventoryBreakdownHarvest.ts` (LABELED dealer
  markup + add-on line items). Migration `packages/db/drizzle/0004_*.sql` adds
  `dealer_markup` + `pricing_breakdown_json`. (Downstream: `inventory_compare`'s
  color cross-check advisory uses `packages/tools/src/inventory/colorMatch.ts`.)
- SRP resolution / platform fingerprint: `packages/tools/src/inventoryScout.ts`
- Browser service (isolation, politeness, block classification, filter face):
  `packages/tools/src/browser.ts`
- Three-branch profile resolver: `packages/tools/src/profile/resolver.ts`
- Listing schema (11-field flat, explicit-null): `packages/core/src/schema/inventoryListing.ts`
- Registry entry: `packages/skills/src/registry.ts`
- Harness cases: `harness/cases/inventory_site_scan.ui_button.toml`,
  `harness/cases/dealer_pipeline.ui_prefix.toml`
