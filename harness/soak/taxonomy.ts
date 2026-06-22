/**
 * taxonomy — the scenario-taxonomy loader + the FROZEN ScenarioClass type.
 *
 * The soak's randomness is layered: the SCENARIO (the edge class) is
 * DETERMINISTIC + version-controlled here; only the PHRASING is agentic (the
 * claude buyer/dealer generate the freeform text). This loader reads
 * harness/soak/scenarios/*.toml into a typed ScenarioClass[] so coverage is
 * ENUMERABLE + MEASURED — a per-skill soak plan ADDS its own scenarios/<skill>.toml
 * (additive, low-conflict); the loader's type is the shared cross-skill contract
 * (FROZEN in plan-0 — a type change is an architecture change, not a casual edit).
 *
 * Zod-validated + fail-LOUD on unknown fields (mirrors cases.ts) — a typo in a
 * scenario file must never silently drop a class from the measured coverage.
 *
 * The deterministic-assertion + judge-dim id spaces are OPEN strings (per-skill
 * plans add their own ids without editing this loader or verdict.ts); only the
 * structural shape is fail-LOUD (.strict() unknown-field + min-1 assertions).
 *
 * Dependency wall: harness layer. Imports zod + the harness toml parser — never a
 * framework.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { parseToml, type TomlTable } from "../toml.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The plan-0 base + per-skill scenario files live here. */
export const SCENARIOS_DIR = join(HERE, "scenarios");

// ---------------------------------------------------------------------------
// the gate verbs a scenario expects the orchestrator to drive (the HITL buttons)
// ---------------------------------------------------------------------------

/** The gate-button verbs the orchestrator owns (mirrors the uiDriver verbs the
 *  spec cites). A scenario names the gate verbs its drive needs so the
 *  orchestrator's HITL is enumerable + the coverage measurable. NEVER a chat-text
 *  answer to a gate. */
export const GATE_VERBS = [
  "approval_approve",
  "approval_deny",
  "batch_select_all",
  "batch_submit",
  "batch_decline",
  "inbox_select_all",
  "inbox_submit",
  "inbox_decline",
  "hygiene_select_all",
  "hygiene_submit",
  "hygiene_decline",
  "reset_confirm",
  "reset_cancel",
  "profile_stop_pick",
  "profile_stop_intake_cta",
] as const;
export type GateVerb = (typeof GATE_VERBS)[number];

// ---------------------------------------------------------------------------
// Zod schema for the raw TOML shape (snake_case as authored)
// ---------------------------------------------------------------------------

const ModelSchema = z.enum(["sonnet", "opus"]);

/** The optional per-scenario buyer persona (P1–P6 reverse-ported into the soak as
 *  DATA, not a code branch). "default" = the unflavored buyer brief. */
export const BuyerPersonaSchema = z.enum([
  "default",
  "busy_skimmer",
  "skeptical_haggler",
  "anxious_first_timer",
  "spec_obsessed",
  "payment_focused",
  "polite_rambler",
]);
export type BuyerPersona = z.infer<typeof BuyerPersonaSchema>;

/** One natural-language directive line per persona, appended to the buyer task in
 *  ALL three builders (intake / journey / generic). "default" injects nothing (the
 *  builder text is unchanged) so existing scenarios behave exactly as before. */
export function personaDirective(persona: BuyerPersona): string {
  switch (persona) {
    case "default":
      return "";
    case "busy_skimmer":
      return "Persona: a busy skimmer — terse, drip out only what each step needs, never a clean full spec up front.";
    case "skeptical_haggler":
      return "Persona: a skeptical haggler — push back on numbers, ask for the out-the-door breakdown, distrust the first quote.";
    case "anxious_first_timer":
      return "Persona: an anxious first-timer — hedging, seeking reassurance, may stall or give up; stay in character.";
    case "spec_obsessed":
      return "Persona: spec-obsessed — fixate on trim/options/VIN detail; never invent a spec you were not given.";
    case "payment_focused":
      return "Persona: payment-focused — frame everything as $/month; never restate it as a budget ceiling.";
    case "polite_rambler":
      return "Persona: a polite rambler — chatty, off-topic asides, but the actual ask stays one vehicle.";
  }
}

/** One raw scenario entry. .strict() fails LOUD on an unknown field (a typo'd
 *  key must surface at load, never silently ignored). */
