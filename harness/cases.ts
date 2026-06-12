/**
 * cases — load + Zod-validate a case TOML into a typed Case.
 * Three binding layers: [meta] (id / archetype / ordered skills[]), [narrative]
 * (session_origin / input_mode / provider / profile), [[steps]] (each with
 * resume[] scripts + an anchors[] tripwire array). The anchor specs are parsed
 * into the evaluator's AnchorSpec union so a case is fully declarative.
 * An optional [[seed.dealer_inventory_sources]] section declares pending
 * inventory-link rows the UI-lane runner writes into the ISOLATED case DB
 * right before the case's first inventory_link_scan step (dealer resolved by
 * name against the scoped profile's bound dealers; fail-loud on no/ambiguous
 * match).
 *
 * The case grammar maps onto the committed wire contract:
 *   - [narrative.profile]  → the form content the collect-step resume submits.
 *   - [[steps.resume]]     → an ordered suspend-answer script. Each entry's `on`
 *     names the suspend kind (data_collection / force_override / ambiguous_location /
 *     malformed_tool_call / batch_review); `action` is the form-decision action;
 *     `content_from` = "narrative.profile" pulls the form content from the
 *     profile table ("suspend.targets" resolves at DRIVE time — approve all ids
 *     off the live suspend payload); an inline `content` table overrides.
 *     batch_review entries may carry [[steps.resume.rows]] (per-row decisions
 *     matched by dealer NAME) + `default_decision` for unmatched rows.
 *   - [[steps.anchors]]    → the evaluator AnchorSpec list (snake_case keys mapped
 *     to the camelCase AnchorSpec fields).
 *   - per-step `max_seconds` → the wall-clock budget when the CLI --max-seconds
 *     is absent (CLI overrides); `pin_label` → the UI-lane explicit Pin verb
 *     after the step; `batch_rows_from` → the cross-step batch-card row-count
 *     check against an earlier step's profile_dealers delta.
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
  /** cost_and_time only: the step's happy path is ZERO-LLM by design, so an
   *  empty ledger is a valid recorded outcome (not RED). */
  optional: z.boolean().optional(),
});
type RawAnchor = z.infer<typeof RawAnchorSchema>;

/** A batch_review row decision script entry: `match` is the dealer NAME shown
 *  on the suspend card (resolved to a dealer_id against the suspend payload's
 *  targets at drive time — zero or ambiguous matches fail LOUD, never by
 *  index); `decision` is the per-row verb the driver clicks. */
const RawBatchRowSchema = z.object({
  match: z.string().min(1),
  decision: z.enum(["approve", "skip"]),
});

// .passthrough() keeps inline typed-resume keys authored as siblings of the resume
// entry (e.g. reason for force_override, picked_index for pick, retry_query for
// retry) so the loader can fold them into the form-decision content.
const RawResumeSchema = z
  .object({
    on: z.string(),
    action: z.string(),
    content_from: z.string().optional(),
    content: z.record(z.string(), z.unknown()).optional(),
    /** batch_review only: the row-level decision script + the decision applied
     *  to rows no script entry matched. rows=[] + default_decision="approve"
     *  drives the card's explicit Select-all button (the user affordance). */
    rows: z.array(RawBatchRowSchema).optional(),
    default_decision: z.enum(["approve", "skip"]).optional(),
  })
  .passthrough();
export type RawResume = z.infer<typeof RawResumeSchema>;

/** The structural resume keys that are NOT part of the typed-resume content. */
const RESUME_STRUCTURAL_KEYS = new Set([
  "on",
  "action",
  "content_from",
  "content",
  "rows",
  "default_decision",
]);

/** The content_from sources a resume entry may name. "narrative.profile"
 *  resolves at PARSE time (the case's profile table); "suspend.targets"
 *  resolves at DRIVE time — the runner approves ALL dealer ids off the live
 *  suspend payload (the API-lane / scripted equivalent of Select-all). */
const CONTENT_FROM_SOURCES = new Set(["narrative.profile", "suspend.targets"]);

/** How the UI lane starts a step: chat-rail slash text, chat-rail freeform
 *  prose, the Skills popover Run button, or a click on the PREVIOUS step's
 *  STOP-card profile picker (stop_picker — a NEW run, never a resume; the
 *  pick-by-vehicle-label key rides input_inline.pick_label). Defaults from
 *  narrative.input_mode. */
