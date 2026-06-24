/**
 * PortfolioScheduler — the bounded hot-set scheduler that sits ABOVE
 * resolveActiveProfile (the resolver is unchanged; each scheduled run resolves as
 * its own N=1 PINNED case via an explicit search_profile_id). It enumerates the hot
 * profiles (via the health provider), and schedules them as N INDEPENDENT
 * ProfilePipeline runs under a hard concurrency cap with LRU/recency eviction and
 * WFQ-style fairness, so concurrent multi-profile pipelines never storm the shared
 * resources.
 *
 * THE DELETION TEST (why the cap is load-bearing): remove the
 * `MAX_CONCURRENT_ACTIVE_PROFILES` cap and the hot-set collapses to an uncapped
 * fan-out — N profiles each spawning ~4 Chromium contexts + a flood of concurrent
 * SQLite writers (SQLITE_BUSY storms) + an unthrottled Gmail/LLM stream. The cap +
 * the per-profile key=1 + "suspended holds zero slots" are what keep N independent
 * pipelines bounded.
 *
 * SLOT MODEL:
 *   - A profile occupies a SLOT only while its run is ACTIVELY RUNNING. A run parked
 *     at a human gate (suspended) holds ZERO slots — the human is the bottleneck, not
 *     Chromium/LLM — so its slot frees for a warm profile while it waits.
 *   - Per-profile concurrency = 1: a profile with a live run (running OR suspended)
 *     is never given a second run (enforced via the activation registry).
 *   - A lock-blocked profile (blocked on another profile's dealer claim) is NON-HOT
 *     (the health provider classifies it warm) and is never scheduled.
 *
 * RUN-START SERIALIZATION: tick() awaits each startProfileRun in turn, so the
 * scheduler never races two starts — complementing beginRunGuarded's in-process
 * dup-runId guard.
 *
 * SINGLE-PROCESS: all slot/recency state is in-memory (intentional for Phase 0-2; a
 * future multi-process move needs a storage-level run-ownership lock first).
 */

import type { ActivationRegistry } from "./activationRegistry.js";
import type { ProfileHealthProvider } from "./profileHealth.js";
import type { RunLifecycleEvent, RunLifecycleListener, RunTerminalEvent } from "../skillRuns.js";

export interface PortfolioSchedulerDeps {
  healthProvider: ProfileHealthProvider;
  activationRegistry: ActivationRegistry;
  /** Start one profile's ProfilePipeline run (the explicit-pin N=1 case). Returns
   *  the runId so the scheduler can bind it in the activation registry (key=1). */
  startProfileRun: (profileId: string) => Promise<{ runId: string }>;
  /** MAX_CONCURRENT_ACTIVE_PROFILES — the hot-set slot cap. */
  cap: number;
  /** Profiles blocked on a dealer lock held by another profile (passed to the health
   *  provider so they classify NON-HOT). */
  lockBlockedProfileIds?: () => ReadonlySet<string>;
}

export class PortfolioScheduler implements RunLifecycleListener {
  /** Profiles whose run is actively RUNNING (occupying a slot). A suspended run is
   *  NOT here (it holds zero slots) though it stays in the activation registry. */
  private readonly running = new Set<string>();
  /** Monotonic last-progress order per profile (LRU/recency). A plain counter (no
   *  wall-clock) keeps tick decisions deterministic + resume-safe. */
  private readonly recency = new Map<string, number>();
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: PortfolioSchedulerDeps) {}

  /** Mark a profile as having just progressed (bumps its recency). Called on admit,
   *  on resume, and on suspend (it just did work to reach the gate). */
  recordProgress(profileId: string): void {
    this.recency.set(profileId, (this.seq += 1));
  }

  /**
   * One scheduling pass: admit hot, non-live profiles into free slots, most-
   * recently-progressed first, up to the cap; the least-recently-progressed tail is
   * left WARM (deferred) and admitted on a later tick when a slot frees.
   */
  async tick(): Promise<void> {
    const lockBlocked = this.deps.lockBlockedProfileIds?.() ?? new Set<string>();
    const health = this.deps.healthProvider.snapshot({
      lockBlockedProfileIds: lockBlocked,
      liveRunProfileIds: this.deps.activationRegistry.liveProfileIds(),
    });
    // Candidates = HOT profiles that do not already hold a live run (key=1: a
    // running OR suspended run already occupies the profile's single slot).
    const candidates = health
      .filter((h) => h.health === "hot")
      .map((h) => h.profileId)
      .filter((pid) => this.deps.activationRegistry.liveRunFor(pid) === undefined);

    // LRU/recency: keep the most-recently-progressed in the limited slots; the
    // least-recent tail stays warm. Fresh profiles (recency 0) sort oldest.
    candidates.sort((a, b) => (this.recency.get(b) ?? 0) - (this.recency.get(a) ?? 0));

    let available = Math.max(0, this.deps.cap - this.running.size);
    for (const profileId of candidates) {
      if (available <= 0) break; // the rest stay WARM — the cap bound (see DELETION TEST)
      const { runId } = await this.deps.startProfileRun(profileId);
      this.deps.activationRegistry.register(profileId, runId); // key=1 binding
      this.running.add(profileId);
      this.recordProgress(profileId);
      available -= 1;
    }
  }

  // --- RunLifecycleListener (wired into SkillRunService) ---------------------

  /** A run parked at a gate: free its slot (suspended holds ZERO slots) but keep the
   *  activation-registry binding (key=1 — the parked run still owns the profile). */
  onRunSuspended(event: RunLifecycleEvent): void {
    if (event.profileId === null) return;
    this.running.delete(event.profileId);
    this.recordProgress(event.profileId);
  }

  /** A run reached a terminal: free its slot AND release the profile's binding so a
   *  fresh run can be scheduled for it. */
  onRunTerminal(event: RunTerminalEvent): void {
    if (event.profileId !== null) this.running.delete(event.profileId);
    this.deps.activationRegistry.releaseRun(event.runId);
  }

  /** Begin ticking on an interval (production wiring). Tests call tick() directly. */
  start(intervalMs: number): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        // a tick error never crashes the loop; the next tick re-evaluates.
      });
    }, intervalMs);
    // Do not keep the process alive solely for the scheduler.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
