/**
 * profileService — the ONLY write path for search_profiles + audit_log
 * (BACKEND_SERVICES §8, the tools-layer ★). Migrates the legacy
 * services/profile.py + search_profile_intake.py + intake.py responsibilities
 * into TS closures over the @autobroker/db handle.
 *
 * SQLITE INVARIANT: only packages/tools (and db beneath it) touch the product
 * DB. Routes / workflows / model delegate down here; they never open the
 * connection. Raw better-sqlite3 statements via db.$client — NO drizzle-orm
 * import (dependency-cruiser sqlite-only-in-db, severity error).
 *
 * PERSIST DISCIPLINE (§8.3, §8.4, 裁定⑨):
 *   - synth id = SHA-256 first-16-hex of make|model|trim|year|postal_code
 *     (computed AFTER location parse so postal_code is in the hash). The postal
 *     preference is the GEOCODED coordinates.postalCode (when goplaces returned
 *     one) over the local parseLocation() postal, so two inputs that differ only
 *     in resolved postal hash to DIFFERENT ids (FIX 4).
 *   - EXACTLY 1 search_profiles row + 1 audit_log row (action
 *     'search_profile_intake', payload = full input JSON), in ONE transaction.
 *   - DOUBLE-FIRE SAFE: same input → same id; an already-present id is treated
 *     as success with NO re-write (idempotent persist).
 *   - ActiveSlotConflict: a second active row for the same (account, brand) is
 *     rejected by the partial unique index → mapped to the typed error.
 *   - lat/lng REQUIRED at create (裁定⑨): NULL coords throw
 *     CoordinatesNotResolvedError — the service is the LAST WALL; upstream
 *     workflow already resolved/suspended on geocode failure.
 *   - fake-phone: policy 'fake' (default) → keep first 6, randomize last 4 into
 *     fake_phone; real number stays in follow_up_phone.
 */

import { createHash } from "node:crypto";
import type { Db } from "@autobroker/db";
import {
  SearchProfileSchema,
  SearchProfileIntakeInputSchema,
  type SearchProfile,
  type SearchProfileIntakeInput,
} from "@autobroker/core";
import { profileToRow, rowToProfile, type SearchProfileRow } from "./adapter.js";
import { resolveStoredPhone, type Rng } from "./fakePhone.js";
import { writeAuditLog, AUDIT_ACTIONS } from "./audit.js";
import {
  ActiveSlotConflict,
  CoordinatesNotResolvedError,
  IdentityLockedError,
  IDENTITY_FIELDS,
  MissingRequiredFieldError,
} from "./errors.js";
import { resolveActiveProfile, type ResolveResult } from "./resolver.js";

// ---------------------------------------------------------------------------
// LC-1 — pure validate (no DB) : validate_intake_payload parity (§8.2)
// ---------------------------------------------------------------------------

/** Result of the pure validate pass (§8.1 signature). */
export interface ValidateResult {
  ok: boolean;
  errors: readonly string[];
}

/**
 * LC-1 pure validation — the oracle parity-minimum (year/make/model non-empty +
 * year int-coercible). Does NOT touch the DB. This is intentionally LOOSER than
 * the 6-field FORM contract (SearchProfileIntakeInputSchema, core): a skill can
 * dry-run this without forcing the full form set. Returns { ok, errors[] }.
 */
