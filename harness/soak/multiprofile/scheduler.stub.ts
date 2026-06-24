/**
 * multiprofile/scheduler.stub — the Phase-2 PortfolioScheduler seam (stub).
 *
 * INTEGRATION: real impl from PROMPT-phase2 — PortfolioScheduler with
 * profileHealth-driven hot-set, MAX_CONCURRENT_ACTIVE_PROFILES cap + LRU/recency
 * eviction + WFQ fairness + dealer-lock-blocked = non-hot.
 * This stub only does the trivial first-N cap so the orchestrator typechecks +
 * demonstrates the hot/deferred shape deterministically; integration replaces it
 * with the real apps/server scheduler.
 *
 * Dependency wall: harness layer. Pure — no DB, no provider, no framework,
 * no playwright, no node builtins.
 */

// ---------------------------------------------------------------------------
// types (the Phase-2 seam contract — FROZEN shape; real impl must satisfy it)
// ---------------------------------------------------------------------------

export interface PortfolioScheduleInput {
  activeProfileIds: string[];
  maxConcurrent?: number;
}

export interface PortfolioSchedule {
  /** Profile ids to run this tick (within cap). */
  hot: string[];
  /** Profile ids deferred to a later tick (over cap). */
  deferred: string[];
}

export interface PortfolioScheduler {
  schedule(input: PortfolioScheduleInput): PortfolioSchedule;
}

// ---------------------------------------------------------------------------
// stub implementation
// ---------------------------------------------------------------------------

/**
 * Create the stub scheduler: hot = first-N, deferred = the rest.
 * No health scoring, no eviction — just the shape for the orchestrator to typecheck.
 */
export function createStubPortfolioScheduler(): PortfolioScheduler {
  return {
    schedule({ activeProfileIds, maxConcurrent }: PortfolioScheduleInput): PortfolioSchedule {
      const cap = maxConcurrent ?? activeProfileIds.length;
      return {
        hot: activeProfileIds.slice(0, cap),
        deferred: activeProfileIds.slice(cap),
      };
    },
  };
}
