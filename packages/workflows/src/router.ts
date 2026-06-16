/**
 * router — the NL skill-router (the core product feature, Layer 3).
 *
 * An LLM reads each free-form chat message and routes it to ONE of the 17
 * skills / `intake` / `clarify`. This is what real users do (they don't type
 * `/slash`), so the classifier is the centerpiece of the freeform chat rail: the
 * app layer feeds it a sentence + the session's pinned profile, and it returns a
 * typed RouteDecision the route handler launches through the EXACT existing
 * launch path. Every gate (the L2 in-process fail-closed gate, profile-ASK
 * pin_required/0/1/2, batch/typed-YES, the 3 irreversible fake-sends, hygiene,
 * pipeline_reset) stays DOWNSTREAM of skillRuns.start, unchanged, button-only.
 *
 * SAFETY (load-bearing — do not weaken):
 *   - The router only CHOOSES + LAUNCHES. It NEVER executes a side effect and
 *     NEVER pre-approves anything; the skill's own gates are the floor.
 *   - #1244 fail-closed: one `emit_result` tool + Zod via
 *     `harness.generate(hitlAvailable:false)`. A malformed/tool-skip output
 *     throws MalformedToolCallAbort → mapped to `clarify`. We NEVER regex a skill
 *     name out of content; we never mix structured-output + tools.
 *   - Fail-closed routing: skill="none" → clarify; confidence < 0.6 → clarify; a
 *     DESTRUCTIVE/IRREVERSIBLE skill under confidence 0.85 → clarify (extra
 *     caution on the dangerous routes — never guess a destructive launch).
 *   - No profile inference: the router reads `pinnedProfileId` only; the skill's
 *     own resolveScope (profile-ASK invariant) is load-bearing.
 *
 * Dependency wall: imports @autobroker/{core,model,skills} + the local harness
 * ONLY — never @mastra directly, never the product DB, never HTTP. The model
 * call lives behind `harness.generate`; the app layer orchestrates the launch.
 */

import { z } from "zod";

import {
  MalformedToolCallAbort,
  type HarnessSuspend,
} from "@autobroker/model";
import { SKILLS, type SkillDef } from "@autobroker/skills";

import { harness, type HarnessLedgerContext } from "./harness.js";
import type { HarnessTestOverrides } from "./harness.js";

/** The sentinel the model emits when no skill fits — maps to `clarify`. */
const NONE = "none" as const;
/** The intake skill id (skill that CREATES a profile — the freeform default). */
const INTAKE = "search_profile_intake" as const;

/**
 * The destructive / irreversible skills the router will only LAUNCH at high
 * confidence (≥ 0.85). The launch still only brings the user to that skill's own
 * typed-YES / approval / batch gate — the router never pre-approves. DERIVED from
 * the registry riskClass {destructive, irreversible} so a newly-added dangerous
 * skill automatically inherits the high-confidence bar (no hardcoded drift).
 */
const DESTRUCTIVE_SKILLS: ReadonlySet<string> = new Set<string>(
  SKILLS.filter((s) => s.riskClass === "destructive" || s.riskClass === "irreversible").map((s) => s.id),
);

/** The confidence floor below which ANY route degrades to clarify. */
const MIN_CONFIDENCE = 0.6;
/** The higher floor a destructive/irreversible route must clear to launch. */
const DESTRUCTIVE_CONFIDENCE = 0.85;

/** The real skill ids the model is allowed to choose from (the 17 registry ids). */
const SKILL_IDS: readonly string[] = SKILLS.map((s) => s.id);

/**
 * The flat, strict emit contract for the single classify call. All-required,
 * an enum of {the 17 real skill ids, "intake", "none"}, a [0,1] confidence, a
 * short reason, and an optional flat string params map (extracted slash-equivalent
 * args; mostly empty). "intake" is an explicit alias for the create-a-profile
 * skill so the model can pick it by intent without knowing the id; "none" => the
 * fail-closed `clarify`. Kept flat + enum + lowest-common JSON-Schema subset per
 * the #1244 structured-output discipline.
 */
