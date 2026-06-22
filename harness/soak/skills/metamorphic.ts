/**
 * skills/metamorphic — the T4-U4 routing-invariance soak module (ADDITIVE; never
 * edits a shared file). The per-skill assertion id space is OPEN: routing_invariance
 * returns a verdict.ts DeterministicResult with its OWN assertionId + severity,
 * folded by combineSoakVerdict (it is NOT one of the FROZEN
 * DETERMINISTIC_ASSERTION_IDS a scenario toml declares — those carry only the floor).
 * The base NL phrasing + k perturbations must ALL route to the SAME skill_id (the
 * router is invariant under benign rephrasing).
 *
 * Dependency wall: harness layer. Imports only the verdict DeterministicResult type
 * + the ScenarioClass type — no framework, no provider, no playwright.
 */

import type { DeterministicResult } from "../verdict.js";

/** The metamorphic assertions this plan adds, with their FROZEN severity. A routing
 *  split is a correctness defect → RED (mirrors negotiationFollowup.ts's severity map). */
export const METAMORPHIC_ASSERTION_SEVERITY = {
  routing_invariance: "red",
} as const;
export type MetamorphicAssertionId = keyof typeof METAMORPHIC_ASSERTION_SEVERITY;

/** One routed NL turn: the prose typed + the skill the router chose (null = the
 *  router clarified / did not launch). */
export interface RoutedTurn {
  nlText: string;
  routedSkillId: string | null;
}

/**
 * ROUTING INVARIANCE (RED): the base phrasing + every perturbation must route to
 * the SAME expected skill_id. A perturbation that routes elsewhere (or clarifies)
 * is a leak of router brittleness. Pure over the recorded routed turns.
 */
export function assertRoutingInvariance(args: {
  expectedSkillId: string;
  routedTurns: readonly RoutedTurn[];
}): DeterministicResult {
  const divergent = args.routedTurns.filter((t) => t.routedSkillId !== args.expectedSkillId);
  const ok = args.routedTurns.length > 0 && divergent.length === 0;
  return {
    assertionId: "routing_invariance",
    ok,
    severity: "red",
    expected: `every perturbation routes to "${args.expectedSkillId}"`,
    observed:
      args.routedTurns.length === 0
        ? "no routed turns captured"
        : divergent.length === 0
          ? `all ${args.routedTurns.length} routed to ${args.expectedSkillId}`
          : divergent.map((t) => `"${t.nlText.slice(0, 40)}"→${t.routedSkillId ?? "clarify"}`).join("; "),
    ...(ok ? {} : { detail: `the router was not invariant under rephrasing: ${divergent.length} divergent turn(s)` }),
  };
}