export function validate(input: unknown): ValidateResult {
  const errors: string[] = [];
  if (input === null || typeof input !== "object") {
    return { ok: false, errors: ["input is not an object"] };
  }
  const i = input as Record<string, unknown>;
  if (typeof i.make !== "string" || i.make.trim() === "") errors.push("make is required");
  if (typeof i.model !== "string" || i.model.trim() === "") errors.push("model is required");
  const year = i.year;
  const yearOk =
    (typeof year === "number" && Number.isInteger(year)) ||
    (typeof year === "string" && /^\d+$/.test(year.trim()));
  if (!yearOk) errors.push("year is required and must be an integer");
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// location parsing (§8.3) — local regex; coords come from upstream goplaces
// ---------------------------------------------------------------------------

/** Parsed city/state/postal from a raw location_query. country defaults US. */
export interface ParsedLocation {
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string;
}

const ZIP_ONLY = /^\s*(\d{5})(?:-\d{4})?\s*$/;
const CITY_ST_ZIP = /^\s*([^,]+?),\s*([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?\s*$/;

/**
 * Local-regex parse of a location_query (§8.3, profile.py:43). Handles a bare
 * 5(+4) ZIP and the "City, ST ZIP" form. Coordinates are NOT computed here — the
 * workflow's goplaces step resolves lat/lng before create (裁定⑨).
 */
export function parseLocation(locationQuery: string | null): ParsedLocation {
  const base: ParsedLocation = { city: null, state: null, postalCode: null, country: "US" };
  if (locationQuery === null) return base;
  const zip = ZIP_ONLY.exec(locationQuery);
  if (zip !== null) return { ...base, postalCode: zip[1]! };
  const full = CITY_ST_ZIP.exec(locationQuery);
  if (full !== null) {
    return { ...base, city: full[1]!.trim(), state: full[2]!.toUpperCase(), postalCode: full[3]! };
  }
  return base;
}

// ---------------------------------------------------------------------------
// synth id (§8.3) — deterministic, double-fire safe
// ---------------------------------------------------------------------------

/** SHA-256 first-16-hex of make|model|trim|year|postal_code (§8.3). Trim and
 *  postal default to empty string so the hash is stable for a fixed input. */
export function synthProfileId(parts: {
  make: string;
  model: string;
  trim: string | null;
  year: number;
  postalCode: string | null;
}): string {
  const key = [parts.make, parts.model, parts.trim ?? "", String(parts.year), parts.postalCode ?? ""].join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// create options + coordinates injected by the upstream workflow
// ---------------------------------------------------------------------------

/**
 * Resolved geo the workflow MUST supply at create (裁定⑨). The service rejects
 * NULL lat/lng; resolvedAddress is optional echo from goplaces. `postalCode` is
 * the geocoded postal (goplaces GeoLocation.postalCode) and, when present, is
 * preferred over the locally-parsed postal in the synth id (FIX 4). Omit (do not
 * bind undefined) under exactOptionalPropertyTypes.
 */
export interface ResolvedCoordinates {
  latitude: number;
  longitude: number;
  resolvedAddress?: string | null;
  postalCode?: string;
}

export interface CreateOpts {
  actor?: string;
  reason?: string;
  /** Resolved coordinates (裁定⑨ — required; NULL is rejected). */
  coordinates: ResolvedCoordinates;
  /** RNG seam for the fake-phone last-4 (tests inject a seeded rng). */
  rng?: Rng;
}

export interface CreateResult {
  profile: SearchProfile;
  auditId: string;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const SELECT_BY_ID = "SELECT * FROM search_profiles WHERE search_profile_id = ?";
const SELECT_SOLE_ACCOUNT = "SELECT account_id FROM accounts LIMIT 2";
const SELECT_ACTIVE_FOR_SLOT =
  "SELECT search_profile_id FROM search_profiles " +
  "WHERE status = 'active' AND brand IS ? AND account_id IS ? " +
  "ORDER BY rowid DESC LIMIT 1";

const PROFILE_COLUMNS: readonly (keyof SearchProfileRow)[] = [
  "search_profile_id", "year", "make", "model", "trim", "budget_max",
  "search_radius_miles", "location_query", "resolved_address", "city", "state",
  "postal_code", "country", "latitude", "longitude", "follow_up_email",
  "follow_up_phone", "phone_policy", "fake_phone", "financing_preference",
  "trade_in_description", "military_first_responder", "current_brand_owner",
  "preferred_exterior_colors_json", "preferred_interior_colors_json",
  "acceptable_trims_json", "feature_preferences_json", "account_id", "brand",
  "location", "status", "superseded_by", "updated_at",
];

const INSERT_PROFILE =
  `INSERT INTO search_profiles (${PROFILE_COLUMNS.join(", ")}) ` +
  `VALUES (${PROFILE_COLUMNS.map(() => "?").join(", ")})`;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The sole accounts row's id, or null when 0 or 2+ exist (do not guess, §8.3). */
function resolveSoleAccountId(db: Db): string | null {
  const rows = db.$client.prepare(SELECT_SOLE_ACCOUNT).all() as { account_id: string }[];
  return rows.length === 1 ? rows[0]!.account_id : null;
}

/** Build the validated SearchProfile from intake input + resolved coords +
 *  defaults (§8.3). The synth id is computed inside (postal_code in the hash). */
function buildProfile(
  db: Db,
  input: SearchProfileIntakeInput,
  coords: ResolvedCoordinates,
  rng: Rng | undefined,
): SearchProfile {
  const loc = parseLocation(input.location_query);
  const phonePolicy = input.phone_policy ?? "fake";
  const fakePhone = resolveStoredPhone(input.follow_up_phone, phonePolicy === "real" ? "real" : "fake", rng);
  // Synth-id postal preference (FIX 4): geocoded postal (coords.postalCode) over
  // the locally-parsed postal, so a resolved-postal difference yields a new id.
  const synthPostal = coords.postalCode ?? loc.postalCode ?? "";
  const id = synthProfileId({
    make: input.make,
    model: input.model,
    trim: input.trim,
    year: input.year,
    postalCode: synthPostal,
  });
  const accountId = resolveSoleAccountId(db);

  const profile: SearchProfile = {
    id,
    year: input.year,
    make: input.make,
    model: input.model,
    trim: input.trim,
    budgetMax: input.budget_max,
    searchRadiusMiles: input.search_radius_miles ?? 25,
    locationQuery: input.location_query,
    resolvedAddress: coords.resolvedAddress ?? null,
    city: loc.city,
    state: loc.state,
    postalCode: loc.postalCode,
    country: loc.country,
    latitude: coords.latitude,
    longitude: coords.longitude,
    followUpEmail: input.follow_up_email,
    followUpPhone: input.follow_up_phone,
    phonePolicy,
    fakePhone,
    financingPreference: input.financing_preference,
    tradeInDescription: input.trade_in_description,
    militaryFirstResponder: input.military_first_responder ?? 0,
    currentBrandOwner: input.current_brand_owner ?? 0,
    preferredExteriorColorsJson: input.preferred_exterior_colors_json,
    preferredInteriorColorsJson: input.preferred_interior_colors_json,
    acceptableTrimsJson: input.acceptable_trims_json,
    featurePreferencesJson: input.feature_preferences_json,
    accountId,
    brand: input.make, // brand = make (active-uniqueness key, §8.3).
    location: input.location_query, // location = location_query (§8.3).
    status: "active",
    supersededBy: null,
    updatedAt: null,
  };
  // Re-parse so a malformed build fails LOUD before touching the DB.
  return SearchProfileSchema.parse(profile);
}

function bindValues(row: SearchProfileRow): unknown[] {
  return PROFILE_COLUMNS.map((c) => row[c]);
}

function isUniqueConstraint(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

// ---------------------------------------------------------------------------
// create (LC-2) — the persist write path
// ---------------------------------------------------------------------------

/**
 * Persist an intake input as EXACTLY 1 search_profiles row + 1 audit_log row,
 * idempotently. The full pipeline (§8.1): form .strict() validate → persist
 * parity-minimum → location parse → synth id → defaults → coord guard → INSERT +
 * audit, all in one transaction.
 *
 * Double-fire safe: if the synth id already exists, returns that profile with
 * NO re-write (the audit row is not duplicated either).
 */
export function create(
  db: Db,
  input: SearchProfileIntakeInput,
  opts: CreateOpts,
): CreateResult {
  // (1) Form-contract back-validation (.strict(), 6-field required, enums).
  const parsed = SearchProfileIntakeInputSchema.parse(input);

  // (2) Persist parity-minimum hard floor (§8.2): year/make/model.
  const lc = validate(parsed);
  if (!lc.ok) {
    const missing = ["make", "model", "year"].filter((f) =>
      lc.errors.some((e) => e.startsWith(f)),
    );
    throw new MissingRequiredFieldError(missing);
  }

  // (3) Build the row (location parse + synth id + defaults + fake phone).
  const profile = buildProfile(db, parsed, opts.coordinates, opts.rng);

  // (4) 裁定⑨ coordinate guard — the LAST WALL. NULL coords never reach DB.
  if (profile.latitude === null || profile.longitude === null) {
    throw new CoordinatesNotResolvedError(profile.id);
  }

  // (5) Idempotency: same input → same id. An existing row is success, no write.
  const existing = db.$client.prepare(SELECT_BY_ID).get(profile.id) as
    | SearchProfileRow
    | undefined;
  if (existing !== undefined) {
    return { profile: rowToProfile(existing), auditId: "" };
  }

  // (6) INSERT row + audit_log in ONE transaction. Map the active-slot unique
  //     constraint to the typed ActiveSlotConflict.
  const row = profileToRow(profile);
  const payloadJson = JSON.stringify(parsed);

  const txn = db.$client.transaction((): string => {
    db.$client.prepare(INSERT_PROFILE).run(...bindValues(row));
    return writeAuditLog(db, {
      action: AUDIT_ACTIONS.searchProfileIntake,
      actor: opts.actor ?? null,
      targetTable: "search_profiles",
      targetId: profile.id,
      searchProfileId: profile.id,
      reason: opts.reason ?? null,
      payloadJson,
    });
  });

  let auditId: string;
  try {
    auditId = txn();
  } catch (err) {
    if (isUniqueConstraint(err)) {
      // CAVEAT: the partial unique index does NOT protect the slot when
      // account_id is NULL (SQLite treats NULLs as distinct) — this guarantee
      // is conditional on a resolved sole account (resolveSoleAccountId non-null).
      // A concurrent/prior active row holds the (account, brand) slot.
      const slot = db.$client
        .prepare(SELECT_ACTIVE_FOR_SLOT)
        .get(profile.brand, profile.accountId) as { search_profile_id: string } | undefined;
      throw new ActiveSlotConflict({
        account: profile.accountId ?? "",
        brand: profile.brand ?? "",
        existingProfileId: slot?.search_profile_id ?? "unknown",
      });
    }
    throw err;
  }

  return { profile, auditId };
}

// ---------------------------------------------------------------------------
// resolve — three-branch (delegates to resolver.ts, §9)
// ---------------------------------------------------------------------------

/** Three-branch resolve (§9); intake itself is exempt (it creates the profile). */
export function resolveActive(db: Db, args: { threadPin?: string } = {}): ResolveResult {
  return resolveActiveProfile(db, args);
}

// ---------------------------------------------------------------------------
// lifecycle — minimal-but-real (§9.4). intake needs the typo-window update +
// identity-lock error surface; replace/close/restore signatures are fixed now.
// ---------------------------------------------------------------------------

const SELECT_FIRST_LEAD =
  "SELECT 1 FROM lead_submissions WHERE search_profile_id = ? LIMIT 1";
const UPDATE_FIELD =
  "UPDATE search_profiles SET %COL% = ?, updated_at = CURRENT_TIMESTAMP " +
  "WHERE search_profile_id = ?";
const SET_STATUS =
  "UPDATE search_profiles SET status = ?, updated_at = CURRENT_TIMESTAMP " +
  "WHERE search_profile_id = ?";

/** core field name → db column for the small set update() may touch. */
const FIELD_TO_COLUMN: Record<string, string> = {
  year: "year", make: "make", model: "model", trim: "trim", location: "location",
  budgetMax: "budget_max", searchRadiusMiles: "search_radius_miles",
  followUpEmail: "follow_up_email", followUpPhone: "follow_up_phone",
  financingPreference: "financing_preference", tradeInDescription: "trade_in_description",
};

/** Identity fields lock once the first lead references the profile (§9.4). */
function identityLocked(db: Db, profileId: string): boolean {
  return db.$client.prepare(SELECT_FIRST_LEAD).get(profileId) !== undefined;
}

/**
 * In-place update within the typo window (§9.4). Editing an identity field
 * (year/make/model/trim/location) AFTER the first lead_submissions row throws
 * IdentityLockedError — the user must replace() or cancel. Returns the updated
 * profile.
 */
export function update(
  db: Db,
  patch: Partial<SearchProfile>,
  opts: { profileId: string },
): SearchProfile {
  const touchedIdentity = (IDENTITY_FIELDS as readonly string[]).filter(
    (f) => f in patch,
  );
  if (touchedIdentity.length > 0 && identityLocked(db, opts.profileId)) {
    throw new IdentityLockedError(touchedIdentity);
  }
  const txn = db.$client.transaction(() => {
    for (const [field, value] of Object.entries(patch)) {
      const col = FIELD_TO_COLUMN[field];
      if (col === undefined) continue; // ignore non-updatable fields (id/status/…).
      // Skip an explicitly-undefined patch value: better-sqlite3 throws on an
      // undefined bind, and an absent edit must be a no-op, not an error.
      if (value === undefined) continue;
      db.$client.prepare(UPDATE_FIELD.replace("%COL%", col)).run(value, opts.profileId);
    }
  });
  txn();
  const row = db.$client.prepare(SELECT_BY_ID).get(opts.profileId) as SearchProfileRow | undefined;
  if (row === undefined) {
    throw new Error(`update: profile ${opts.profileId} not found`);
  }
  return rowToProfile(row);
}

/**
 * Close a profile (status → 'closed'). Frees the active (account, brand) slot.
 */
export function close(db: Db, id: string): void {
  db.$client.prepare(SET_STATUS).run("closed", id);
}

/**
 * Restore a closed/superseded profile to 'active'. If the (account, brand) slot
 * is taken → ActiveSlotConflict (§8.1, restore note).
 */
export function restore(db: Db, id: string): SearchProfile {
  const row = db.$client.prepare(SELECT_BY_ID).get(id) as SearchProfileRow | undefined;
  if (row === undefined) throw new Error(`restore: profile ${id} not found`);
  try {
    db.$client.prepare(SET_STATUS).run("active", id);
  } catch (err) {
    if (isUniqueConstraint(err)) {
      const slot = db.$client
        .prepare(SELECT_ACTIVE_FOR_SLOT)
        .get(row.brand, row.account_id) as { search_profile_id: string } | undefined;
      throw new ActiveSlotConflict({
        account: row.account_id ?? "",
        brand: row.brand ?? "",
        existingProfileId: slot?.search_profile_id ?? "unknown",
      });
    }
    throw err;
  }
  const updated = db.$client.prepare(SELECT_BY_ID).get(id) as SearchProfileRow;
  return rowToProfile(updated);
}

/**
 * Replace: supersede the old profile and create a new active successor, writing
 * audit_log action 'profile_replace' (§9.4). M1 only needs the SIGNATURE +
 * audit action fixed; the full successor-creation belongs to a downstream skill.
 * Implemented minimally here: supersede old → create new → link → audit.
 *
 * ATOMIC (FIX 1): the supersede → create → link → audit sequence runs in ONE
 * db.$client.transaction, so a throw mid-way (e.g. create() rejects) rolls back
 * the SET_STATUS 'superseded' — the old profile stays 'active', zero new rows,
 * zero audit. (better-sqlite3 nests the create()-internal transaction via a
 * savepoint, so the single outer transaction is safe.)
 */
export function replace(
  db: Db,
  oldId: string,
  input: SearchProfileIntakeInput,
  opts: { reason: string; actor: string; coordinates: ResolvedCoordinates; rng?: Rng },
): CreateResult {
  const oldRow = db.$client.prepare(SELECT_BY_ID).get(oldId) as SearchProfileRow | undefined;
  if (oldRow === undefined) throw new Error(`replace: profile ${oldId} not found`);

  const txn = db.$client.transaction((): CreateResult => {
    // Supersede the old row first so the active slot frees before the successor.
    db.$client.prepare(SET_STATUS).run("superseded", oldId);
    const created = create(db, input, {
      actor: opts.actor,
      reason: opts.reason,
      coordinates: opts.coordinates,
      ...(opts.rng !== undefined ? { rng: opts.rng } : {}),
    });
    db.$client
      .prepare("UPDATE search_profiles SET superseded_by = ? WHERE search_profile_id = ?")
      .run(created.profile.id, oldId);
    writeAuditLog(db, {
      action: AUDIT_ACTIONS.profileReplace,
      actor: opts.actor,
      targetTable: "search_profiles",
      targetId: created.profile.id,
      searchProfileId: created.profile.id,
      reason: opts.reason,
      oldValue: oldId,
      newValue: created.profile.id,
    });
    return created;
  });

  return txn();
}
