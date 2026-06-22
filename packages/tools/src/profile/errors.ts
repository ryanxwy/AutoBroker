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
 * An identity field (year, make, model, trim, location) appeared in an update
 * patch. Identity freezes the moment the profile is confirmed (created) —
 * confirm freezes identity. The user must Replace (supersede) or Cancel.
 * (→ HTTP 409.)
 */
export class IdentityLockedError extends Error {
  readonly code = "identity_locked" as const;
  readonly lockedFields: readonly string[];
  constructor(lockedFields: readonly string[]) {
    super(
      `identity_locked: identity fields [${lockedFields.join(", ")}] are frozen — ` +
        `confirm freezes identity. Replace or Cancel.`,
    );
    this.name = "IdentityLockedError";
    this.lockedFields = lockedFields;
  }
}

/** Identity fields frozen at confirm (profile creation). */
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
 * row for INSERT. Distinct from the 7-field FORM contract (enforced in core's
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

