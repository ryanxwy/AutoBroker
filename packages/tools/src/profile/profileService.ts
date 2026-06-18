/**
 * profileService — the ONLY write path for search_profiles + audit_log.
 * Migrates the legacy services/profile.py + search_profile_intake.py + intake.py
 * responsibilities into TS closures over the @autobroker/db handle.
 *
 * SQLITE INVARIANT: only packages/tools (and db beneath it) touch the product
 * DB. Routes / workflows / model delegate down here; they never open the
 * connection. Raw better-sqlite3 statements via db.$client — NO drizzle-orm
 * import (dependency-cruiser sqlite-only-in-db, severity error).
 *
 * PERSIST DISCIPLINE (coordinate-resolution invariant):
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
 *   - lat/lng REQUIRED at create (coordinate-resolution invariant): NULL coords
 *     throw CoordinatesNotResolvedError — the service is the LAST WALL; upstream
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
// pure validate (no DB) : validate_intake_payload parity
// ---------------------------------------------------------------------------

/** Result of the pure validate pass. */
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
// location parsing — local regex; coords come from upstream goplaces
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
 * Local-regex parse of a location_query (legacy parity: profile.py:43). Handles
 * a bare 5(+4) ZIP and the "City, ST ZIP" form. Coordinates are NOT computed
 * here — the workflow's goplaces step resolves lat/lng before create
 * (coordinate-resolution invariant).
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

