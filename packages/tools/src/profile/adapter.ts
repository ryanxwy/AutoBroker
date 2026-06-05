/**
 * core↔db row adapter for search_profiles — the camelCase SearchProfile (core,
 * BACKEND_SERVICES §10.2) ↔ snake_case search_profiles row (db schema.ts:45).
 *
 * WHY HERE, NOT IN core: core cannot import @autobroker/db (five-layer wall —
 * dependency-cruiser `core-imports-nothing-internal`). The row shape is a db
 * concern; the adapter is the tools-layer bridge between the two. core exports
 * only the Zod type; this file owns the column↔field translation.
 *
 * DISCIPLINE:
 *   - Pure functions, no I/O. Zod-validated on the way IN from the DB
 *     (rowToProfile re-parses through SearchProfileSchema so a malformed oracle
 *     row fails LOUD rather than flowing on as a half-typed object).
 *   - SQLite stores int-booleans (military_first_responder / current_brand_owner)
 *     and there is NO Drizzle ORM import in this layer (sqlite-only-in-db rule),
 *     so the adapter consumes/produces plain better-sqlite3 row objects (the
 *     snake_case `search_profiles` shape) — NOT a drizzle model instance.
 *   - The `location_query` (raw user text) vs `location` (v2 origin label)
 *     disambiguation is preserved: two distinct columns → two distinct fields.
 *
 * This is NOT the persist path — profileService.create owns the INSERT. The
 * adapter is the value translation only.
 */

import { SearchProfileSchema, type SearchProfile } from "@autobroker/core";

/**
 * The raw snake_case `search_profiles` row as better-sqlite3 returns it. SQLite
 * column affinities: TEXT → string, INTEGER/REAL → number, NULL → null. The
 * int-boolean columns come back as 0|1 numbers.
 */
export interface SearchProfileRow {
  search_profile_id: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  budget_max: number | null;
  search_radius_miles: number | null;
  location_query: string | null;
  resolved_address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  follow_up_email: string | null;
  follow_up_phone: string | null;
  phone_policy: string | null;
  fake_phone: string | null;
  financing_preference: string | null;
  trade_in_description: string | null;
  military_first_responder: number | null;
  current_brand_owner: number | null;
  preferred_exterior_colors_json: string | null;
  preferred_interior_colors_json: string | null;
  acceptable_trims_json: string | null;
  feature_preferences_json: string | null;
  account_id: string | null;
  brand: string | null;
  location: string | null;
  status: string | null;
  superseded_by: string | null;
  updated_at: string | null;
}

/**
 * db row → core SearchProfile. Zod-validated: a row that does not satisfy the
 * 33-column contract (bad enum, non-int year, …) throws here — fail LOUD, never
 * pass a half-typed profile downstream.
 */
export function rowToProfile(row: SearchProfileRow): SearchProfile {
  return SearchProfileSchema.parse({
    id: row.search_profile_id,
    year: row.year,
    make: row.make,
    model: row.model,
    trim: row.trim,
    budgetMax: row.budget_max,
    searchRadiusMiles: row.search_radius_miles,
    locationQuery: row.location_query,
    resolvedAddress: row.resolved_address,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    country: row.country,
    latitude: row.latitude,
    longitude: row.longitude,
    followUpEmail: row.follow_up_email,
    followUpPhone: row.follow_up_phone,
    phonePolicy: row.phone_policy,
    fakePhone: row.fake_phone,
    financingPreference: row.financing_preference,
    tradeInDescription: row.trade_in_description,
    militaryFirstResponder: row.military_first_responder,
    currentBrandOwner: row.current_brand_owner,
    preferredExteriorColorsJson: row.preferred_exterior_colors_json,
    preferredInteriorColorsJson: row.preferred_interior_colors_json,
    acceptableTrimsJson: row.acceptable_trims_json,
    featurePreferencesJson: row.feature_preferences_json,
    accountId: row.account_id,
    brand: row.brand,
    location: row.location,
    status: row.status,
    supersededBy: row.superseded_by,
    updatedAt: row.updated_at,
  });
}

/**
 * core SearchProfile → db row. Pure value mapping (no validation — the caller
 * built the profile from validated input). Used by profileService.create to
 * produce the INSERT binding object.
 */
export function profileToRow(profile: SearchProfile): SearchProfileRow {
  return {
    search_profile_id: profile.id,
    year: profile.year,
    make: profile.make,
    model: profile.model,
    trim: profile.trim,
    budget_max: profile.budgetMax,
    search_radius_miles: profile.searchRadiusMiles,
    location_query: profile.locationQuery,
    resolved_address: profile.resolvedAddress,
    city: profile.city,
    state: profile.state,
    postal_code: profile.postalCode,
    country: profile.country,
    latitude: profile.latitude,
    longitude: profile.longitude,
    follow_up_email: profile.followUpEmail,
    follow_up_phone: profile.followUpPhone,
    phone_policy: profile.phonePolicy,
    fake_phone: profile.fakePhone,
    financing_preference: profile.financingPreference,
    trade_in_description: profile.tradeInDescription,
    military_first_responder: profile.militaryFirstResponder,
    current_brand_owner: profile.currentBrandOwner,
    preferred_exterior_colors_json: profile.preferredExteriorColorsJson,
    preferred_interior_colors_json: profile.preferredInteriorColorsJson,
    acceptable_trims_json: profile.acceptableTrimsJson,
    feature_preferences_json: profile.featurePreferencesJson,
    account_id: profile.accountId,
    brand: profile.brand,
    location: profile.location,
    status: profile.status,
    superseded_by: profile.supersededBy,
    updated_at: profile.updatedAt,
  };
}
