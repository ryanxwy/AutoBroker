/**
 * cases — load + Zod-validate a case TOML into a typed Case.
 * Three binding layers: [meta] (id / archetype / ordered skills[]), [narrative]
 * (session_origin / input_mode / provider / profile), [[steps]] (each with
 * resume[] scripts + an anchors[] tripwire array). The anchor specs are parsed
 * into the evaluator's AnchorSpec union so a case is fully declarative.
 *
 * The case grammar maps onto the committed wire contract:
 *   - [narrative.profile]  → the form content the collect-step resume submits.
 *   - [[steps.resume]]     → an ordered suspend-answer script. Each entry's `on`
 *     names the suspend kind (data_collection / force_override / ambiguous_location /
 *     malformed_tool_call); `action` is the form-decision action; `content_from`
 *     = "narrative.profile" pulls the form content from the profile table; an
 *     inline `content` table overrides.
 *   - [[steps.anchors]]    → the evaluator AnchorSpec list (snake_case keys mapped
 *     to the camelCase AnchorSpec fields).
 *
 * Dependency wall: harness layer. Imports zod + @autobroker/core (HarnessDriverKind
 * enum) — NEVER better-sqlite3/drizzle/playwright/@ai-sdk.
 */

import { readFileSync } from "node:fs";

import { HARNESS_DRIVER_KINDS, PROVIDERS, providerDriverKind, type HarnessDriverKind } from "@autobroker/core";
import { z } from "zod";

import type { AnchorSpec } from "./evaluator.js";
import { parseToml, type TomlTable } from "./toml.js";

// ---------------------------------------------------------------------------
// Zod schemas for the raw TOML shape (snake_case as authored)
// ---------------------------------------------------------------------------

const ProviderSchema = z.enum(["deepseek", "anthropic", "openai"]);
const InputModeSchema = z.enum(["slash", "freeform"]);

/** A single anchor block, snake_case as authored in TOML. The union is discriminated
 *  on `kind`; we keep it permissive at the Zod layer and refine into AnchorSpec. */
const RawAnchorSchema = z.object({
  kind: z.string(),
  expect: z.union([z.array(z.string()), z.string()]).optional(),
  table: z.string().optional(),
  scope: z.enum(["profile", "global"]).optional(),
  delta_min: z.number().optional(),
  min: z.number().optional(),
  exact: z.boolean().optional(),
  action: z.string().optional(),
  gate_before_prose: z.boolean().optional(),
  allow_fake_outbound: z.boolean().optional(),
});
type RawAnchor = z.infer<typeof RawAnchorSchema>;