// Pull the 2-letter US state out of a Google-style formatted address tail,
// e.g. "Seattle, WA 98101, USA" -> "WA". The geocoder reliably carries the
// state here even when the user's typed query omits it ("Seattle 98101"), so
// this is preferred over parseLocation's typed-query parse when persisting the
// state column (otherwise state-keyed audits like DOC_FEE_CAP silently skip).
const STATE_FROM_FORMATTED = /,\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/;
export function stateFromFormattedAddress(addr: string | null | undefined): string | null {
  if (!addr) return null;
  const m = STATE_FROM_FORMATTED.exec(addr);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------
// synth id — deterministic, double-fire safe
// ---------------------------------------------------------------------------

/** SHA-256 first-16-hex of make|model|trim|year|postal_code. Trim and postal
 *  default to empty string so the hash is stable for a fixed input. */
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
 * Resolved geo the workflow MUST supply at create (coordinate-resolution
 * invariant). The service rejects NULL lat/lng; resolvedAddress is optional echo
 * from goplaces. `postalCode` is
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
  /** Resolved coordinates (required; NULL is rejected). */
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

/** The sole accounts row's id, or null when 0 or 2+ exist (do not guess). */
function resolveSoleAccountId(db: Db): string | null {
  const rows = db.$client.prepare(SELECT_SOLE_ACCOUNT).all() as { account_id: string }[];
  return rows.length === 1 ? rows[0]!.account_id : null;
}

/** Build the validated SearchProfile from intake input + resolved coords +
 *  defaults. The synth id is computed inside (postal_code in the hash). */
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
    // Default to a WIDE 125mi radius when the buyer doesn't specify one: a new-car
    // shopper casts a wide net (dealers ship/trade across a metro), and the live
    // 巡检 searches whole metros. An explicit smaller radius still wins.
    searchRadiusMiles: input.search_radius_miles ?? 125,
    locationQuery: input.location_query,
    resolvedAddress: coords.resolvedAddress ?? null,
    city: loc.city,
    // Prefer the state parsed from the GEOCODED formatted address over the
    // typed-query parse: a query like "Seattle 98101" (no state abbreviation)
    // leaves loc.state null, but the resolved address ("Seattle, WA 98101, USA")
    // carries it. Without this, state="" and DOC_FEE_CAP/state-keyed audits
    // never fire even in capped states (WA/CA/NY).
    state: stateFromFormattedAddress(coords.resolvedAddress) ?? loc.state,
    // Prefer the GEOCODED postal (coords.postalCode) over the locally-parsed one
    // — same precedence as synthPostal above. Without this a location_query that
    // carries no zip (but geocodes to one) persisted a blank postal_code, which
    // then broke incentive_scrape (missing_zip) and the incentive/audit reads
    // that join on postal_code.
    postalCode: coords.postalCode ?? loc.postalCode,
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
    brand: input.make, // brand = make (active-uniqueness key).
    location: input.location_query, // location = location_query.
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
 * idempotently. The full pipeline: form .strict() validate → persist
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

  // (2) Persist parity-minimum hard floor: year/make/model.
  const lc = validate(parsed);
  if (!lc.ok) {
    const missing = ["make", "model", "year"].filter((f) =>
      lc.errors.some((e) => e.startsWith(f)),
    );
    throw new MissingRequiredFieldError(missing);
  }

  // (3) Build the row (location parse + synth id + defaults + fake phone).
  const profile = buildProfile(db, parsed, opts.coordinates, opts.rng);

  // (4) Coordinate guard — the LAST WALL. NULL coords never reach DB.
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
// resolve — three-branch (delegates to resolver.ts)
// ---------------------------------------------------------------------------

/** Three-branch resolve; intake itself is exempt (it creates the profile). */
export function resolveActive(db: Db, args: { threadPin?: string } = {}): ResolveResult {
  return resolveActiveProfile(db, args);
}

// ---------------------------------------------------------------------------
// read views — snake_case row reads for the HTTP profile views. The SQL lives
// here so the app layer never composes SQL itself.
// ---------------------------------------------------------------------------

/** Read one profile row by id as the raw snake_case view. Returns null when absent. */
export function readProfileRow(db: Db, id: string): Record<string, unknown> | null {
  const row = db.$client
    .prepare("SELECT * FROM search_profiles WHERE search_profile_id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ?? null;
}

/**
 * List profile rows (snake_case views), newest-first by ROWID (matching the
 * resolver's ROWID DESC ordering). 'active' filters status='active' OR NULL
 * (implicit-active, matching the resolver); 'closed' filters status='closed'
 * (the soft-deleted set the Closed-searches group restores from); any other
 * value returns all rows.
 */
export function listProfileRows(db: Db, status: string | undefined): Record<string, unknown>[] {
  let sql = "SELECT * FROM search_profiles";
  if (status === "active") {
    sql += " WHERE status = 'active' OR status IS NULL";
  } else if (status === "closed") {
    sql += " WHERE status = 'closed'";
  }
  sql += " ORDER BY rowid DESC";
  return db.$client.prepare(sql).all() as Record<string, unknown>[];
}

/**
 * List the dealer rows bound to one profile (dealers joined through
 * profile_dealers), nearest-first with unknown distances last. Read-only
 * snake_case rows for the HTTP dealers view; `candidate_status`/`bound_at`
 * carry the per-profile binding state alongside the dealer columns.
 * `lead_submission_count` is the per-(profile,dealer) count of SUBMITTED leads so
 * the dealers surface can show a "lead submitted" signal (a submitted lead writes
 * a lead_submissions row but does NOT mutate profile_dealers.status).
 */
export function listProfileDealerRows(db: Db, profileId: string): Record<string, unknown>[] {
  return db.$client
    .prepare(
      "SELECT d.*, pd.status AS candidate_status, pd.bound_at, " +
        "SUM(CASE WHEN ls.outcome = 'submitted' THEN 1 ELSE 0 END) AS lead_submission_count " +
        "FROM profile_dealers pd JOIN dealers d ON d.dealer_id = pd.dealer_id " +
        "LEFT JOIN lead_submissions ls ON ls.dealer_id = d.dealer_id " +
        "AND ls.search_profile_id = pd.search_profile_id " +
        "WHERE pd.search_profile_id = ? " +
        "GROUP BY d.dealer_id " +
        "ORDER BY d.distance_miles IS NULL, d.distance_miles",
    )
    .all(profileId) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// lifecycle — minimal-but-real. update() is the preference write-through
// (identity is frozen at confirm); replace/close/restore signatures are fixed.
// ---------------------------------------------------------------------------

const UPDATE_FIELD =
  "UPDATE search_profiles SET %COL% = ?, updated_at = CURRENT_TIMESTAMP " +
  "WHERE search_profile_id = ?";
const SET_STATUS =
  "UPDATE search_profiles SET status = ?, updated_at = CURRENT_TIMESTAMP " +
  "WHERE search_profile_id = ?";

/** core field name → db column for the PREFERENCE set update() may touch.
 *  Identity fields (year/make/model/trim/location) are deliberately absent:
 *  they freeze at confirm — an identity edit means replace(), never update(). */
const FIELD_TO_COLUMN: Record<string, string> = {
  budgetMax: "budget_max", searchRadiusMiles: "search_radius_miles",
  followUpEmail: "follow_up_email", followUpPhone: "follow_up_phone",
  financingPreference: "financing_preference", tradeInDescription: "trade_in_description",
  preferredExteriorColorsJson: "preferred_exterior_colors_json",
  preferredInteriorColorsJson: "preferred_interior_colors_json",
  acceptableTrimsJson: "acceptable_trims_json",
  featurePreferencesJson: "feature_preferences_json",
};

/**
 * In-place PREFERENCE update. Identity fields (year/make/model/trim/location)
 * freeze the moment the profile is confirmed: any identity field in the patch
 * throws IdentityLockedError unconditionally — confirm freezes identity; the
 * user must replace() or cancel. Returns the updated profile.
 */
export function update(
  db: Db,
  patch: Partial<SearchProfile>,
  opts: { profileId: string },
): SearchProfile {
  const touchedIdentity = (IDENTITY_FIELDS as readonly string[]).filter(
    (f) => f in patch,
  );
  if (touchedIdentity.length > 0) {
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
 * Soft-delete a profile (status → 'closed'). Frees the active (account, brand)
 * slot and writes a 'profile_close' audit row in the SAME transaction as the
 * status flip. The data is kept — restore() returns it to active.
 *
 * Returns false when no such profile row exists (the route maps that to 404);
 * true on a successful close.
 */
export function close(db: Db, id: string, opts: { actor?: string; reason?: string } = {}): boolean {
  const existing = db.$client.prepare(SELECT_BY_ID).get(id) as SearchProfileRow | undefined;
  if (existing === undefined) return false;

  const txn = db.$client.transaction(() => {
    db.$client.prepare(SET_STATUS).run("closed", id);
    writeAuditLog(db, {
      action: AUDIT_ACTIONS.profileClose,
      actor: opts.actor ?? null,
      targetTable: "search_profiles",
      targetId: id,
      searchProfileId: id,
      reason: opts.reason ?? null,
      oldValue: typeof existing.status === "string" ? existing.status : null,
      newValue: "closed",
    });
  });
  txn();
  return true;
}

/**
 * Restore a closed/superseded profile to 'active', writing a 'profile_restore'
 * audit row in the SAME transaction. If the (account, brand) slot is taken →
 * ActiveSlotConflict (the UI offers replace/remove-the-other).
 */
export function restore(db: Db, id: string, opts: { actor?: string; reason?: string } = {}): SearchProfile {
  const row = db.$client.prepare(SELECT_BY_ID).get(id) as SearchProfileRow | undefined;
  if (row === undefined) throw new Error(`restore: profile ${id} not found`);
  const txn = db.$client.transaction(() => {
    db.$client.prepare(SET_STATUS).run("active", id);
    writeAuditLog(db, {
      action: AUDIT_ACTIONS.profileRestore,
      actor: opts.actor ?? null,
      targetTable: "search_profiles",
      targetId: id,
      searchProfileId: id,
      reason: opts.reason ?? null,
      oldValue: typeof row.status === "string" ? row.status : null,
      newValue: "active",
    });
  });
  try {
    txn();
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

// ---------------------------------------------------------------------------
// purge — the HARD-DELETE (irreversible). Distinct from close() (soft-delete,
// restorable): purge() erases every local row scoped to the profile.
// ---------------------------------------------------------------------------

/**
 * Every product table that carries a `search_profile_id` — the full set a hard
 * purge erases. These names are a FIXED in-code allowlist (never user input), so
 * interpolating them into the DELETE statement is injection-safe. Order does not
 * matter: purge() defers FK checks to commit. Shared entities (e.g. `dealers`)
 * are deliberately ABSENT — only the per-profile binding `profile_dealers` is
 * profile-scoped. `audit_log` is included so the prior trail is erased; purge()
 * then writes ONE tombstone row recording the erase.
 */
const PROFILE_SCOPED_TABLES = [
  "audit_log",
  "dealer_contacts",
  "dealer_inventory_sources",
  "dealer_quotes",
  "inventory_listings",
  "lead_submissions",
  "message_analysis",
  "message_claims",
  "message_questions",
  "messages",
  "offers",
  "pipeline_state",
  "profile_dealers",
  "quote_audits",
  "skill_runs",
  "thread_routing",
  "thread_suppression",
  "threads",
  "fake_mailbox_messages",
  "fake_mailbox_threads",
] as const;

/**
 * Attachment children that DON'T carry a `search_profile_id` of their own — they
 * reference their parent message by FK (ON DELETE no action). The profile-scoped
 * parent delete (messages / fake_mailbox_messages) would orphan them; with FK
 * checks deferred to commit that orphan is a commit-time violation that rolls the
 * whole purge back. So delete them by their PARENT's profile scope. (table +
 * parent are a FIXED in-code allowlist — not user input — so interpolation is
 * injection-safe.) */
const ATTACHMENT_CHILD_TABLES = [
  { table: "message_attachments", parent: "messages" },
  { table: "fake_mailbox_attachments", parent: "fake_mailbox_messages" },
] as const;

const UNPIN_SESSIONS =
  "UPDATE sessions SET pinned_profile_id = NULL WHERE pinned_profile_id = ?";
const DELETE_PROFILE_ROW = "DELETE FROM search_profiles WHERE search_profile_id = ?";

export interface PurgeResult {
  /** false → no such profile row existed (the route maps that to 404). */
  deleted: boolean;
  /** Per-table row counts erased (only tables that had ≥1 row), plus the
   *  `sessions_unpinned` count — the payload of the tombstone audit row. */
  counts: Record<string, number>;
}

/**
 * HARD-DELETE a profile and every local row scoped to it — IRREVERSIBLE, no
 * restore (the dashboard fronts this with an explicit confirm modal; close() is
 * the recoverable path). Deletes each profile-scoped product table by
 * search_profile_id, unbinds any session pinned to it, drops the search_profiles
 * row, then writes ONE 'profile_purge' tombstone audit row carrying the per-table
 * delete counts.
 *
 * The whole erase runs in a SINGLE transaction with PRAGMA defer_foreign_keys=ON
 * so the inter-table FKs (messages→threads, offers→dealer_quotes, …) are checked
 * only at commit — delete order is then irrelevant and the committed state is
 * consistent. Shared entities (dealers) are untouched; only this profile's
 * binding/child rows go. Returns deleted=false when no such profile exists.
 */
export function purge(
  db: Db,
  id: string,
  opts: { actor?: string; reason?: string } = {},
): PurgeResult {
  const existing = db.$client.prepare(SELECT_BY_ID).get(id) as SearchProfileRow | undefined;
  if (existing === undefined) return { deleted: false, counts: {} };

  const counts: Record<string, number> = {};
  const txn = db.$client.transaction(() => {
    // Defer FK enforcement (openDb runs PRAGMA foreign_keys=ON) to commit so the
    // cross-table delete order is irrelevant; the committed state is consistent.
    db.$client.pragma("defer_foreign_keys = ON");
    // Tolerate a partial-migration DB: a fixture that hand-applied only migration
    // 0000 lacks the 0002 fake_mailbox_* tables (boot's ensureProductSchema skips
    // the migrator when search_profiles already exists). Skip any absent table —
    // a production DB always has the full set, a fixture only what it applied.
    const present = new Set(
      (
        db.$client
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((r) => r.name),
    );
    // Attachment children first (by their parent's profile scope) so the
    // parent-message delete below doesn't orphan an attachment → commit-time FK
    // violation → rollback. (Common case: a dealer reply with a PDF quote.)
    for (const { table, parent } of ATTACHMENT_CHILD_TABLES) {
      if (!present.has(table) || !present.has(parent)) continue;
      const res = db.$client
        .prepare(
          `DELETE FROM ${table} WHERE message_id IN (SELECT message_id FROM ${parent} WHERE search_profile_id = ?)`,
        )
        .run(id);
      if (res.changes > 0) counts[table] = res.changes;
    }
    for (const table of PROFILE_SCOPED_TABLES) {
      if (!present.has(table)) continue;
      // table is a fixed in-code allowlist entry (see PROFILE_SCOPED_TABLES) —
      // not user input — so the interpolation is injection-safe.
      const res = db.$client
        .prepare(`DELETE FROM ${table} WHERE search_profile_id = ?`)
        .run(id);
      if (res.changes > 0) counts[table] = res.changes;
    }
    // Unbind any session pinned to this profile (sessions.pinned_profile_id FK).
    if (present.has("sessions")) {
      const unpinned = db.$client.prepare(UNPIN_SESSIONS).run(id);
      if (unpinned.changes > 0) counts["sessions_unpinned"] = unpinned.changes;
    }
    // Drop the profile row itself.
    db.$client.prepare(DELETE_PROFILE_ROW).run(id);
    // The tombstone — the ONLY audit_log row left for this id (the prior trail
    // was erased above). Records the erase + per-table counts for forensics.
    writeAuditLog(db, {
      action: AUDIT_ACTIONS.profilePurge,
      actor: opts.actor ?? null,
      targetTable: "search_profiles",
      targetId: id,
      searchProfileId: id,
      reason: opts.reason ?? null,
      oldValue: typeof existing.status === "string" ? existing.status : null,
      newValue: "purged",
      payloadJson: JSON.stringify(counts),
    });
  });
  txn();
  return { deleted: true, counts };
}

/**
 * Replace: supersede the old profile and create a new active successor, writing
 * audit_log action 'profile_replace'. Intake only needs the SIGNATURE + audit
 * action fixed; the full successor-creation belongs to a downstream skill.
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
