/**
 * profilePinShared — the pin-required profile-resolution block shared by the 3
 * irreversible-send skills (dealer_web_lead_submit, negotiation_followup,
 * dealer_closeout_email). Each of those skills acts on exactly ONE profile and
 * NEVER infers — a pin-less input STOPs (safety invariant #6): 0 active →
 * no_active_profile, exactly-1 active → pin_required (one active is still not
 * silently run), 2+ active → multiple_active_profiles. A supplied pin that is no
 * longer active is rejected (pin_required).
 *
 * This module owns ONLY the shared classify-and-STOP LOGIC + the shared
 * profileStopCode classifier + the shared vehicle-label helper. The per-skill
 * STOP wording (the vehicle purpose clause, the pin clause, the /skill CTA) and
 * the per-skill typed StopError are supplied by the caller so each skill's
 * user-facing wording and typed error are preserved byte-for-byte.
 *
 * Dependency wall: imports only zod-free TYPES from @autobroker/tools (the Db
 * handle + the resolver result shape). It reaches NO side effect itself — the
 * caller passes its own `withDb` + resolver closures (the deps() seam), so the
 * per-skill `__set*DepsForTests` seams keep working unchanged.
 */

import type { Db, ResolveResult } from "@autobroker/tools";

// ---------------------------------------------------------------------------
// the shared STOP-code classifier (the common three-branch literal union)
// ---------------------------------------------------------------------------

/** The common pin-required STOP vocabulary the 3 send skills share. */
export type ProfilePinStopCode =
  | "no_active_profile"
  | "pin_required"
  | "multiple_active_profiles";

/**
 * The generalized profile-STOP classifier for a pin-less input. 0 active →
 * no_active_profile (point at intake CTA); exactly 1 active → pin_required (one
 * active is still not silently run — the user must explicitly pin); 2+ active →
 * multiple_active_profiles (ask by vehicle name). Returns the typed code only;
 * the caller supplies the wording.
 */
export function profileStopCode(activeCount: number): ProfilePinStopCode {
  if (activeCount <= 0) return "no_active_profile";
  if (activeCount === 1) return "pin_required";
  return "multiple_active_profiles";
}

/** "2026 Hyundai Tucson SEL"-style label for the ask/pin stops (and, where a
 *  skill reuses it, the prompt vehicle). Deterministic + pure. */
export function rowVehicleLabel(row: Record<string, unknown>): string {
  return [row["year"], row["make"], row["model"], row["trim"]]
    .filter((x) => x !== null && x !== undefined && x !== "")
    .join(" ");
}

// ---------------------------------------------------------------------------
// the shared pin-required classify-and-STOP + stale-pin reject + row load
// ---------------------------------------------------------------------------

/** The resolver closures the shared block needs — passed FROM each skill's
 *  deps() so the `__set*DepsForTests` seams stay load-bearing. */
export interface PinProfileResolvers {
  /** All active profile rows (the pin-less STOP candidate list). */
  listActiveProfiles: (db: Db) => Record<string, unknown>[];
  /** The typed three-branch resolver (validates a supplied pin is still active). */
  resolveProfile: (db: Db, args: { threadPin?: string }) => ResolveResult;
  /** Read one profile row by id (loads the resolved profile). */
  readProfileById: (db: Db, id: string) => Record<string, unknown> | null;
}

/** The arguments for the shared pin-required resolution. */
export interface ResolvePinnedProfileArgs {
  /** The skill's SHARED-DB runner (its own `withDb` closure over deps().getDb()). */
  withDb: <T>(fn: (db: Db) => T) => T;
  /** The resolver closures (from deps()). */
  resolvers: PinProfileResolvers;
  /** inputData.search_profile_id — null → the pin-less classify-and-STOP. */
  pin: string | null;
  /** The leading-slash skill CTA, e.g. "/negotiation_followup". */
  skillSlash: string;
  /** The <PURPOSE> clause in the no_active_profile message (e.g. "dealer threads
   *  to follow up"). Preserves the per-skill wording. */
  purposeClause: string;
  /** The <PIN> clause in the pin_required list message (e.g. "follows up threads
   *  for a search you have explicitly pinned"). Preserves the per-skill wording. */
  pinClause: string;
  /** Constructs the per-skill typed StopError (so the typed error + code stay
   *  per-skill). */
  makeError: (code: ProfilePinStopCode, message: string) => Error;
}

/** The resolved profile: the loaded row (null → the caller applies its own
 *  `?? {}`) plus the resolved profile id (the caller's search_profile_id
 *  fallback when the row is missing). */
export interface ResolvedPinnedProfile {
  row: Record<string, unknown> | null;
  profileId: string;
}

/**
 * The shared pin-required resolution: a pin-less input classifies the active set
 * and STOPs (0 → no_active_profile, 1 → still pin_required, 2+ →
 * multiple_active_profiles); a supplied pin must still resolve `pinned` (a
 * stale/closed/missing pin STOPs pin_required); then the profile row is loaded
 * and returned. NEVER auto-runs on a single active profile (invariant #6). The
 * user-facing wording is templated from the caller's clauses so each skill's
 * exact message is preserved.
 */
export function resolvePinnedProfileRowOrStop(
  args: ResolvePinnedProfileArgs,
): ResolvedPinnedProfile {
  const { withDb, resolvers, pin, skillSlash, purposeClause, pinClause, makeError } = args;
  const skillName = skillSlash.replace(/^\//, "");

  // Pin-less: EXPLICIT-PIN REQUIRED (never infers, not even the single-active
  // case). The generalized classifier STOPs on every branch.
  if (pin === null) {
    const active = withDb((db) => resolvers.listActiveProfiles(db));
    const code = profileStopCode(active.length);
    if (code === "no_active_profile") {
      throw makeError(
        "no_active_profile",
        `No active search profile found — ${skillName} needs one to know which ` +
          `${purposeClause}. Run /search_profile_intake to create a profile, then ` +
          `re-run ${skillSlash}.`,
      );
    }
    const labels = active.map((r) => rowVehicleLabel(r)).join(" | ");
    throw makeError(
      code, // pin_required (1 active) | multiple_active_profiles (2+)
      `Pin a search first: ${labels}. ${skillName} only ${pinClause} — pick one ` +
        `from the Searches list, then re-run ${skillSlash}.`,
    );
  }

  // A supplied pin must still be active; a stale/closed/missing pin is rejected.
  const resolved = withDb((db) => resolvers.resolveProfile(db, { threadPin: pin }));
  if (resolved.kind !== "pinned") {
    throw makeError(
      "pin_required",
      "That pinned search is no longer active. Pick an active search from the " +
        `Searches list and re-run ${skillSlash}.`,
    );
  }

  const row = withDb((db) => resolvers.readProfileById(db, resolved.profile.id));
  return { row, profileId: resolved.profile.id };
}
