---
name: decision-log
description: Record a settled or overturned decision in the plan repo's architecture/DECISIONS.md (currentTruth + supersededLedger), keeping the architecture pillar current. Use when a design decision crystallizes or a prior verdict is reversed in the AutoBroker rebuild.
disable-model-invocation: true
---

You append/update a decision entry in the plan repo's decision ledger so the
**architecture pillar stays current**. The decision comes from the user's args
or from the just-concluded discussion.

## Resolve paths

- PLAN = `$(git rev-parse --show-toplevel)/../AutoBroker-dev-plan`
- DECISIONS = `$PLAN/ts-rebuild/architecture/DECISIONS.md`
- Today's daily report (if present) = `$PLAN/ts-rebuild/daily/$(date +%Y-%m-%d).html`

## Steps

1. **Read** `DECISIONS.md` and match its existing structure (a currentTruth
   table/list and a supersededLedger). Do not invent a new format.

2. **Compose the entry** for the decision:
   - **currentTruth**: topic · the decision (one or two sentences) · provenance
     (who/what settled it, date `YYYY-MM-DD`) · confidence.
   - If it **overturns** a prior decision, ALSO add a supersededLedger row: the
     claim · was-verdict · now-verdict · supersededBy · why. Mark the old entry
     as overridden rather than deleting it (preserve the audit trail).

3. **Present the proposed entry to the user for confirmation**, then write it
   into `DECISIONS.md` in the right section.

4. **Cross-link**: if today's daily report exists, add a one-line reference in
   its **决策与偏移** section pointing to the new DECISIONS.md entry. If a
   matching `ARCH_*.md` page describes the affected area, note that it may need a
   follow-up edit (do not silently rewrite it).

## Guardrails

- Write only in the plan repo (`$PLAN/ts-rebuild/architecture/DECISIONS.md` and,
  optionally, today's daily report). Never the code repo.
- Markdown is canonical; do not regenerate any HTML mirror — flag it for a
  deliberate sync instead.
- Absolute dates only. Keep the audit trail (overturned ≠ deleted).
