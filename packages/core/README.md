# @autobroker/core

> Status: Phase 0 (foundation) · 2026-06-02 · Layer 1 of the AutoBroker (TS)
> five-layer monorepo. Owns the **pure TYPES + Zod contracts** every other layer
> shares. Sits below `@autobroker/model`. Canonical architecture lives in the
> plan repo: `../../../AutoBroker-dev-plan/ts-rebuild/architecture/ARCH_OVERVIEW.md` and
> `ARCH_STRUCTURED_OUTPUT.md`.

Layer 1 (`core`) is the bottom of the one-way dependency chain:

```
core → model → workflows → tools → app
```

## The contract: no framework imports

`@autobroker/core` **MUST NOT import any framework**. The AI SDK (`ai`,
`@ai-sdk/*`), Drizzle, Playwright, Gmail/Maps adapters, and any HTTP server are
**invisible** here. The only runtime dependency is **Zod** (`^4`), because the
schemas in this package *are* the shared contracts.

This is enforced two ways:

1. **TS project references** in `../../tsconfig.base.json` — a reference pointing
   the wrong way (e.g. `core → model`) is a build error.
2. **Dependency hygiene** — `package.json` lists only `zod`. Adding `ai` /
   `drizzle-orm` / `playwright` here is a layering violation; put that code in
   the layer that owns it (model / tools).

Why it matters: keeping `core` framework-free means the same Zod schemas
post-validate model output, type the SQLite rows, and shape the HTTP/IPC surface
without dragging a runtime into the type layer.

## What lives here

| File | Owns |
| --- | --- |
| `src/types.ts` | `ModelAlias` (`{provider}.{tier}`), `Provider`/`ModelTier`, `CapabilityFlags`, `SkillRunStatus` (incl. `awaiting_approval`), `DriverKind` (product enum) + `HarnessDriverKind` (harness label set) |
| `src/schema/dealerQuote.ts` | `DealerQuoteSchema` — flat, required-with-null offer; `financing_mode` discriminant |
| `src/schema/auditFlag.ts` | `AuditFlagSchema` + stable `AuditFlagCode` catalog (computed in calc, not by the LLM) |
| `src/schema/searchProfile.ts` | `SearchProfileSchema` — one `(account, brand)` new-car search |
| `src/index.ts` | the public re-export surface |

## Schema conventions (per `ARCH_STRUCTURED_OUTPUT`)

Output schemas are written to the **lowest common denominator** across the three
providers' JSON-Schema subsets:

- **Flat** — no nested objects.
- **Required with explicit `null`** — never `.optional()`; "not present" is an
  explicit `null` so api-key `emit_result` + Zod post-validation stay
  deterministic.
- **`enum` over free strings** where the value space is closed.
- **`.strict()`** — extra keys are forbidden, so a hallucinated key fails
  validation instead of silently passing.
- **Cross-field rules** (the `financing_mode` discriminant, Rule 1 cross-mode
  leakage, Rule 2 mode-required fields, ±$1 math) are **post-validation in
  `calc`** — they are *not* encoded as JSON-Schema the model sees.

## `DriverKind` — product enum vs harness label

The **product** `DriverKind` enum is `agent | shell | codex_cli`.
`deepseek_apikey` is **not** a product driver — it is a **harness-only** label
(`HarnessDriverKind`) emitted by the live-harness runner and asserted by the
`driver_kind` anchor. DeepSeek runs through the ordinary api-key **model lane**,
not a bespoke driver. See
`../../../AutoBroker-dev-plan/ts-rebuild/harness-standard/ANCHORS.md`.

## Provider defaults

Per the product-owner decision of **2026-06-02**, `DEFAULT_PROVIDER` is
`deepseek` — DeepSeek is the **default api-key provider** *and* the live-harness
test agent. **Anthropic** and **OpenAI** are equally first-class, switchable
api-key lanes. There is **no per-provider tiering and no privacy precondition
gate**; the privacy posture is an upfront README disclosure (see the model layer
and the root README). `core` only encodes the `Provider` set and the default;
routing lives in `@autobroker/model`.

## Build

```bash
pnpm --filter @autobroker/core build      # tsc -b
pnpm --filter @autobroker/core typecheck
```
