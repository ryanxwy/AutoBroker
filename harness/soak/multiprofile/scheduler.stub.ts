/**
 * multiprofile/scheduler.stub — a deterministic in-process hot-set helper.
 *
 * The REAL bounded hot-set scheduler landed in Phase 2 at
 * `apps/server/src/portfolio/portfolioScheduler.ts` — a STATEFUL, server-coupled
 * `RunLifecycleListener` class that admits + schedules live runs against the
 * `SkillRunService`, the activation registry, and `profileHealth`. It is mounted
 * by `startPortfolioScheduler` — the production `main()`, and the live e2e host
 * `serve-live.mjs` (opt-in) — gated on `AUTOBROKER_PORTFOLIO_SCHEDULER=1`
 * (`buildServer` itself never mounts it). The harness does NOT (and must not)
 * import that impure app-layer class into a pure plan:
 *   - the deterministic soak lane (`planMultiProfileRun` / `runMultiProfileLane`)
 *     uses THIS stub for a side-effect-free first-N hot/deferred split, so the
 *     chaos + replay corpus stays fully reproducible (no real scheduler timer);
 *   - the REAL scheduler's LIVE cap/eviction proof happens in the e2e-loop
 *     serve-live 3.9 lane, where `serve-live.mjs` mounts it under
 *     `AUTOBROKER_PORTFOLIO_SCHEDULER=1` + `MAX_CONCURRENT_ACTIVE_PROFILES`.
 * This stub is permanent, not a temporary swap target.
 *
 * Dependency wall: harness layer. Pure — no DB, no provider, no framework,
 * no playwright, no node builtins.
 */

// ---------------------------------------------------------------------------
// types — the harness's own deterministic hot/deferred contract (independent of
// the app-layer PortfolioScheduler class shape; see the header).
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
