/**
 * finalState — the deterministic, LLM-free disposition + next-action of a
 * pipeline run. The legacy pipeline narrated these via an LLM; here they are pure
 * code over two step sets (a parity gain — same input always yields the same
 * verdict).
 *
 *   computeFinalState(detected, completed):
 *     - no_work  — nothing was applicable this run (detected is empty).
 *     - ok       — every applicable step completed (completed ⊇ detected).
 *     - partial  — at least one applicable step completed but not all (a child
 *                  failed / was blocked / suspended-then-declined). Also the
 *                  shape where SOMETHING was detected but zero completed (a
 *                  first-step failure) — that is still "partial", never "ok".
 *
 *   computeNextAction(finalState, detected, completed): a plain-speak,
 *   deterministic next step derived from which applicable steps remain. Never
 *   empty.
 *
 * The four pipeline children + the disposition vocabulary live HERE in the
 * tools layer (the dependency wall forbids tools importing the workflows-layer
 * contracts). The workflows-layer Zod contract enumerates the same literals;
 * keep the two in lockstep.
 */

/** The four child steps, in canonical fan-out order. */
export const PIPELINE_STEPS = ["extract", "scrape", "audit", "compare"] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

/** The terminal pipeline disposition. */
export const FINAL_STATES = ["ok", "partial", "no_work"] as const;
export type FinalState = (typeof FINAL_STATES)[number];

/** Canonical order + dedupe of a step list (stable output). */
function canonicalize(steps: readonly PipelineStep[]): PipelineStep[] {
  const seen = new Set(steps);
  return PIPELINE_STEPS.filter((s) => seen.has(s));
}

/**
 * The terminal disposition. `detected` = the applicable set this run;
 * `completed` = the subset that actually finished.
 */
export function computeFinalState(
  detected: readonly PipelineStep[],
  completed: readonly PipelineStep[],
): FinalState {
  const detectedSet = new Set(detected);
  if (detectedSet.size === 0) return "no_work";
  const completedSet = new Set(completed);
  // Every applicable step completed → ok; any applicable step missing → partial.
  for (const step of detectedSet) {
    if (!completedSet.has(step)) return "partial";
  }
  return "ok";
}

/**
 * The deterministic next-action string. Lists the applicable steps that did
 * NOT complete (in canonical order) so the user knows exactly what remains.
 */
export function computeNextAction(
  finalState: FinalState,
  detected: readonly PipelineStep[],
  completed: readonly PipelineStep[],
): string {
  if (finalState === "no_work") {
    return "Nothing to do — no replies to extract, no stale incentives, no unaudited quotes, and fewer than two comparable quotes.";
  }
  if (finalState === "ok") {
    return "Pipeline complete — review the latest quote comparison.";
  }
  const completedSet = new Set(completed);
  const remaining = canonicalize(detected).filter((s) => !completedSet.has(s));
  const label = remaining.join(", ");
  return `Partial run — re-run the pipeline to finish the remaining step(s): ${label}.`;
}
