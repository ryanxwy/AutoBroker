/**
 * Typed error surface for the profile service + resolver (error-envelope codes).
 * Each carries a stable `code` that the HTTP error plugin maps to the documented
 * envelope { error: { field?, message, code } }.
 *
 * Error-class style mirrors the L2 gate (gate/index.ts): named subclasses of
 * Error with a `.name` set and a frozen literal `code`. FAIL-LOUD: these are
 * thrown, never returned as a soft fallback.
 */

/**
 * Intake tried to create a SECOND active profile for an (account, brand) that
 * already has one — rejected by the partial unique index
 * uq_search_profiles_active_account_brand (schema.ts:81). Surfaced to the UI as
 * Replace/Cancel. (→ HTTP 409.)
 */
export class ActiveSlotConflict extends Error {
  readonly code = "active_slot_conflict" as const;
  readonly account: string;
  readonly brand: string;
  readonly existingProfileId: string;
  constructor(args: { account: string; brand: string; existingProfileId: string }) {
    super(
      `active_slot_conflict: an active search_profiles row already exists for ` +
        `(account=${args.account}, brand=${args.brand}); existing id=${args.existingProfileId}. ` +
        `Replace the existing profile or cancel.`,
    );
    this.name = "ActiveSlotConflict";
    this.account = args.account;
    this.brand = args.brand;
    this.existingProfileId = args.existingProfileId;
  }
}

/**
 * An identity field (year, make, model, trim, location) was edited after the
 * first lead_submissions row referenced the profile — outside the typo window.
 * The user must Replace (supersede) or Cancel. (→ HTTP 409.)
 */
export class IdentityLockedError extends Error {
  readonly code = "identity_locked" as const;
  readonly lockedFields: readonly string[];
  constructor(lockedFields: readonly string[]) {
    super(
      `identity_locked: identity fields [${lockedFields.join(", ")}] are locked ` +
        `after the first lead submission; Replace or Cancel.`,
    );
    this.name = "IdentityLockedError";
    this.lockedFields = lockedFields;
  }
}

/** Identity fields that lock after the first outbound lead. */
export const IDENTITY_FIELDS = ["year", "make", "model", "trim", "location"] as const;

/**
 * Coordinate-resolution invariant: persist received a profile with NULL
 * latitude/longitude. Coordinates MUST be resolved upstream (workflow
 * resolveLocation) before create — the service is the LAST WALL and rejects
 * loud, never NULL-coords-to-DB.
 */
export class CoordinatesNotResolvedError extends Error {
  readonly code = "coordinates_not_resolved" as const;
  constructor(public readonly profileId: string) {
    super(
      `coordinates_not_resolved: refusing to persist profile ${profileId} with ` +
        `NULL latitude/longitude. Coordinates must be resolved before persist; ` +
        `geocode failure suspends back to the form upstream, never silently passes.`,
    );
    this.name = "CoordinatesNotResolvedError";
  }
}

/**
 * The persist parity-minimum (year/make/model) was not met when building a
 * row for INSERT. Distinct from the 6-field FORM contract (enforced in core's
 * SearchProfileIntakeInputSchema) — this is the looser service-side hard floor.
 */
export class MissingRequiredFieldError extends Error {
  readonly code = "missing_required_field" as const;
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super(
      `missing_required_field: persist requires non-empty [${fields.join(", ")}] ` +
        `(oracle parity minimum).`,
    );
    this.name = "MissingRequiredFieldError";
    this.fields = fields;
  }
}

/**
 * Resolver found no active profile (branch 0). STOP and point the user to
 * intake. (No dedicated envelope code — the resolver result `kind:'none'`
 * carries this; the error form is for call sites that demand a profile.)
 */
export class NoActiveProfileError extends Error {
  readonly code = "no_active_profile" as const;
  constructor() {
    super(
      `no_active_profile: no active search profile resolved. Run intake first to ` +
        `create one.`,
    );
    this.name = "NoActiveProfileError";
  }
}

/**
 * Resolver found 2+ active profiles (branch 2+). STOP and ask the user to
 * pick by vehicle name; `candidates` carries the list. (Ambiguous.)
 */
export class MultipleActiveProfilesError extends Error {
  readonly code = "multiple_active_profiles" as const;
  readonly candidates: readonly { id: string; label: string }[];
  constructor(candidates: readonly { id: string; label: string }[]) {
    super(
      `multiple_active_profiles: ${candidates.length} active profiles — ask the ` +
        `user to pick by vehicle name: ${candidates.map((c) => c.label).join(" | ")}.`,
    );
    this.name = "MultipleActiveProfilesError";
    this.candidates = candidates;
  }
}