// .passthrough() keeps inline typed-resume keys authored as siblings of the resume
// entry (e.g. reason for force_override, picked_index for pick, retry_query for
// retry) so the loader can fold them into the form-decision content.
const RawResumeSchema = z
  .object({
    on: z.string(),
    action: z.string(),
    content_from: z.string().optional(),
    content: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type RawResume = z.infer<typeof RawResumeSchema>;

/** The structural resume keys that are NOT part of the typed-resume content. */
const RESUME_STRUCTURAL_KEYS = new Set(["on", "action", "content_from", "content"]);

const RawStepSchema = z.object({
  id: z.string(),
  skill: z.string(),
  purpose: z.string().optional(),
  gate_policy: z.enum(["approve_safe", "deny_all"]).optional(),
  input_inline: z.record(z.string(), z.unknown()).optional(),
  resume: z.array(RawResumeSchema).optional(),
  anchors: z.array(RawAnchorSchema),
});

const RawCaseSchema = z.object({
  meta: z.object({
    id: z.string(),
    archetype: z.enum(["A", "B"]),
    skills: z.array(z.string()).min(1),
    risk_group: z.string().optional(),
  }),
  narrative: z.object({
    session_origin: z.enum(["fresh_unpinned", "reuse_pinned"]),
    input_mode: InputModeSchema,
    provider: ProviderSchema,
    profile: z.record(z.string(), z.unknown()).optional(),
  }),
  steps: z.array(RawStepSchema).min(1),
});

// ---------------------------------------------------------------------------
// the parsed/typed Case the runner + evaluator consume
// ---------------------------------------------------------------------------

export interface CaseResume {
  on: string;
  action: "accept" | "decline" | "cancel";
  /** The form-decision content (resolved from content_from/profile or inline). */
  content: Record<string, unknown> | null;
}

export interface CaseStep {
  id: string;
  skill: string;
  purpose: string | null;
  gatePolicy: "approve_safe" | "deny_all";
  inputInline: Record<string, unknown> | null;
  resume: CaseResume[];
  anchors: AnchorSpec[];
}

export interface Case {
  id: string;
  archetype: "A" | "B";
  skills: string[];
  riskGroup: string | null;
  sessionOrigin: "fresh_unpinned" | "reuse_pinned";
  inputMode: "slash" | "freeform";
  provider: "deepseek" | "anthropic" | "openai";
  profile: Record<string, unknown> | null;
  steps: CaseStep[];
}

/** Map provider → the driver_kind label asserted by the driver_kind anchor (the
 *  two-place lock-step value). Derived from core's providerDriverKind so the
 *  runner's expectDriverKind, this case→expect map, and the server's init-frame
 *  emitter all key off ONE source. DeepSeek = deepseek_apikey (default);
 *  anthropic_apikey / openai_apikey are the cross-provider labels. */
export const PROVIDER_DRIVER_KIND: Record<string, HarnessDriverKind> = Object.fromEntries(
  PROVIDERS.map((p) => [p, providerDriverKind(p)]),
);

/** Refine one raw anchor block into the evaluator AnchorSpec union (fail LOUD on a
 *  malformed/unknown anchor — a typo in a case must never silently skip a check). */
function toAnchorSpec(raw: RawAnchor, provider: string): AnchorSpec {
  switch (raw.kind) {
    case "run_status": {
      const expect = Array.isArray(raw.expect) ? raw.expect : raw.expect !== undefined ? [raw.expect] : undefined;
      if (expect === undefined) throw new Error("run_status anchor requires expect[]");
      return { kind: "run_status", expect };
    }
    case "driver_kind": {
      // expect may be authored explicitly, else derived from the case provider.
      const explicit = typeof raw.expect === "string" ? raw.expect : undefined;
      const derived = PROVIDER_DRIVER_KIND[provider];
      const expect = (explicit ?? derived) as HarnessDriverKind | undefined;
      if (expect === undefined) {
        throw new Error(`driver_kind anchor: no expect and no driver_kind for provider "${provider}" (M4 label pending)`);
      }
      if (!(HARNESS_DRIVER_KINDS as readonly string[]).includes(expect)) {
        throw new Error(`driver_kind anchor: "${expect}" is not a known HARNESS_DRIVER_KINDS label`);
      }
      return { kind: "driver_kind", expect };
    }
    case "browser_activity":
      return { kind: "browser_activity" };
    case "approval_gate":
      return { kind: "approval_gate", ...(raw.gate_before_prose !== undefined ? { gateBeforeProse: raw.gate_before_prose } : {}) };
    case "table_min_rows": {
      if (raw.table === undefined) throw new Error("table_min_rows anchor requires table");
      const scope = raw.scope ?? "profile";
      return {
        kind: "table_min_rows",
        table: raw.table,
        scope,
        ...(raw.delta_min !== undefined ? { deltaMin: raw.delta_min } : {}),
        ...(raw.min !== undefined ? { min: raw.min } : {}),
        ...(raw.exact !== undefined ? { exact: raw.exact } : {}),
        ...(raw.action !== undefined ? { action: raw.action } : {}),
      };
    }
    case "no_external_mutation":
      return { kind: "no_external_mutation", ...(raw.allow_fake_outbound !== undefined ? { allowFakeOutbound: raw.allow_fake_outbound } : {}) };
    case "cost_and_time":
      return { kind: "cost_and_time" };
    case "malformed_tool_call": {
      const expect = raw.expect;
      if (expect !== "absent" && expect !== "fail_closed") {
        throw new Error('malformed_tool_call anchor requires expect = "absent" | "fail_closed"');
      }
      return { kind: "malformed_tool_call", expect };
    }
    default:
      throw new Error(`unknown anchor kind "${raw.kind}" in case (typo? unsupported anchor?)`);
  }
}

/** Resolve a resume entry's content from content_from / inline content. */
function resolveResumeContent(raw: RawResume, profile: Record<string, unknown> | null): Record<string, unknown> | null {
  if (raw.action === "decline" || raw.action === "cancel") return null;
  if (raw.content !== undefined) return raw.content;
  if (raw.content_from === "narrative.profile") {
    if (profile === null) throw new Error(`resume content_from=narrative.profile but [narrative.profile] is missing`);
    return profile;
  }
  // accept with no content (e.g. force_override carries content inline, location pick).
  return raw.content ?? null;
}

/** Coerce the raw form-decision action vocabulary. The case authors the OUTER
 *  form-decision action (accept|decline|cancel). */
function coerceAction(action: string): "accept" | "decline" | "cancel" {
  if (action === "accept" || action === "decline" || action === "cancel") return action;
  // Some cases author the inner typed action (force_override/pick/retry) directly on
  // the resume entry for readability; treat any non-decline/cancel as an accept whose
  // content carries the typed action. This keeps the TOML terse.
  return "accept";
}

/** Validate + refine a parsed TOML table into a typed Case. */
export function toCase(raw: TomlTable): Case {
  const parsed = RawCaseSchema.parse(raw);
  const profile = parsed.narrative.profile ?? null;

  const steps: CaseStep[] = parsed.steps.map((s) => ({
    id: s.id,
    skill: s.skill,
    purpose: s.purpose ?? null,
    gatePolicy: s.gate_policy ?? "approve_safe",
    inputInline: s.input_inline ?? null,
    resume: (s.resume ?? []).map((r) => {
      const action = coerceAction(r.action);
      // When the case authored an inner typed action on the resume entry (e.g.
      // action="force_override" with a sibling reason="…"), fold the inner action +
      // its sibling keys into content so the form-decision body is
      // {action:"accept", content:{action:"force_override", reason:"…"}}.
      let content = resolveResumeContent(r, profile);
      if (action === "accept" && r.action !== "accept") {
        const inlineKeys: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) {
          if (!RESUME_STRUCTURAL_KEYS.has(k)) inlineKeys[k] = v;
        }
        content = { action: r.action, ...inlineKeys, ...(r.content ?? {}) };
      }
      return { on: r.on, action, content };
    }),
    anchors: s.anchors.map((a) => toAnchorSpec(a, parsed.narrative.provider)),
  }));

  return {
    id: parsed.meta.id,
    archetype: parsed.meta.archetype,
    skills: parsed.meta.skills,
    riskGroup: parsed.meta.risk_group ?? null,
    sessionOrigin: parsed.narrative.session_origin,
    inputMode: parsed.narrative.input_mode,
    provider: parsed.narrative.provider,
    profile,
    steps,
  };
}

/** Parse a case TOML string into a typed Case. */
export function parseCase(source: string): Case {
  return toCase(parseToml(source));
}

/** Load a case TOML file from disk into a typed Case. */
export function loadCase(path: string): Case {
  return parseCase(readFileSync(path, "utf8"));
}

/** Build the cell_id: live/{skill}/{provider}/{archetype}/{input_mode}. */
export function cellIdFor(c: Case, step: CaseStep): string {
  return `live/${step.skill}/${c.provider}/${c.archetype}/${c.inputMode}`;
}
