/**
 * profileHealth — the active/cold projection the PortfolioScheduler bounds its hot
 * set with: over `status ∈ {active, NULL}` profiles, classify each hot / warm /
 * cold. HOT = has work the scheduler should run; a profile blocked on a dealer lock
 * held by ANOTHER profile is NON-HOT (it can do no work until the lock frees);
 * suspended/idle profiles are warm/cold and hold zero slots.
 *
 * INTEGRATION: real impl from PROMPT-phase0-rest. Phase 0 deferred the derived
 * `packages/tools/src/pipeline/profileHealth.ts` (the full classification over a
 * durable `pipeline.last_progress_at.<id>` watermark + detectPipelineState +
 * thread-gate signals). This `StubProfileHealthProvider` is the Phase-2 stand-in
 * behind the `ProfileHealthProvider` interface — enough to bound the scheduler and
 * honor "lock-blocked = non-hot". When the real tool lands, wrap it in a provider
 * that implements the same interface and delete this stub.
 */

export type ProfileHealthState = "hot" | "warm" | "cold";

export interface ProfileHealth {
  profileId: string;
  health: ProfileHealthState;
  reasons: string[];
}

export interface ProfileHealthInput {
  /** Profiles blocked on a dealer lock held by another profile — non-hot. */
  lockBlockedProfileIds: ReadonlySet<string>;
  /** Profiles that currently hold a live run (for the reasons trace). */
  liveRunProfileIds: ReadonlySet<string>;
}

export interface ProfileHealthProvider {
  /** Classify the active set at a point in time. */
  snapshot(input: ProfileHealthInput): ProfileHealth[];
}

export class StubProfileHealthProvider implements ProfileHealthProvider {
  /**
   * @param listActiveProfileIds enumerates `status ∈ {active, NULL}` profile ids
   *   (wired to the tools layer in production; injected in tests). Called fresh on
   *   every snapshot — never cached.
   */
  constructor(private readonly listActiveProfileIds: () => string[]) {}

  snapshot(input: ProfileHealthInput): ProfileHealth[] {
    return this.listActiveProfileIds().map((profileId) => {
      if (input.lockBlockedProfileIds.has(profileId)) {
        // Blocked on another profile's dealer lock: doing no work -> non-hot. It
        // becomes hot again once the holder releases the rooftop claim.
        return { profileId, health: "warm" as const, reasons: ["lock_blocked"] };
      }
      const reasons = input.liveRunProfileIds.has(profileId) ? ["live_run"] : ["active"];
      return { profileId, health: "hot" as const, reasons };
    });
  }
}
