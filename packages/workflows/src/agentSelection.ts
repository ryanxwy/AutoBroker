/**
 * agentSelection — per-run provider-selection registry + alias override (lane A).
 *
 * The UI/server picks a provider per RUN (an AgentSelection); this module is the
 * seam the harness reads at the generate boundary to re-home a DeepSeek-default
 * route onto the chosen provider. Two inputs, one resolution order:
 *
 *   1. a module-level Map<runId, AgentSelection> — the explicit per-run override
 *      the server registers (setRunSelection) and releases (clearRunSelection)
 *      through runtimeGlue's ownership lifecycle. Concurrency-safe under the
 *      single-Node-process topology (no AsyncLocalStorage, no Mastra
 *      runtimeContext); keyed by the same runId the ledger records.
 *   2. a single env default `AUTOBROKER_AGENT_PROVIDER` ("claude" | "deepseek")
 *      — the process-wide fallback when no per-run override is registered.
 *
 * resolveSelectionForRun = registry > env > null. NULL means "no selection" —
 * applySelection never fires and the route is the untouched policy() default, so
 * with the registry empty AND the env var unset behavior is byte-identical to the
 * DeepSeek default that shipped before this seam existed.
 *
 * applySelection only re-homes a DeepSeek base route (it swaps the provider
 * prefix, keeping the capability tier and the useCase). A non-deepseek route —
 * e.g. cross_provider_smoke's hard-pinned anthropic.chat — is returned verbatim.
 *
 * Dependency wall: imports @autobroker/core (the AgentSelection type) and
 * @autobroker/model (policyForAlias/withProvider/PolicyResolution). No side
 * effects, no DB, no provider call.
 */

import type { AgentSelection } from "@autobroker/core";
import { aliasForModelId, policyForAlias, withProvider, type PolicyResolution } from "@autobroker/model";

/** The single env var naming the process-wide default provider. */
const AGENT_PROVIDER_ENV = "AUTOBROKER_AGENT_PROVIDER";

/**
 * The per-run selection registry, keyed by runId. Module-level (one entry per
 * live run). The server sets a run's selection at start and clears it when the
 * run releases ownership; a run with no entry falls through to the env default.
 */
const runSelections = new Map<string, AgentSelection>();

/** Register the provider selection for a run (overrides the env default). */
export function setRunSelection(runId: string, sel: AgentSelection): void {
  runSelections.set(runId, sel);
}

/** Drop a run's selection (called on terminal/rollback via runtimeGlue). */
export function clearRunSelection(runId: string): void {
  runSelections.delete(runId);
}

/** The selection registered for a run, or undefined when none is set. */
export function getRunSelection(runId: string): AgentSelection | undefined {
  return runSelections.get(runId);
}

/**
 * Test-only: drop EVERY registered selection. The per-run entries are normally
 * cleared in lock-step with ownership (rollback / releaseRunOwnership), but an
 * isolated test that registers a selection without driving the run to terminal
 * would otherwise leak it across cases. Called from resetRuntimeGlueForTests so
 * the registry resets alongside the ownership set.
 */
export function __clearAllRunSelectionsForTests(): void {
  runSelections.clear();
}

/**
 * The process-wide default selection from `AUTOBROKER_AGENT_PROVIDER`:
 *   "claude"   → anthropic / oauth
 *   "deepseek" → deepseek / apikey
 *   anything else / unset → null (no default; route stays the policy() default).
 */
export function envDefaultSelection(): AgentSelection | null {
  const raw = process.env[AGENT_PROVIDER_ENV];
  if (raw === "claude") {
    return { provider: "anthropic", method: "oauth", model: null, effort: "off" };
  }
  if (raw === "deepseek") {
    return { provider: "deepseek", method: "apikey", model: null, effort: "off" };
  }
  return null;
}

/** Resolve a run's effective selection: registry override, then env, then null. */
export function resolveSelectionForRun(runId: string): AgentSelection | null {
  return getRunSelection(runId) ?? envDefaultSelection();
}

/**
 * Re-home a routed PolicyResolution onto the selected provider.
 *
 * IDENTITY when the route is not a DeepSeek alias (the only routes that exist as
 * a non-DeepSeek default today are the hard-pinned cross-provider ones, e.g.
 * cross_provider_smoke's anthropic.chat — never override those). Otherwise swap
 * the provider prefix (keeping the capability tier) and re-resolve capabilities,
 * preserving the original useCase.
 */
export function applySelection(route: PolicyResolution, sel: AgentSelection): PolicyResolution {
  if (!route.alias.startsWith("deepseek")) return route;
  const targetAlias = sel.model
    ? (aliasForModelId(sel.model) ?? withProvider(route.alias, sel.provider))
    : withProvider(route.alias, sel.provider);
  return { ...policyForAlias(targetAlias), useCase: route.useCase };
}
