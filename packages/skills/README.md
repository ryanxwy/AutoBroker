# @autobroker/skills

> Status: Phase 0 (foundation) · 2026-06-03 · SCAFFOLD PLACEHOLDER (no skill
> impls yet). This package will hold the 17 AutoBroker skill definitions, built
> **one at a time** in dependency × risk order across Phases 1–5. The build order
> is revised 2026-06-03 to browser-first: deterministic + intake -> browser
> service/scans -> email service + LLM extraction -> orchestration -> fake-send
> irreversible skills. The 7-step per-skill loop and fallback taxonomy are
> canonical in the dev-plan repo's `ts-rebuild/phases/` HTML files; the live
> verification standard is in `ts-rebuild/harness-standard/`.

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
  Structured object output and tools are **never** mixed on the same model step
  for DeepSeek (that injects a per-step `json_schema` that triggers the #1244
  text-dump).
- **Mastra workflow** — one flat linear `createWorkflow` per skill. Phase 0 owns
  the shared Mastra backbone; each skill adds only the workflow steps it needs,
  plus app-side status/gate projection.
- **fallback-gate mapping** — which fallbacks are **semantic/irreversible**
  (`prose-vs-typed-gate`, `newest-vs-pinned-profile`, `email_fallback` scope
  switch) → `suspend → ask` through the gate; and which are
  **transient/equivalent** (attachment primary→backup, JS→snapshot,
  native-vision→OCR) → auto-pass but record a trace span. Every fallback fires
  audibly; irreversible actions fail-closed.

## Build order — dependency × risk (17 skills)

Safest face first (deterministic, read-only), product surface next
(browser-first), most dangerous last (irreversible fake-send). **One skill = one
commit**, prefixed `phaseN/<skill>:`. Step 5 (DeepSeek live) must be GREEN
before the next skill starts.

| Phase | Skills | Risk |
|---|---|---|
| **P1 · deterministic core + intake** | `search_profile_intake` (skill #1, e2e-first — 2026-06-04 ruling ①), `quote_audit`★ (template), `quote_compare`, `inventory_compare` | read-only + profile root-dep |
| **P2 · browser service + scans** | `dealer_geosearch`★, `inventory_site_scan`, `inventory_link_scan`, `incentive_scrape` | browser read + local db.write |
| **P3 · email service + LLM extract** | `dealer_inbox_check`, `dealer_reply_extract`★ (LLM template), `dealer_hygiene` | Gmail read + fake-mailbox/local db.write |
| **P4 · orchestration / report** | `quote_pipeline`, `daily_digest`, `pipeline_reset` (typed-YES) | compose + destructive-local |
| **P5 · irreversible mutations** ⚠ | `dealer_web_lead_submit`⚠, `negotiation_followup`⚠, `dealer_closeout_email`⚠ | irreversible — **fake-send throughout** |

★ = phase template/exemplar. ⚠ = irreversible mutation; its commit carries
`[fake-send]` in the body until Phase 5 acceptance is GREEN, and the gate stack
(L3 native Mastra approval/`suspend()` convenience → L2 in-process gate
fail-closed → fallback gate suspend → L1
`AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS=1` fuse) is mandatory.

## The 7-step per-skill loop

1. define the contract (core Zod)
2. build the deterministic tools + L1 pure-function tests
3. scaffold the flat Mastra `createWorkflow` and bind
   `harness.generate({ useCase, schema })` / model policy
4. map the fallback gating (suspend vs trace-span)
5. **DeepSeek live** (must be GREEN to proceed)
6. cross-provider cheap smoke (anthropic / openai)
7. acceptance + cost/time ledger row

See the dev-plan repo's phase HTML files for the full loop and fallback
classification.

## TODO

- [ ] Phase 1: build `search_profile_intake` first (skill #1, e2e slice); `quote_audit` stays the deterministic-core template.
- [ ] No skill directories exist yet — this package is intentionally empty of
      implementations until Phase 1 begins.
