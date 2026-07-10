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
 * PROCESS-LOCAL slot accounting is paired with the durable SQLite profile claim
 * in SkillRunService. Two processes may each track local slots, but only one can
 * create a run for a given profile.
 */

import type { PipelineAdmissionDecision, ProfileHealth } from "@autobroker/tools";

import type { ActivationRegistry } from "./activationRegistry.js";
import type { RunLifecycleEvent, RunLifecycleListener, RunTerminalEvent } from "../skillRuns.js";

/**
 * The scheduler's health-projection seam: classify the active set hot/warm/cold at a
 * point in time, given the profiles that currently hold a live run. Production wires
 * the real `profileHealth(db, liveRunProfileIds)` (a one-line adapter); tests inject a
 * fake. Matches the tools-layer `profileHealth` signature minus the bound `db`.
 */
export interface ProfileHealthProvider {
  snapshot(liveRunProfileIds: ReadonlySet<string>): ProfileHealth[];
}

/** Tick-time switch projection. Harness/test contexts are an unconditional
 * fail-closed no-op even if the persisted/user env says enabled. */
export function autoRunSearchesEnabled(
  configuredValue: string | undefined,
  harnessContext: boolean,
): boolean {
  return !harnessContext && configuredValue === "1";
}

/** Durable same-input admission seam. The decision captures an exact frontier;
 * record() persists that same frontier only after startProfileRun succeeds. */
export interface PortfolioAdmissionGate {
  evaluate(profileId: string): PipelineAdmissionDecision;
  record(profileId: string, decision: PipelineAdmissionDecision): void;
}

export interface PortfolioSchedulerDeps {
  /** Classifies the active set hot/warm/cold (lock-blocked profiles are non-hot —
   *  the provider derives that, matching the documented profileHealth producer). */
  healthProvider: ProfileHealthProvider;
  /** Read fresh on every tick so the Settings switch takes effect without a
   * scheduler start/stop lifecycle. */
  isEnabled: () => boolean;
  admissionGate: PortfolioAdmissionGate;
  activationRegistry: ActivationRegistry;
  /** Start one profile's ProfilePipeline run (the explicit-pin N=1 case). The
   *  SkillRunService atomically claims the profile before creating the run.
   *  null means another process won that claim; no run was created. */
  startProfileRun: (profileId: string) => Promise<{ runId: string } | null>;
  /** MAX_CONCURRENT_ACTIVE_PROFILES — the hot-set slot cap. */
  cap: number;
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
  /** Re-entrancy guard: tick() awaits run starts, and the production setInterval does
   *  NOT wait for an async callback, so two ticks could otherwise overlap and double-
   *  pick a profile (its first tick still awaiting startProfileRun, not yet in the
   *  registry). The guard makes overlapping ticks a no-op. */
  private ticking = false;

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
    if (this.ticking) return; // re-entrancy guard — overlapping ticks are a no-op
    this.ticking = true;
    try {
      if (!this.deps.isEnabled()) return;
      const health = this.deps.healthProvider.snapshot(this.deps.activationRegistry.liveProfileIds());
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
        const admission = this.deps.admissionGate.evaluate(profileId);
        if (!admission.shouldAdmit) continue;
        const started = await this.deps.startProfileRun(profileId);
        if (started === null) continue;
        // Run creation succeeded. Persist the exact pre-start input frontier;
        // never re-read here, because input arriving during start is NEW work.
        this.deps.admissionGate.record(profileId, admission);
        const { runId } = started;
        // SkillRunService owns the durable claim. Never write it here: a very
        // fast run may already have terminated (and cleared its claim) before
        // startProfileRun's promise returns. Re-registering after that terminal
        // would resurrect a stale owner and consume a ghost scheduler slot.
        if (this.deps.activationRegistry.profileForRun(runId) !== profileId) continue;
        this.running.add(profileId);
        this.recordProgress(profileId);
        available -= 1;
      }
    } finally {
      this.ticking = false;
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

  /** A human resumed a parked run: it RE-OCCUPIES its slot for the duration of its
   *  resumed execution (it is doing Chromium/LLM work again until it re-suspends or
   *  terminates). Without this, a resumed run would execute while accounted as zero
   *  slots and the scheduler would admit `cap` more on top — exceeding the cap on the
   *  resume path (the whole point of the cap, per the DELETION TEST). */
  onRunResumed(event: RunLifecycleEvent): void {
    if (event.profileId === null) return;
    this.running.add(event.profileId);
    this.recordProgress(event.profileId);
  }

  /** A run reached a terminal: free its slot AND release the profile's binding so a
   *  fresh run can be scheduled for it. Drop its recency entry too (bound the map —
   *  the same grow-only pattern this round fixes for the carry maps). */
  onRunTerminal(event: RunTerminalEvent): void {
    if (event.profileId !== null) {
      this.running.delete(event.profileId);
      this.recency.delete(event.profileId);
    }
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
