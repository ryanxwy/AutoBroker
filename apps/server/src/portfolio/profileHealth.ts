/**
 * profileHealth — the active/cold projection the PortfolioScheduler bounds its hot
 * set with: over `status ∈ {active, NULL}` profiles, classify each hot / warm /
 * cold. HOT = has work the scheduler should run; a profile blocked on a dealer lock
 * held by ANOTHER profile is NON-HOT (it can do no work until the lock frees);
 * suspended/idle profiles are warm/cold and hold zero slots.
 *
 * INTEGRATION: real impl from PROMPT-phase0-rest. Phase 0 deferred the derived
 * `packages/tools/src/pipeline/profileHealth.ts`, documented as
 * `profileHealth(db, liveRunProfileIds) -> {profileId, health, reasons[]}`, which
 * DERIVES hot/warm/cold (incl. lock-blocked) INTERNALLY from DB signals
 * (detectPipelineState + thread gate + a durable dormancy watermark + the active
 * dealer-claim rows). The `ProfileHealthProvider.snapshot(liveRunProfileIds)`
 * interface here matches that producer minus the bound `db`, so the real impl drops
 * in behind a one-line adapter (`{ snapshot: (live) => profileHealth(getDb(), live) }`).
 *
 * `StubProfileHealthProvider` is the Phase-2 stand-in: it enumerates the active set
 * via the tools layer and marks lock-blocked profiles non-hot, taking the
 * lock-blocked source in its CONSTRUCTOR (not the snapshot arg) so its public
 * snapshot signature stays identical to the real producer. PRODUCTION CAVEAT: when
 * the stub is constructed WITHOUT a lock-blocked source (the default), lock-blocked
 * detection is INERT — a lock-blocked profile is classified hot and only conflicts
 * out later at claimDealersStep (fail-closed, safe; it wastes one hot slot). Real
 * lock-blocked-non-hot detection lands with the phase0-rest profileHealth.
 */

export type ProfileHealthState = "hot" | "warm" | "cold";

export interface ProfileHealth {
  profileId: string;
  health: ProfileHealthState;
  reasons: string[];
}

export interface ProfileHealthProvider {
  /** Classify the active set at a point in time. `liveRunProfileIds` is the set of
   *  profiles that currently hold a live run (for the reasons trace + the real
   *  impl's recency signal). Matches the documented `profileHealth(db, live)`. */
  snapshot(liveRunProfileIds: ReadonlySet<string>): ProfileHealth[];
}

export class StubProfileHealthProvider implements ProfileHealthProvider {
  /**
   * @param listActiveProfileIds enumerates `status ∈ {active, NULL}` profile ids
   *   (wired to the tools layer in production; injected in tests). Called fresh on
   *   every snapshot — never cached.
   * @param lockBlockedProfileIds the profiles blocked on another profile's dealer
   *   lock (non-hot). Defaults to none — see the PRODUCTION CAVEAT above.
   */
  constructor(
    private readonly listActiveProfileIds: () => string[],
    private readonly lockBlockedProfileIds: () => ReadonlySet<string> = () => new Set(),
  ) {}

  snapshot(liveRunProfileIds: ReadonlySet<string>): ProfileHealth[] {
    const blocked = this.lockBlockedProfileIds();
    return this.listActiveProfileIds().map((profileId) => {
      if (blocked.has(profileId)) {
        // Blocked on another profile's dealer lock: doing no work -> non-hot. It
        // becomes hot again once the holder releases the rooftop claim.
        return { profileId, health: "warm" as const, reasons: ["lock_blocked"] };
      }
      const reasons = liveRunProfileIds.has(profileId) ? ["live_run"] : ["active"];
      return { profileId, health: "hot" as const, reasons };
    });
  }
}
