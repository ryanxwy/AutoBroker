# @autobroker/tools

> Status: Phase 4 scaffold, 2026-06-03. Owns the **only layer that touches the
> product DB or external APIs**: in-process tool closures for Gmail, Playwright
> browser, DB writes, pure calc/validators, and the **L2 in-process gate bridge**
> (the single side-effect path) plus the **L1 `AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS`
> env fuse**. Layer 4 of the five-layer monorepo
> (`core → model → workflows → tools → app`). See also the
> [workflows package](../workflows/README.md) (Layer 3, the Mastra orchestrator
> that drives this gate).

## The side-effect invariant (the whole point of this package)

**Every** product-DB handle and **every** external API call in AutoBroker lives
here and nowhere else. Routes, the CLI, workflows, and skills are all forbidden
from touching the product DB or the network directly — they call into this
layer. Mastra's own workflow runtime state lives in a separate `mastra.db`;
those framework tables are not product schema.

Within this layer, every **irreversible external action** (Gmail send, dealer
form submit, typed-YES destructive confirm) is reachable **only** through the L2
gate (`requestApproval` / `withGate` in `src/gate/index.ts`). There is no second
code path from the model to `gmail.send` or `browser.submit`. Provider built-in
tools are pinned with `allowedTools` / `tools:[]` so the model cannot reach a
shell and bypass the gate.

## The four-layer gate stack

| Layer | Role |
| --- | --- |
| L3 native Mastra approval / `suspend()` | Convenience only, api-key lane only. |
| **L2 in-process gate bridge** | **Load-bearing. All lanes. fail-CLOSED, single structured path.** (Renamed from the legacy `build_sdk_mcp_server`.) |
| fallback-gate suspend | Workflow re-asks the human. |
| L1 `AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS=1` | Redundant **outer ring**, always armed in harness runs, **never the only floor**. |

### Fail-CLOSED rules enforced in `src/gate/index.ts`

- **Malformed / absent structured request (#1244):** the gate `assertWellFormed`
  check throws and DENIES. It never falls back to prose, never regexes a function
  name out of free-text content and executes it. *fail-open == silent-fallback ==
  forbidden.*
- **Deny path:** returns an explicit `declined` verdict with `autoApprove: false`
  — the safe default. Approval is never implicit; an approver that errors is
  treated as a decline.
- **L1 env fuse:** when armed, throws `ExternalMutationsBlockedError` **before**
  any network/file mutation — a redundant outer ring, not the primary floor.

## Files

| File | Role |
| --- | --- |
| `src/gate/index.ts` | L2 in-process gate bridge + L1 env fuse. The single side-effect path. |
| `src/gmail.ts` | Gmail tool. Hand-built RFC-2822 raw message = the single **fake/real send seam** (default **fake**); real send only inside an approved gate commit. |
| `src/browser.ts` | Playwright-native tool. `page.route`/`waitForResponse` read structured JSON off the wire; mutating click/submit wrapped by the gate. |
| `src/db.ts` | Layer-4 wrapper over `@autobroker/db`: re-exports the single Drizzle + better-sqlite3 factory and resolves non-DB artifacts under `AUTOBROKER_DATA_DIR`. |
| `src/calc.ts` | Pure offer math: `validateOfferMath` (±$1 reconciliation) and `STATE_DOC_FEE_CAP`. |
| `src/validators.ts` | Pure post-validation + safety rules (no budget in dealer text, fake phone unless opted in). |

## Isolation invariant

Never touch production `~/.autobroker/autobroker.db`. The data dir comes from
`AUTOBROKER_DATA_DIR`; during the parity period it points at `~/.autobroker-ts`,
isolated from the frozen legacy Python repo. Subprocesses inherit and re-resolve
it.

## Dependency rules

- May import: `@autobroker/core`, `@autobroker/db`.
- May **not** import: `@autobroker/workflows`, `app` (anything above it in the
  wall).
- Enforced by TypeScript project references in `tsconfig.json`.

## Status of the scaffold

The gate's fail-closed control flow (structural validation, env fuse, decline
default) is **real and load-bearing** in the scaffold. Real RFC-2822 assembly,
budget redaction, Drizzle wiring, the full `STATE_DOC_FEE_CAP` table, and Zod
post-validation are marked `TODO(phase-4)` and land as the side-effect tools are
built per skill.
