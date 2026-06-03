# @autobroker/skills

> Status: Phase 0 (foundation) · 2026-06-02 · SCAFFOLD PLACEHOLDER (no skill
> impls yet). This package will hold the 17 AutoBroker skill definitions, built
> **one at a time** in dependency × risk order across Phases 1–5. The build order,
> the 7-step per-skill loop, and the fallback taxonomy are canonical in
> [`../../../AutoBroker-dev-plan/ts-rebuild/phases/SKILL_LOOP.md`](../../../AutoBroker-dev-plan/ts-rebuild/phases/SKILL_LOOP.md)
> and the `PHASE_N_*.md` files; the live verification standard is in
> [`../../../AutoBroker-dev-plan/ts-rebuild/harness-standard/STANDARD.md`](../../../AutoBroker-dev-plan/ts-rebuild/harness-standard/STANDARD.md).

## What a skill is

Each skill is a directory (not built yet) containing:

- **contract** — the core Zod schema (imported from `packages/core`; never
  redefined here) describing the skill's structured output. Flat, all-`required`
  with explicit `null`, enum-based — the minimum common JSON-Schema subset every
  provider accepts. Re-validated with Zod 4 post-validation.
- **`SKILL.md`** — the LLM judgment/reasoning prompt. The same `.md` is loaded by
  both the dashboard "Run skill" button and Claude Code `/slash-commands`.
- **emit_result binding** — the single in-process `emit_result` tool (with the
  Zod schema executed in-process) that the skill uses for structured output.
  `Output.object` and `tools` are **never** mixed on the same call (that injects
  a per-step `json_schema` that triggers DeepSeek #1244 text-dump).
- **fallback-gate mapping** — which fallbacks are **semantic/irreversible**
  (`prose-vs-typed-gate`, `newest-vs-pinned-profile`, `email_fallback` scope
  switch) → `suspend → ask` through the gate; and which are
  **transient/equivalent** (attachment primary→backup, JS→snapshot,
  native-vision→OCR) → auto-pass but record a trace span. Every fallback fires
  audibly; irreversible actions fail-closed.

## Build order — dependency × risk (17 skills)

Safest face first (deterministic, read-only), most dangerous last (irreversible
fake-send). **One skill = one commit**, prefixed `phaseN/<skill>:`. Step 5
(DeepSeek live) must be GREEN before the next skill starts.

| Phase | Skills | Risk |
|---|---|---|
| **P1 · deterministic core** | `quote_audit`★ (template), `quote_compare`, `inventory_compare` | read-only |
| **P2 · LLM extract** | `search_profile_intake` (root dep), `dealer_reply_extract`★ (LLM template), `dealer_inbox_check`, `incentive_scrape` | read + Gmail/browser read |
| **P3 · browser scan** | `dealer_geosearch`, `dealer_hygiene`, `inventory_site_scan`, `inventory_link_scan` | browser read + local db.write |
| **P4 · orchestration / report** | `quote_pipeline`, `daily_digest`, `pipeline_reset` (typed-YES) | compose + destructive-local |
| **P5 · irreversible mutations** ⚠ | `dealer_web_lead_submit`⚠, `negotiation_followup`⚠, `dealer_closeout_email`⚠ | irreversible — **fake-send throughout** |

★ = phase template/exemplar. ⚠ = irreversible mutation; its commit carries
`[fake-send]` in the body until Phase 5 acceptance is GREEN, and the four-layer
defense (L3 needsApproval → L2 in-process gate bridge fail-closed → fallback gate
suspend → L1 `AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS=1` fuse) is mandatory.

## The 7-step per-skill loop

1. define the contract (core Zod)
2. build the deterministic tools + L1 pure-function tests
3. wire `harness.generate({ useCase, schema })`
4. map the fallback gating (suspend vs trace-span)
5. **DeepSeek live** (must be GREEN to proceed)
6. cross-provider cheap smoke (anthropic / openai)
7. acceptance + cost/time ledger row

See [`SKILL_LOOP.md`](../../../AutoBroker-dev-plan/ts-rebuild/phases/SKILL_LOOP.md) for the
full loop and the fallback classification.

## TODO

- [ ] Phase 1: scaffold `quote_audit` as the deterministic-core template.
- [ ] No skill directories exist yet — this package is intentionally empty of
      implementations until Phase 1 begins.