const LaunchSchema = z.enum(["chat_slash", "chat_freeform", "skills_popover", "stop_picker"]);

/** The typed profile-resolution STOP codes a step may expect (mirrors the
 *  workflow's GeosearchStopCode wire values). */
const ExpectStopSchema = z.enum([
  "no_active_profile",
  "multiple_active_profiles",
  "profile_missing_fields",
]);

/** The UI-lane edge behaviors (rotation-pool corner cases, 1–2 per skill —
 *  these cases stay OUT of the regression corpus):
 *    reload_mid_form     — fill part of the form, reload the page, assert the
 *                          draft restored (resume banner + values), complete.
 *    double_click_submit — double-click the intake submit; the button must
 *                          disable after the first click and exactly ONE
 *                          profile row may land (pair with a global-exact
 *                          table_min_rows anchor).
 *    sse_break           — knock the TEST browser offline mid-run for ~2s
 *                          (breaks the live SSE), assert recovery reaches the
 *                          terminal with no duplicated rendering. */
const EdgeSchema = z.enum(["reload_mid_form", "double_click_submit", "sse_break"]);

const RawStepSchema = z.object({
  id: z.string(),
  skill: z.string(),
  purpose: z.string().optional(),
  gate_policy: z.enum(["approve_safe", "deny_all"]).optional(),
  launch: LaunchSchema.optional(),
  /** Scope this step's before/after DB snapshots to the profile CREATED BY the
   *  named earlier step (multi-intake journeys; the single carried slot cannot
   *  distinguish two intakes). */
  profile_scope_from: z.string().optional(),
  /** This step terminates in a typed STOP: the runner asserts the STOP card
   *  (and, for the intake-pointing codes, drives the CTA) after terminal. */
  expect_stop: ExpectStopSchema.optional(),
  /** UI-lane edge behavior the runner applies while driving this step
   *  (rotation-pool corner case; unknown values fail loud at parse). */
  edge: EdgeSchema.optional(),
  /** PER-STEP wall-clock budget (seconds). Used when the CLI --max-seconds
   *  flag is ABSENT; the CLI always overrides. Long browser+LLM steps
   *  (inventory_site_scan) author 1800 here so a corpus run without flags
   *  does not abort them at the 900s default. */
  max_seconds: z.number().int().positive().optional(),
  /** UI lane only: after this step's terminal + checks, pin the profile whose
   *  vehicle label equals this string via the Searches popover's Pin verb (the
   *  REAL DOM — the explicit pin action; sessions are never auto-pinned). */
  pin_label: z.string().optional(),
  /** Cross-step ui_check (batch_review steps): the rendered batch card's
   *  target-row count must equal the named EARLIER step's profile-scoped
   *  profile_dealers delta (the geosearch discovery feeding the batch). */
  batch_rows_from: z.string().optional(),
  input_inline: z.record(z.string(), z.unknown()).optional(),
  resume: z.array(RawResumeSchema).optional(),
  anchors: z.array(RawAnchorSchema),
});

/** One `[[seed.dealer_inventory_sources]]` entry: a pending inventory-link
 *  row the runner writes into the ISOLATED case DB right before the case's
 *  first inventory_link_scan step (the dev-period source bootstrap —
 *  dealer_reply_extract writes the same rows in production later). `dealer`
 *  is a dealer NAME (exact, else unique case-insensitive substring) resolved
 *  against the scoped profile's bound dealers at apply time — zero/ambiguous
 *  matches fail LOUD. `status` may only be authored as "pending" (the seeder
 *  writes nothing else). */
const RawSeedSourceSchema = z.object({
  dealer: z.string().min(1),
  url: z.string().min(1),
  source_type: z.string().min(1).optional(),
  status: z.literal("pending").optional(),
});

const RawSeedSchema = z.object({
  dealer_inventory_sources: z.array(RawSeedSourceSchema).min(1),
});