const ROUTE_CHOICES = [...SKILL_IDS, "intake", NONE] as unknown as [string, ...string[]];
export const ChatRouteEmitSchema = z
  .object({
    skill: z.enum(ROUTE_CHOICES),
    confidence: z.number().min(0).max(1),
    reason: z.string(),
    params: z.record(z.string(), z.string()).nullable(),
  })
  .strict();
export type ChatRouteEmit = z.infer<typeof ChatRouteEmitSchema>;

/** The context the route handler reads off the session and hands the classifier. */
export interface RouterContext {
  /** The session's pinned profile (read off thread metadata), or null. The
   *  router never INFERS a profile from this — it only forwards it so the model
   *  knows whether a search is in scope. */
  pinnedProfileId: string | null;
  /** The single test_run_records ledger row identity for this classify call. */
  ledger: HarnessLedgerContext;
}

/**
 * The classifier verdict. `launch` carries the chosen skill + the inputData the
 * server descriptor's buildInput expects (the per-skill mapper below); `clarify`
 * carries a reason + candidate hints and starts NO run.
 */
export type RouteDecision =
  | {
      kind: "launch";
      skillId: string;
      inputData: Record<string, unknown>;
      confidence: number;
      reason: string;
    }
  | {
      kind: "clarify";
      reason: string;
      candidates: { skillId: string; why: string }[];
    };

/** Build the {clarify} verdict with no candidates (the bare fail-closed shape). */
function clarify(reason: string, candidates: { skillId: string; why: string }[] = []): RouteDecision {
  return { kind: "clarify", reason, candidates };
}

/** Narrow a harness.generate result to the HarnessSuspend branch (defensive —
 *  hitlAvailable:false should THROW, not suspend, but a suspend-shaped return is
 *  treated identically: fail-closed → clarify). */
function isHarnessSuspend(r: unknown): r is HarnessSuspend {
  return typeof r === "object" && r !== null && "suspended" in r;
}

/**
 * The per-skill input mapper: turn the chosen skill id + the original NL into the
 * minimal valid inputData the skill's own descriptor.buildInput expects. The
 * guiding rule: emit the MINIMAL valid input and let the skill's own gates
 * (profile-ASK / scope resolve) do the rest — the router never resolves a profile.
 *
 *   - intake  → { input_mode:"freeform", freeform_text: nl } (the prose seed).
 *   - every other skill → {} (its descriptor resolves scope from the pin / the
 *     newest-active profile downstream; the router passes nothing it would have
 *     to infer).
 *
 * The model's `params` are DELIBERATELY NOT forwarded into inputData (a safety
 * choice: never feed un-validated model-extracted args into a skill's buildInput).
 * `params` stays a model scratch slot only. The route handler threads the pinned
 * profile as `search_profile_id` the same way the /slash launch does.
 */
function mapInput(skillId: string, nl: string): Record<string, unknown> {
  if (skillId === INTAKE) {
    return { input_mode: "freeform", freeform_text: nl };
  }
  return {};
}

/**
 * Resolve the model's enum choice to a real skill id, or null when it cannot
 * launch. "none" → null (clarify). "intake" → the real intake id. A real id is
 * passed through iff it is actually in the registry (defense-in-depth; the enum
 * already constrains it). NEVER guesses — an unrecognized value is null.
 */
function resolveSkillId(choice: string): string | null {
  if (choice === NONE) return null;
  if (choice === "intake") return INTAKE;
  return SKILL_IDS.includes(choice) ? choice : null;
}

/** The build-the-prompt helper: the skill catalog (id + one-line intent) + the
 *  pinned-profile context + the user's sentence + the strict emit contract. The
 *  catalog comes from the registry so it never drifts from the real skill set. */