const RawScenarioSchema = z
  .object({
    id: z.string().min(1),
    /** The product surface / skill the class stresses (e.g. "search_profile_intake",
     *  "dealer_geosearch", "dealer_reply_extract") — "intake" for the cold-start. */
    surface: z.string().min(1),
    /** The edge class name (the taxonomy row — cold_start_phrasing, gate_decline_path…). */
    class_name: z.string().min(1),
    /** A one-line human description of what the class stresses. */
    stresses: z.string().min(1),
    /** The buyer role's subscription model for this scenario. */
    buyer_model: ModelSchema.default("opus"),
    /** The optional buyer persona this scenario flavors the buyer turn with
     *  (.default keeps every existing toml parsing under .strict()). */
    buyer_persona: BuyerPersonaSchema.default("default"),
    /** Whether this scenario spawns the Sonnet dealer (multi-round email). */
    dealer_needed: z.boolean().default(false),
    /** The deterministic-assertion ids this scenario MUST satisfy (tied to real
     *  dbReads tables/fields). At least one — a scenario with zero deterministic
     *  anchors would score a vacuous pass. */
    deterministic_assertions: z.array(z.string().min(1)).min(1),
    /** The soft LLM-judge dims this scenario activates (may be empty — a pure
     *  safety scenario need not invoke the judge). */
    judge_dims: z.array(z.string().min(1)).default([]),
    /** The gate-button verbs the orchestrator drives for this scenario (HITL via
     *  buttons, never chat). May be empty (a read-only/no-gate scenario). */
    gate_verbs: z.array(z.enum(GATE_VERBS)).default([]),
  })
  .strict();

const RawTaxonomySchema = z.object({
  scenarios: z.array(RawScenarioSchema).min(1),
});

// ---------------------------------------------------------------------------
// the parsed/typed ScenarioClass the soak orchestrator + verdict consume (FROZEN)
// ---------------------------------------------------------------------------

export interface ScenarioClass {
  id: string;
  surface: string;
  className: string;
  stresses: string;
  buyerModel: "sonnet" | "opus";
  buyerPersona: BuyerPersona;
  dealerNeeded: boolean;
  deterministicAssertions: string[];
  judgeDims: string[];
  gateVerbs: GateVerb[];
}

/** Parse one taxonomy TOML string into typed ScenarioClass[] (fail LOUD). */
export function parseTaxonomy(source: string): ScenarioClass[] {
  const raw = RawTaxonomySchema.parse(parseToml(source) as TomlTable);
  return raw.scenarios.map((s) => ({
    id: s.id,
    surface: s.surface,
    className: s.class_name,
    stresses: s.stresses,
    buyerModel: s.buyer_model,
    buyerPersona: s.buyer_persona,
    dealerNeeded: s.dealer_needed,
    deterministicAssertions: s.deterministic_assertions,
    judgeDims: s.judge_dims,
    gateVerbs: s.gate_verbs,
  }));
}

/** Load every scenarios/*.toml file and merge into one ScenarioClass[]. Duplicate
 *  scenario ids across files fail LOUD (the id is the run/replay key). */
export function loadTaxonomy(dir: string = SCENARIOS_DIR): ScenarioClass[] {
  if (!existsSync(dir)) {
    throw new Error(`loadTaxonomy: scenarios dir not found: ${dir}`);
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".toml"))
    .sort();
  if (files.length === 0) {
    throw new Error(`loadTaxonomy: no *.toml scenario files in ${dir}`);
  }
  const all: ScenarioClass[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const scenarios = parseTaxonomy(readFileSync(join(dir, file), "utf8"));
    for (const s of scenarios) {
      if (seen.has(s.id)) {
        throw new Error(`loadTaxonomy: duplicate scenario id "${s.id}" (in ${file})`);
      }
      seen.add(s.id);
      all.push(s);
    }
  }
  return all;
}

/** Resolve ONE scenario by id from the loaded taxonomy (fail LOUD on miss). */
export function findScenario(scenarios: readonly ScenarioClass[], id: string): ScenarioClass {
  const found = scenarios.find((s) => s.id === id);
  if (found === undefined) {
    throw new Error(
      `findScenario: no scenario "${id}" (known: ${scenarios.map((s) => s.id).join(", ")})`,
    );
  }
  return found;
}

/** Filter the loaded taxonomy by className (the `soak suite --class <name>` path). */
export function scenariosInClass(
  scenarios: readonly ScenarioClass[],
  className: string,
): ScenarioClass[] {
  return scenarios.filter((s) => s.className === className);
}
