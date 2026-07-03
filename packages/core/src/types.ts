/**
 * @autobroker/core — shared type aliases and enums (Layer 1).
 *
 * Pure types + Zod only. This file MUST NOT import any framework
 * (no `ai`, no `@mastra/*`, no `drizzle-orm`, no `playwright`). See ./index.ts
 * and the package README for the layer contract.
 *
 * Grounded in the project's architecture decisions (see CLAUDE.md): DeepSeek is
 * the default api-key provider/live-harness test agent, and Mastra owns
 * orchestration while this package stays framework-free.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// ModelAlias — provider-neutral routing identity: `{provider}.{tier}`
// ---------------------------------------------------------------------------
//
// workflows/skills only ever name a `useCase`; policy() maps useCase ->
// ModelAlias, and the model-layer registry maps ModelAlias -> a concrete
// LanguageModel. Swapping providers is a one-string change in the registry.

/** Providers AutoBroker supports as first-class, switchable api-key lanes. */
export const PROVIDERS = ["deepseek", "anthropic", "openai"] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * Capability tier within a provider. The registry binds each {provider}.{tier}
 * to a concrete model id via `customProvider` aliases in the model layer.
 */
export const MODEL_TIERS = ["chat", "cheap", "strong"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** Template-literal alias type: e.g. "deepseek.cheap", "anthropic.strong". */
export type ModelAlias = `${Provider}.${ModelTier}`;

export const ProviderSchema = z.enum(PROVIDERS);
export const ModelTierSchema = z.enum(MODEL_TIERS);

/**
 * Zod validator for a ModelAlias string. Kept as a refined string (rather than
 * a giant enum of every cross product) so new tiers/providers do not require a
 * schema edit; the structural `{provider}.{tier}` shape is what we enforce.
 */
export const ModelAliasSchema = z
  .string()
  .refine(
    (s): s is ModelAlias => {
      const [provider, tier, ...rest] = s.split(".");
      if (rest.length > 0) return false;
      return (
        ProviderSchema.safeParse(provider).success &&
        ModelTierSchema.safeParse(tier).success
      );
    },
    { message: "ModelAlias must be `{provider}.{tier}` (e.g. deepseek.cheap)" },
  )
  .describe("Provider-neutral model alias, shape `{provider}.{tier}`.");

/**
 * DEFAULT provider per the 2026-06-02 product-owner override: DeepSeek is the
 * default api-key provider AND the live-harness test agent. Anthropic and
 * OpenAI are equally first-class, switchable api-key lanes.
 */
export const DEFAULT_PROVIDER: Provider = "deepseek";

// ---------------------------------------------------------------------------
// CapabilityFlags — what a routed model can/can't do, surfaced to policy()
// ---------------------------------------------------------------------------
//
// Used to fail-loud or down-route. Each provider supports a different subset of
// JSON-Schema features; structured-output decisions key off these flags rather
// than hard-coding provider names.

export const CapabilityFlagsSchema = z
  .object({
    /** Mixing `Output.object` with `tools` is safe (false for DeepSeek per #1244
     *  json_schema-injection text-dump; use emit_result or a two-phase pipeline). */
    supportsOutputObjectWithTools: z.boolean(),
    // Only the flag with a production reader (the #1244 strategy gate) is kept.
    // Re-add a capability flag here ONLY when a live case actually reads it.
  })
  .strict()
  .describe("Capabilities of a routed model; drives fail-loud / down-route.");

export type CapabilityFlags = z.infer<typeof CapabilityFlagsSchema>;

// ---------------------------------------------------------------------------
// Public run-status projection
// ---------------------------------------------------------------------------
//
// Mastra has its own workflow/run statuses. This vocabulary is the product's
// projected status contract so UI, harness, tools, and reports do not drift.
// The product never re-implements a status machine; it renames one — Mastra's
// 10-value run status projects onto these 7 (success → done, suspended →
// awaiting_approval, failed → error, canceled → aborted/declined with app
// metadata, …). `awaiting_approval` is the HITL suspend projection used for
// semantic or irreversible gates.

export const SKILL_RUN_STATUSES = [
  "pending",
  "running",
  /** Suspended at a gate; a typed resume_payload is persisted. Set on semantic /
   *  irreversible fallbacks (prose-vs-typed-gate, newest-vs-pinned-profile,
   *  email_fallback scope switch). */
  "awaiting_approval",
  "done",
  /** Terminal failure (Mastra `failed` → product `error`). */
  "error",
  /** User declined at an approval gate (deny path → zero external calls). */
  "declined",
  /** Heartbeat stale (> 5 min) → swept to aborted; distinct from `error`. */
  "aborted",
] as const;

export type SkillRunStatus = (typeof SKILL_RUN_STATUSES)[number];
export const SkillRunStatusSchema = z.enum(SKILL_RUN_STATUSES);

// ---------------------------------------------------------------------------
// DriverKind — PRODUCT enum vs HARNESS label
// ---------------------------------------------------------------------------
//
// NOTE: the *product* DriverKind enum is { agent | shell | codex_cli }.
// `deepseek_apikey` is a HARNESS-only label emitted by the runner and asserted
// by the `driver_kind` anchor (it must stay in lockstep with the runner's
// PROVIDER_DRIVER_KIND map). It is intentionally NOT a product driver —
// DeepSeek runs through the ordinary api-key model lane, not a bespoke driver.

export const DRIVER_KINDS = ["agent", "shell", "codex_cli"] as const;
export type DriverKind = (typeof DRIVER_KINDS)[number];
export const DriverKindSchema = z.enum(DRIVER_KINDS);

/**
 * Harness-only `driver_kind` anchor labels. Superset of the product enum plus
 * the per-provider test labels (e.g. `deepseek_apikey`). Asserted by the
 * harness evaluator's driver_kind anchor.
 */
export const HARNESS_DRIVER_KINDS = [
  ...DRIVER_KINDS,
  "deepseek_apikey",
  // anthropic_apikey / openai_apikey are the cross-provider test labels.
  // Wired through the runner PROVIDER_DRIVER_KIND map (harness/cases.ts) and the
  // server's provider→driver_kind derivation (apps/server runPubSub
  // PROVIDER_DRIVER_KIND). DeepSeek stays the default-resolved label.
  "anthropic_apikey",
  "openai_apikey",
  // anthropic_oauth is the Claude OAuth subscription lane (lane B) label — the
  // run-chip footer for a run resolved to anthropic+oauth (e.g. `/e2e-loop
  // --provider claude`). Distinct from anthropic_apikey: same provider, the
  // subscription method, NOT the api key. Live-only (no func case pins it).
  "anthropic_oauth",
] as const;
export type HarnessDriverKind = (typeof HARNESS_DRIVER_KINDS)[number];
export const HarnessDriverKindSchema = z.enum(HARNESS_DRIVER_KINDS);

/**
 * Map an api-key `Provider` to its harness `driver_kind` anchor label
 * (`{provider}_apikey`). The SINGLE source of truth for the provider→label
 * derivation behind the two-place lock-step: the server's init-frame emitter
 * and the harness runner both derive their `driver_kind` from THIS map
 * (apps/server runPubSub + harness/cases.ts), so the wire value and the anchor
 * expectation can never silently drift. DeepSeek resolves to `deepseek_apikey`
 * (the default), anthropic/openai to their cross-provider labels.
 */
export function providerDriverKind(provider: Provider): HarnessDriverKind {
  return `${provider}_apikey` as HarnessDriverKind;
}

/**
 * Method-aware `driver_kind` for a RESOLVED AgentSelection. The Claude OAuth
 * subscription lane (anthropic + oauth, lane B) reads `anthropic_oauth`; every
 * api-key lane reads `{provider}_apikey` via providerDriverKind. The rail's
 * run-chip footer derives from THIS, so a subscription run (whose ledger records
 * `pricing_source=subscription`) never mislabels as an api-key run.
 */
export function selectionDriverKind(
  provider: Provider,
  method: "apikey" | "oauth",
): HarnessDriverKind {
  if (provider === "anthropic" && method === "oauth") return "anthropic_oauth";
  return providerDriverKind(provider);
}