export function buildRoutePrompt(nl: string, ctx: RouterContext): string {
  const catalog = SKILLS.map((s: SkillDef) => `- ${s.id}: ${s.summary}`).join("\n");
  const pin =
    ctx.pinnedProfileId !== null
      ? `A search profile is currently pinned (id ${ctx.pinnedProfileId}); skills that act on a search can use it.`
      : "No search profile is pinned.";
  return [
    "You are the dispatcher for a local car-buying assistant. The user typed a",
    "message in the chat. Choose the ONE skill that best fulfills their intent,",
    "or 'intake' to start a brand-new search profile, or 'none' if no skill fits",
    "or the message is too vague to route confidently.",
    "",
    "Skills:",
    catalog,
    "",
    "Special choices:",
    "- intake: the user wants to START a NEW car search (describe a car/budget/area).",
    "- none: the message is a question, a greeting, ambiguous, or fits no skill.",
    "",
    pin,
    "",
    "Rules:",
    "- Pick exactly ONE skill id (or intake / none).",
    "- confidence is your calibrated certainty in [0,1]; be conservative.",
    "- Never pick a destructive action (reset / hygiene / send a lead / send a",
    "  follow-up / close out a dealer) unless the user CLEARLY asked for it.",
    "- reason is a short human-readable justification.",
    "- params is a small flat map of any extracted arguments, or null.",
    "",
    `User message: ${JSON.stringify(nl)}`,
    "",
    "Call emit_result exactly once with your decision.",
  ].join("\n");
}

/**
 * Classify a free-form chat message into a launch / clarify decision.
 *
 * Calls `harness.generate({ useCase:"chat_route", schema: ChatRouteEmitSchema,
 * prompt, hitlAvailable:false }, ctx.ledger)` — a single emit_result + Zod,
 * #1244 fail-closed automatic. EVERY fail-closed branch degrades to `clarify`;
 * the router never guesses a launch.
 *
 * `_testOverrides` is the harness test-only seam (a deterministic fake model +
 * an isolated ledger DB) — refused outside a test runner by the harness itself.
 */
export async function classifySkillFromText(
  nl: string,
  ctx: RouterContext,
  _testOverrides?: HarnessTestOverrides,
): Promise<RouteDecision> {
  const prompt = buildRoutePrompt(nl, ctx);

  let emitted: ChatRouteEmit;
  try {
    const result = await harness.generate(
      {
        useCase: "chat_route",
        schema: ChatRouteEmitSchema,
        prompt,
        hitlAvailable: false,
      },
      ctx.ledger,
      _testOverrides,
    );
    // hitlAvailable:false never suspends (it throws), but a suspend-shaped
    // return is fail-closed identically → clarify.
    if (isHarnessSuspend(result)) {
      return clarify("I could not read that clearly enough to act on it. Could you rephrase?");
    }
    emitted = result.object;
  } catch (err) {
    // #1244 fail-closed (MalformedToolCallAbort) OR a Zod-authority rejection OR
    // a transport failure → clarify, NEVER a guessed launch. We never regex a
    // skill name out of content.
    if (err instanceof MalformedToolCallAbort) {
      return clarify("I could not read that clearly enough to act on it. Could you rephrase?");
    }
    if (err instanceof z.ZodError) {
      return clarify("I could not read that clearly enough to act on it. Could you rephrase?");
    }
    throw err;
  }

  // Fail-closed mapping → clarify (never a guessed launch).
  const skillId = resolveSkillId(emitted.skill);
  if (skillId === null) {
    // skill === "none" (or an unrecognized value) → clarify.
    return clarify(
      emitted.reason.length > 0
        ? emitted.reason
        : "I'm not sure which action you want. Could you say a bit more?",
    );
  }
  if (emitted.confidence < MIN_CONFIDENCE) {
    return clarify(
      "I'm not confident enough about that to act on it. Could you be more specific?",
      [{ skillId, why: emitted.reason }],
    );
  }
  if (DESTRUCTIVE_SKILLS.has(skillId) && emitted.confidence < DESTRUCTIVE_CONFIDENCE) {
    // Extra caution on the dangerous routes: never guess a destructive launch.
    return clarify(
      `That looks like a sensitive action (${skillId}). Please run it explicitly so you can confirm it.`,
      [{ skillId, why: emitted.reason }],
    );
  }

  return {
    kind: "launch",
    skillId,
    inputData: mapInput(skillId, nl),
    confidence: emitted.confidence,
    reason: emitted.reason,
  };
}
