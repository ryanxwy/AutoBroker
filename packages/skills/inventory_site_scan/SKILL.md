# inventory_site_scan

Scan the profile's approved dealer rooftops for matching new-car inventory.
Skill #3 (second browser skill), phase 2, risk class `local_write` (writes are
local product rows only — `dealer_inventory_sources` + `inventory_listings`;
no external mutation). One flat linear Mastra workflow, 6 named steps, **one
suspend** — the `batch_review` approval card that gates every dealer-site
contact behind an explicit per-rooftop human decision.

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
3. **Batch review (suspend)** — the only gate: an approval card listing every
   target rooftop with per-row Approve / Skip, Select-all as an affordance over
   explicit ids, and Decline as the stop verb. Approved ids must be a subset of
   the shown targets (enforced server-side). **Decline = zero navigation, zero
   writes, terminal Cancelled.**
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
   survive (`validateVinProvenance`). A malformed tool call hard-aborts.
6. **Persist + confirm** — ONE capture-then-serial write
   (`packages/tools/src/inventory/persist.ts`): VIN-arm and listing-URL-arm
   upserts with their composite UNIQUE keys, atomic VIN promotion, stale
   listings superseded only under sources whose scan actually succeeded.
   Confirm is a zero-LLM templated summary; the run ends here — no auto-chain
   into lead submission.

## Guardrails

- **Gate before any site contact** — the batch_review suspend renders before
  the first navigation; decline produces exactly zero navigations and zero
  writes (the harness decline case asserts both tables Δ=0 and
  browser-activity absent).
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
- **#1244 fail-closed** — tools-only capture and no-tools structured extract
  never mix in one step; a malformed/skipped tool call hard-aborts the run.
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
- Persist (capture-then-serial writer, supersede rules):
  `packages/tools/src/inventory/persist.ts`
- SRP resolution / platform fingerprint: `packages/tools/src/inventoryScout.ts`
- Browser service (isolation, politeness, block classification, filter face):
  `packages/tools/src/browser.ts`
- Three-branch profile resolver: `packages/tools/src/profile/resolver.ts`
- Listing schema (11-field flat, explicit-null): `packages/core/src/schema/inventoryListing.ts`
- Registry entry: `packages/skills/src/registry.ts`
- Harness cases: `harness/cases/inventory_site_scan.ui_decline.toml`,
  `harness/cases/inventory_site_scan.ui_button.toml`,
  `harness/cases/dealer_pipeline.ui_prefix.toml`
