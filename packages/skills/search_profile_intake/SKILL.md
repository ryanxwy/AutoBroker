# search_profile_intake

Create a new-car search profile from a slash form or freeform prose. Skill #1
(e2e-first), phase 1, risk class `local_write` (writes are local product rows
only — `search_profiles` + `audit_log` — gated behind explicit user
confirmation; no external mutation). One flat linear Mastra workflow, 8 named
steps, no nested workflow.

## Phases

The runtime flow, grounded in the 8-step workflow
(`packages/workflows/src/searchProfileIntake.ts`):

1. **Entry** — launch as `/search_profile_intake` (slash) or via freeform prose.
   The input mode picks whether the prefill step runs.
2. **Freeform prefill (LLM)** — freeform launch only: an LLM call
   (`intake_freeform_prefill` useCase) seeds the form from the prose. A slash
   launch passes through. **Prefill output never persists** — it only pre-fills
   the form the user will confirm.
3. **Form (collect)** — suspend ① (`data_collection`). The user submits, declines,
   or cancels the form. Decline/cancel terminates the run as `declined`, and every
   later step short-circuits to zero writes.
4. **Validate** — pure parse of the submitted form against the strict input schema.
5. **Trim-verify (LLM)** — trim is required at the form (owner-directed), so this
   runs on every intake: an LLM call
   (`intake_trim_verify` useCase) checks the trim is real for the make/model.
   If invalid → suspend ② (`force_override` gate): the user force-overrides
   (audited), revises (re-verify), or declines. A revise that still verifies
   invalid re-suspends the gate (fail-closed) — it never proceeds unaudited.
6. **Geocode resolve** — `goplaces.resolveLocation` turns the location text into
   coordinates. Resolved → carry coords forward. Ambiguous/failed → suspend ③:
   the user picks a candidate, retries with a new query, or declines. The shown
   candidate list and effective query ride the suspend payload so a `pick`
   indexes the exact list shown.
7. **Persist** — `profileService.create` is the only DB write (the user
   confirmation gate is the form submit at phase 3, suspend ①); it returns
   `{ profileId, auditId }`. A confirmed force-override has already written its
   `intake_verification_forced` audit row at step 5.
8. **Handoff** — emit the structured created summary plus redactions; the run
   ends and the profile is available to downstream skills.

## Guardrails

- **Coordinate-resolution invariant** — persist requires resolved lat/lng; the
  workflow never carries null coordinates forward into a profile row. A run with
  unresolved coordinates suspends (geocode resolve) or declines; it never writes.
- **Profile-ASK exemption** — intake is the one skill that does NOT resolve an
  existing profile. It never needs a pin and never silently picks a newest-active
  profile; it creates a fresh one. Launching intake from a pinned session forks a
  fresh unpinned session and carries a scope notice (intake never inherits/sets a
  pin).
- **ActiveSlotConflict** — at most one active profile per `(account, brand)`. A
  second active row for the same pair is rejected as a typed `ActiveSlotConflict`
  surfaced by the tools layer; the workflow propagates it without retry.
- **New cars only / year gate** — the model year must be the current or next
  model year; enforced server-side in `SearchProfileIntakeInputSchema`
  (`packages/core/src/schema/intake.ts`), mirrored by the form's year-segmented
  widget.
- **Fake-phone default** — the dealer-facing phone is fake unless the user
  explicitly opts in. The default is enforced in the tools layer, not in prompt
  text.
- **Budget internal-only** — `budget_max` is internal and never dealer-facing;
  it is redacted from any communication surface in code, not by prompt.
- **Decline path** — decline/cancel at any suspend (form, force-override gate,
  geocode resolve) terminates the run `declined` with zero `search_profiles`
  writes. A previously-confirmed force-override audit row stays (an audited
  decision genuinely happened); it is not linked to a profile id.
- **force_override** — overriding an LLM-flagged-invalid trim is an explicit,
  audited human decision: it writes an `intake_verification_forced` audit row
  immediately at the force-override gate, before any profile exists.

## References

In-repo paths only:

- Workflow: `packages/workflows/src/searchProfileIntake.ts`
- Skill-local contracts (emit + resume schemas): `packages/workflows/src/intakeContracts.ts`
- Persist (the only DB write path): `packages/tools/src/profile/profileService.ts`
- ActiveSlotConflict + typed errors: `packages/tools/src/profile/errors.ts`
- Geocode resolve: `packages/tools/src/profile/goplaces.ts`
- Core input + profile schemas: `packages/core/src/schema/intake.ts`,
  `packages/core/src/schema/searchProfile.ts`
- Registry entry: `packages/skills/src/registry.ts`
- Live-harness cases: `harness/cases/search_profile_intake.*.toml`
