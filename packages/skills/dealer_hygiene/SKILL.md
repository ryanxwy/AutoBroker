# dealer_hygiene

Clean up stale / duplicate dealer threads and CRM-platform contacts for a
profile. Phase 3, risk class `destructive` — this is one of the two destructive
skills; its human gate is **three strictly-ordered batch-review suspends**, and
no confirmation means zero destruction. One flat linear Mastra workflow, 6 named
steps, **three suspends** (5a/5b/5c), **zero LLM** — detection and the
keep-biased intent classifier are pure predicates. `profilePin: pin_required`.

## Phases

The runtime flow, grounded in the 6-step workflow
(`packages/workflows/src/dealerHygiene.ts`):

1. **Resolve profile** — records provenance. (Detection currently runs
   global-mailbox; scoping it to the pinned profile is a deferred Phase-5 product
   decision — see Guardrails.)
2. **Detect (pure, global reads)** — three deterministic detectors
   (`packages/tools/src/hygiene/detect.ts`): orphan threads (a thread whose
   `gmail_thread_id` is actually a real message-id, zero messages), CRM-only
   threads (inbound-only, no offer, a sibling outbound thread exists, a
   suppressible intent), and CRM-platform contacts (relay sender, not the primary
   reply target, no quote owned). The intent classifier is KEEP-biased: anything
   with a value-class intent (`quote` / `pricing` / `qualification`) is never a
   candidate, and a mixed-intent thread is excluded up front so it never reaches
   a write guard.
3. **Suspend 5a — orphans**, **5b — CRM threads**, **5c — CRM contacts** — three
   strictly-ordered batch-review suspends. Each presents its candidates with
   explicit per-item selection (undecided default, never approve-all); decline at
   ANY stage sets `declined` and short-circuits the rest. Empty stage → its
   suspend is skipped.
4. **Verify (the single atomic writer)** — runs ONLY if no stage declined, in ONE
   transaction (`packages/tools/src/hygiene/verify.ts` → `commitHygiene`): the
   approved orphans are hard-deleted (after a re-confirm), the approved CRM
   threads suppressed, the approved CRM contacts demoted. A thrown typed guard
   rolls back the WHOLE transaction. A post-write assertion proves no orphan id
   leaked into a suppression row and no quote-owning contact was demoted.
   All-empty → `nothing_to_clean` success; re-run is idempotent.

## Guardrails

- **Decline at ANY stage = ZERO writes for the whole run** — shape (A): the three
  suspends only STAGE selections; `commitHygiene` at `verify` is the single
  atomic writer and runs only when no stage declined. A decline at 5b (after 5a
  staged approvals) still writes nothing.
- **Explicit per-item selection, never approve-all** — each resume carries an
  explicit `approved_ids` (min 1); the server rejects any id not in the retained
  suspend payload (`content_invalid`). The review card defaults every row
  undecided and gates submit on all-decided + ≥1 approved.
- **Soft-delete over hard-delete** — CRM contacts are DEMOTED
  (`is_crm_platform_sender=1`), never deleted; CRM threads are SUPPRESSED (a
  `thread_suppression` row + state flag), never deleted. The ONLY hard `DELETE`
  is a re-confirmed true orphan thread.
- **Orphan red-line** — the orphan path NEVER writes the orphan's
  `gmail_thread_id` (which is a message-id) into `thread_suppression`; it deletes,
  it does not suppress.
- **Typed throwing guards (defense in depth)** — `suppressThread` rejects any
  thread with an offer row or a value-class intent; `demoteCrmContact` rejects a
  contact that owns a quote or is the primary reply target. A throw inside
  `commitHygiene` rolls back the entire transaction (all-or-nothing).
- **Idempotent re-run** — a demoted contact is recorded as a `scope='contact'`
  suppression row and excluded from re-detection, so a second run surfaces zero
  candidates (`nothing_to_clean`).
- **Zero-LLM** — detection + classification are pure; the summary is templated
  (counts + the car, never budget, never a hex run id).
- **Deferred (Phase-5 product decisions, not yet enforced in the workflow)** —
  (a) the registry sets `profilePin: pin_required` (the UI pre-launch gate is
  live) but the workflow's resolve step is still soft; (b) detection is
  global-mailbox, not pinned-profile-scoped — scoping it changes the skill's
  semantics (global cleanup → per-search cleanup). Both are open Phase-5 items to
  confirm when hygiene is next touched.

## References

In-repo paths only:

- Workflow: `packages/workflows/src/dealerHygiene.ts` (+ `dealerHygieneContracts.ts`)
- Deterministic core: `packages/tools/src/hygiene/{detect,classify,writes,verify}.ts`
- Review surface: `apps/ui/src/gate/HygieneReviewCard.tsx` (+ `hygieneStage.ts`), routed by `apps/ui/src/gate/GateBannerHost.tsx`
- Server descriptor + per-stage resume: `apps/server/src/skillRuns.ts`
- Registry entry (`profilePin`, `riskClass: destructive`): `packages/skills/src/registry.ts`
