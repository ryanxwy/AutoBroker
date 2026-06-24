/**
 * activationRegistry — the durable `ProfileId -> live runId` map that the
 * PortfolioScheduler and the ApprovalInbox route through: it enforces per-profile
 * concurrency = 1 (a profile holds AT MOST ONE live run), and lets any inbound
 * event resolve the one correct pipeline.
 *
 * INTEGRATION: real impl from PROMPT-phase0-rest. Phase 0 deferred the DURABLE
 * registry (a mastra.db-adjacent / pipeline_state KV row + a boot-orphan sweep).
 * This in-memory implementation is the Phase-2 stub behind the `ActivationRegistry`
 * interface: single-process, in-memory, matching the documented run-drive
 * single-process invariant (a future multi-process move needs a storage-level
 * run-ownership lock first). When the durable version lands, replace the class
 * body — the interface is the contract the scheduler/inbox depend on.
 */

/** Thrown when a second, DIFFERENT run is registered for a profile that already
 *  holds a live run — the per-profile concurrency=1 backstop. */
export class ActivationConflictError extends Error {
  readonly profileId: string;
  readonly liveRunId: string;
  readonly attemptedRunId: string;
  constructor(profileId: string, liveRunId: string, attemptedRunId: string) {
    super(
      `profile '${profileId}' already has live run '${liveRunId}'; refusing concurrent run '${attemptedRunId}' (per-profile key=1)`,
    );
    this.name = "ActivationConflictError";
    this.profileId = profileId;
    this.liveRunId = liveRunId;
    this.attemptedRunId = attemptedRunId;
  }
}

export interface ActivationRegistry {
  /** The live runId for a profile, or undefined when it has none. */
  liveRunFor(profileId: string): string | undefined;
  /** The profile a runId belongs to, or undefined. */
  profileForRun(runId: string): string | undefined;
  /** Bind a profile to its one live run. Idempotent for the same (profile, run);
   *  throws {@link ActivationConflictError} for a second different run. */
  register(profileId: string, runId: string): void;
  /** Release the binding by runId (the terminal hook). No-op if unknown. */
  releaseRun(runId: string): void;
  /** The set of profiles that currently hold a live run. */
  liveProfileIds(): ReadonlySet<string>;
}

export class InMemoryActivationRegistry implements ActivationRegistry {
  private readonly byProfile = new Map<string, string>();
  private readonly byRun = new Map<string, string>();

  liveRunFor(profileId: string): string | undefined {
    return this.byProfile.get(profileId);
  }

  profileForRun(runId: string): string | undefined {
    return this.byRun.get(runId);
  }

  register(profileId: string, runId: string): void {
    const existing = this.byProfile.get(profileId);
    if (existing !== undefined) {
      if (existing === runId) return; // idempotent re-attach
      throw new ActivationConflictError(profileId, existing, runId);
    }
    this.byProfile.set(profileId, runId);
    this.byRun.set(runId, profileId);
  }

  releaseRun(runId: string): void {
    const profileId = this.byRun.get(runId);
    if (profileId === undefined) return;
    this.byRun.delete(runId);
    // Only clear the profile->run edge if it still points at THIS run (a newer
    // run could already have rebound the profile in a race-free single process).
    if (this.byProfile.get(profileId) === runId) this.byProfile.delete(profileId);
  }

  liveProfileIds(): ReadonlySet<string> {
    return new Set(this.byProfile.keys());
  }
}