const RawCaseSchema = z.object({
  meta: z.object({
    id: z.string(),
    archetype: z.enum(["A", "B"]),
    skills: z.array(z.string()).min(1),
    risk_group: z.string().optional(),
  }),
  seed: RawSeedSchema.optional(),
  narrative: z.object({
    session_origin: z.enum(["fresh_unpinned", "reuse_pinned"]),
    input_mode: InputModeSchema,
    provider: ProviderSchema,
    /** Which user-action driver runs the case: "ui" = real dashboard DOM via
     *  Playwright; "api" (default) = direct HTTP. The runner --lane overrides. */
    lane: z.enum(["ui", "api"]).optional(),
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
  /** A DRIVE-TIME content source ("suspend.targets" — approve all ids off the
   *  live suspend payload), or null when content resolved at parse time. */
  contentFrom: string | null;
  /** batch_review row script (name-matched per-row decisions), or null. */
  rows: Array<{ match: string; decision: "approve" | "skip" }> | null;
  /** The decision applied to batch rows no script entry matched, or null. */
  defaultDecision: "approve" | "skip" | null;
}

/** The UI-lane launch surface for a step. */
export type StepLaunch = "chat_slash" | "chat_freeform" | "skills_popover" | "stop_picker";

/** A typed profile-resolution STOP code (run terminates error + STOP card). */
export type ExpectStop = z.infer<typeof ExpectStopSchema>;

/** A UI-lane edge behavior (rotation-pool corner case). */
export type StepEdge = z.infer<typeof EdgeSchema>;

export interface CaseStep {
  id: string;
  skill: string;
  purpose: string | null;
  gatePolicy: "approve_safe" | "deny_all";
  /** UI-lane start surface (explicit, or derived from narrative.input_mode). */
  launch: StepLaunch;
  /** Snapshot scope = the profile created by THIS earlier step id, or null
   *  (default: the most recently created profile, the single-journey shape). */
  profileScopeFrom: string | null;
  /** The typed STOP this step must terminate in, or null (normal terminal). */
  expectStop: ExpectStop | null;
  /** The UI-lane edge behavior applied while driving this step, or null. */
  edge: StepEdge | null;
  /** Per-step budget (seconds) when the CLI --max-seconds is absent, or null
   *  (the runner's 900s default). CLI overrides. */
  maxSeconds: number | null;
  /** UI lane: pin this vehicle label via the Searches popover AFTER the step's
   *  terminal + checks (the explicit Pin verb), or null. */
  pinLabel: string | null;
  /** Cross-step ui_check: batch card row count == this earlier step's
   *  profile_dealers delta, or null (no cross-check). */
  batchRowsFrom: string | null;
  inputInline: Record<string, unknown> | null;
  resume: CaseResume[];
  anchors: AnchorSpec[];
}

/** One parsed dealer_inventory_sources seed row (see RawSeedSourceSchema). */
export interface CaseSeedSource {
  dealer: string;
  url: string;
  sourceType: string;
}

export interface Case {
  id: string;
  archetype: "A" | "B";
  skills: string[];
  riskGroup: string | null;
  sessionOrigin: "fresh_unpinned" | "reuse_pinned";
  inputMode: "slash" | "freeform";
  provider: "deepseek" | "anthropic" | "openai";
  /** The case-declared driver lane (runner --lane overrides; default "api"). */
  lane: "ui" | "api";
  profile: Record<string, unknown> | null;
  /** Pre-step DB seeds (isolated case DB only), or null. UI-lane only —
   *  applied right before the first inventory_link_scan step. */
  seed: { dealerInventorySources: CaseSeedSource[] } | null;
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
    case "browser_activity": {
      // Default: browser frames must be PRESENT. expect="absent" asserts the
      // inverse (e.g. a batch decline must trigger ZERO navigation).
      const expect = raw.expect;
      if (expect === undefined) return { kind: "browser_activity" };
      if (expect !== "present" && expect !== "absent") {
        throw new Error('browser_activity anchor: expect must be "present" | "absent" when given');
      }
      return { kind: "browser_activity", expect };
    }
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
      // optional=true declares a step whose happy path is ZERO-LLM by design:
      // an empty ledger then scores as the valid "no model call" outcome.
      return { kind: "cost_and_time", ...(raw.optional !== undefined ? { optional: raw.optional } : {}) };
    case "malformed_tool_call": {
      const expect = raw.expect;
      if (expect !== "absent" && expect !== "fail_closed") {
        throw new Error('malformed_tool_call anchor requires expect = "absent" | "fail_closed"');
      }
      return { kind: "malformed_tool_call", expect };
    }
    case "resolution": {
      const expect = raw.expect;
      if (expect !== "pinned" && expect !== "inferred_newest") {
        throw new Error('resolution anchor requires expect = "pinned" | "inferred_newest"');
      }
      return { kind: "resolution", expect };
    }
    default:
      throw new Error(`unknown anchor kind "${raw.kind}" in case (typo? unsupported anchor?)`);
  }
}

/** Resolve a resume entry's content from content_from / inline content. The
 *  "suspend.targets" source resolves at DRIVE time (runner), so the content
 *  stays null here and the contentFrom marker rides the CaseResume. */
function resolveResumeContent(raw: RawResume, profile: Record<string, unknown> | null): Record<string, unknown> | null {
  if (raw.action === "decline" || raw.action === "cancel") return null;
  if (raw.content_from !== undefined && !CONTENT_FROM_SOURCES.has(raw.content_from)) {
    throw new Error(
      `unknown content_from "${raw.content_from}" (expected one of: ${[...CONTENT_FROM_SOURCES].join(", ")})`,
    );
  }
  if (raw.content !== undefined) return raw.content;
  if (raw.content_from === "narrative.profile") {
    if (profile === null) throw new Error(`resume content_from=narrative.profile but [narrative.profile] is missing`);
    return profile;
  }
  // accept with no content (e.g. force_override carries content inline, location
  // pick, or a drive-time content_from source).
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
    launch: s.launch ?? (parsed.narrative.input_mode === "freeform" ? "chat_freeform" : "chat_slash"),
    profileScopeFrom: s.profile_scope_from ?? null,
    expectStop: s.expect_stop ?? null,
    edge: s.edge ?? null,
    maxSeconds: s.max_seconds ?? null,
    pinLabel: s.pin_label ?? null,
    batchRowsFrom: s.batch_rows_from ?? null,
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
      return {
        on: r.on,
        action,
        content,
        contentFrom: r.content_from === "suspend.targets" ? r.content_from : null,
        rows: r.rows ?? null,
        defaultDecision: r.default_decision ?? null,
      };
    }),
    anchors: s.anchors.map((a) => toAnchorSpec(a, parsed.narrative.provider)),
  }));

  // Cross-step validation (fail LOUD at parse, never silently mid-journey):
  // a stop_picker launch needs its pick-by-vehicle-label key, and a
  // profile_scope_from must name an EARLIER step in the same case.
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.launch === "stop_picker") {
      const label = step.inputInline?.["pick_label"];
      if (typeof label !== "string" || label.trim() === "") {
        throw new Error(
          `step "${step.id}" launches stop_picker but has no input_inline.pick_label (the pick-by-vehicle-label key)`,
        );
      }
    }
    if (step.profileScopeFrom !== null && !seen.has(step.profileScopeFrom)) {
      throw new Error(
        `step "${step.id}" profile_scope_from="${step.profileScopeFrom}" does not name an earlier step`,
      );
    }
    if (step.batchRowsFrom !== null && !seen.has(step.batchRowsFrom)) {
      throw new Error(
        `step "${step.id}" batch_rows_from="${step.batchRowsFrom}" does not name an earlier step`,
      );
    }
    if (seen.has(step.id)) {
      // Evidence dirs are keyed <cell_id>__<stepId>; a duplicate id would
      // silently overwrite the earlier step's evidence.
      throw new Error(`duplicate step id "${step.id}" in case (evidence dirs would collide)`);
    }
    seen.add(step.id);
  }

  return {
    id: parsed.meta.id,
    archetype: parsed.meta.archetype,
    skills: parsed.meta.skills,
    riskGroup: parsed.meta.risk_group ?? null,
    sessionOrigin: parsed.narrative.session_origin,
    inputMode: parsed.narrative.input_mode,
    provider: parsed.narrative.provider,
    lane: parsed.narrative.lane ?? "api",
    profile,
    seed:
      parsed.seed === undefined
        ? null
        : {
            dealerInventorySources: parsed.seed.dealer_inventory_sources.map((s) => ({
              dealer: s.dealer,
              url: s.url,
              sourceType: s.source_type ?? "manual",
            })),
          },
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
