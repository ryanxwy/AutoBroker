# @autobroker/skills

The skill manifest layer: a typed `SkillDef` registry plus a per-skill
`SKILL.md` human doc. Two parts:

- **Machine manifest** (`src/registry.ts`) — the single cross-layer source of
  skill identity. One `SkillDef` per skill: `id`, `slash`, `title`, `summary`,
  `phase`, `riskClass`, `status`, `workflowId` (the matching
  `@autobroker/workflows` workflow id, or `null` while planned), `inputs`,
  `outputs`. Pure data + types — this package imports no framework, so both the
  server and the UI can consume it. The server projects the implemented entries
  into the `/api/skills` HTTP manifest; a lint-gate test there asserts the
  registry's `workflowId`s and the workflows registry agree both ways.
- **Per-skill `SKILL.md`** (e.g. `search_profile_intake/SKILL.md`) — a concise
  human doc with exactly three sections: **Phases** (the skill's runtime flow),
  **Guardrails** (the load-bearing invariants), **References** (in-repo paths).
  Each implemented skill adds its own `SKILL.md` beside this `src/`.

## The 17 skills

Derived from `src/registry.ts` (build order, phase 1 → 5):

| Phase | Skill | Risk | Status |
|---|---|---|---|
| 1 | `search_profile_intake` | local_write | implemented |
| 1 | `quote_audit` | read_only | planned |
| 1 | `quote_compare` | read_only | planned |
| 1 | `inventory_compare` | read_only | planned |
| 2 | `dealer_geosearch` | local_write | planned |
| 2 | `inventory_site_scan` | local_write | planned |
| 2 | `inventory_link_scan` | local_write | planned |
| 2 | `incentive_scrape` | local_write | planned |
| 3 | `dealer_inbox_check` | local_write | planned |
| 3 | `dealer_reply_extract` | local_write | planned |
| 3 | `dealer_hygiene` | destructive | planned |
| 4 | `quote_pipeline` | local_write | planned |
| 4 | `daily_digest` | local_write | planned |
| 4 | `pipeline_reset` | destructive | planned |
| 5 | `dealer_web_lead_submit` | irreversible | planned |
| 5 | `negotiation_followup` | irreversible | planned |
| 5 | `dealer_closeout_email` | irreversible | planned |

The registry in `src/registry.ts` is authoritative; this table mirrors it.

## Build order — dependency × risk

Safest face first (deterministic, read-only + intake), product surface next
(browser-first), most dangerous last (irreversible fake-send). **One skill = one
commit**, prefixed `phaseN/<skill>:`.

1. **Phase 1 · deterministic core + intake** — `search_profile_intake` (skill
   #1, e2e-first), `quote_audit` (template), `quote_compare`,
   `inventory_compare`. Read-only + profile root-dep.
2. **Phase 2 · browser service + scans** — `dealer_geosearch`,
   `inventory_site_scan`, `inventory_link_scan`, `incentive_scrape`. Browser
   read + local db.write.
3. **Phase 3 · email service + LLM extract** — `dealer_inbox_check`,
   `dealer_reply_extract` (LLM template), `dealer_hygiene` (destructive,
   typed-YES). Gmail read + fake-mailbox/local db.write.
4. **Phase 4 · orchestration / report** — `quote_pipeline`, `daily_digest`,
   `pipeline_reset` (destructive, typed-YES). Compose + destructive-local.
5. **Phase 5 · irreversible mutations** — `dealer_web_lead_submit`,
   `negotiation_followup`, `dealer_closeout_email`. **Fake-send throughout**;
   the commit body carries `[fake-send]` until Phase 5 acceptance is GREEN, and
   human approval is never hidden. The gate stack (native Mastra approval /
   `suspend()` → L2 in-process gate fail-closed → fallback suspend → the
   `AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS=1` fuse) is mandatory.

## The 7-step per-skill loop

Each skill is built one at a time through:

1. define the contract (core Zod schema)
2. build the deterministic tools + pure-function tests
3. scaffold the flat Mastra `createWorkflow` and bind `harness.generate` /
   model policy
4. map the fallback gating (suspend-and-ask vs auto-allow-with-trace-span)
5. **DeepSeek live** (must be GREEN before the next skill starts)
6. cross-provider cheap smoke (anthropic / openai)
7. acceptance + cost/time ledger row

## Layout

```
packages/skills/
  src/registry.ts          machine manifest (SkillDef registry)
  src/index.ts             public surface
  <skill>/SKILL.md         per-skill human doc (Phases / Guardrails / References)
```
