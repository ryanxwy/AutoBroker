/**
 * multiprofile/scheduler.stub — a deterministic in-process hot-set helper.
 *
 * The REAL bounded hot-set scheduler landed in Phase 2 at
 * `apps/server/src/portfolio/portfolioScheduler.ts` — but it is a STATEFUL,
 * server-coupled `RunLifecycleListener` class (mounted by `buildServer` via
 * `startPortfolioScheduler`) that admits + schedules live runs against the
 * `SkillRunService`, the activation registry, and `profileHealth`. The harness
 * does NOT (and must not) import that impure app-layer class into a pure plan:
 *   - the LIVE multi-profile lane (`runMultiProfileLane` → `startSoakHost` →
 *     `buildServer`) drives the real scheduler transparently INSIDE the server;
 *   - the PURE `planMultiProfileRun` + the in-process collision test need a
 *     deterministic, side-effect-free hot/deferred split, which this helper gives
 *     (trivial first-N cap). It is permanent, not a temporary swap target.
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
