/**
 * SearchProfile — one new-car search for an (account, brand); the camelCase
 * Zod mirror of ALL 33 `search_profiles` columns (B1, BACKEND_SERVICES §10.2).
 *
 * COLUMN ↔ FIELD MAPPING (oracle snake_case `search_profiles` column → core
 * camelCase field; verified against packages/db/src/schema.ts + the committed
 * migration 0000_military_red_skull.sql, 2026-06-04). nullable() mirrors a
 * column with no NOT NULL; non-null DB columns stay required (year/make/model);
 * the PK is `id`. There is NO created_at column — newest-active is resolved by
 * ROWID DESC in the tools-layer resolver, not a timestamp here.
 *
 *    1. search_profile_id  PK NOT NULL  → id
 *    2. year               NOT NULL     → year
 *    3. make               NOT NULL     → make
 *    4. model              NOT NULL     → model
 *    5. trim               null         → trim
 *    6. budget_max         null  REAL   → budgetMax        (INTERNAL-ONLY; never dealer-facing)
 *    7. search_radius_miles null INT=25 → searchRadiusMiles
 *    8. location_query     null         → locationQuery    (raw user text; distinct from `location`)
 *    9. resolved_address   null         → resolvedAddress
 *   10. city               null         → city
 *   11. state              null         → state
 *   12. postal_code        null         → postalCode
 *   13. country            null  ='US'  → country
 *   14. latitude           null  REAL   → latitude
 *   15. longitude          null  REAL   → longitude
 *   16. follow_up_email    null  PII    → followUpEmail
 *   17. follow_up_phone    null  PII    → followUpPhone
 *   18. phone_policy       null  ='fake'→ phonePolicy      (enum fake|real)
 *   19. fake_phone         null         → fakePhone
 *   20. financing_preference null enum  → financingPreference (cash|finance|lease|undecided)
 *   21. trade_in_description null PII    → tradeInDescription
 *   22. military_first_responder null INT=0 → militaryFirstResponder (0|1)
 *   23. current_brand_owner null INT=0  → currentBrandOwner (0|1)
 *   24. preferred_exterior_colors_json null → preferredExteriorColorsJson (JSON-as-string)
 *   25. preferred_interior_colors_json null → preferredInteriorColorsJson (JSON-as-string)
 *   26. acceptable_trims_json null       → acceptableTrimsJson         (JSON-as-string)
 *   27. feature_preferences_json null    → featurePreferencesJson      (JSON-as-string)
 *   28. account_id         null         → accountId        (was `account` in the stub)
 *   29. brand              null         → brand            (= make; (account,brand) uniqueness key)
 *   30. location           null         → location         (was the ambiguous `location` stub field)
 *   31. status             null         → status           (enum active|superseded|closed)
 *   32. superseded_by      null         → supersededBy
 *   33. updated_at         null  NUMERIC→ updatedAt
 *
 * NB the db column `status` has NO CHECK constraint (verified: only the partial
 * unique index `uq_search_profiles_active_account_brand … WHERE status =
 * 'active'` references it). The enum below is the LLD/product vocabulary, not a
 * DB-enforced domain — a row read from the oracle may carry a NULL status, so
 * the field is `.nullable()`.
 *
 * Invariants this contract underpins (CLAUDE.md §6/§9, BACKEND_SERVICES §8–9):
 *   - New cars only.
 *   - One `active` profile per (account, brand) — enforced by the partial unique
 *     index, surfaced as a typed ActiveSlotConflict by the tools layer.
 *   - `budgetMax` is INTERNAL-ONLY and never enters dealer-facing communication
 *     (_redact_budget, enforced in code).
 *   - Fake phone by default (phonePolicy 'fake') unless the user opts in to real.
 *   - profile-ASK three-branch resolution + identity lock live in the
 *     tools/workflows resolver; this schema is just the row shape.
 *
 * The core↔db row adapter does NOT live here — core cannot import db (five-layer
 * wall). The adapter lands in packages/tools (B2). This package exports the
 * core-side pieces only: the type + schema.
 *
 * This file MUST NOT import any framework. Pure types + Zod only.
 */

import { z } from "zod";

export const SearchProfileStatusSchema = z.enum([
  "active",
  /** Superseded by a Replace after first outbound; kept for history. */
  "superseded",
  /** Closed out (e.g. before pipeline_reset / closeout). */
  "closed",
]);
export type SearchProfileStatus = z.infer<typeof SearchProfileStatusSchema>;

/** Fake by default; real only on explicit opt-in (CLAUDE.md §9). */
export const PhonePolicySchema = z.enum(["fake", "real"]);
export type PhonePolicy = z.infer<typeof PhonePolicySchema>;

/**
 * Financing world the buyer wants quoted. `undecided` (the intake default for a
 * skipped/unsure answer) makes downstream request finance + lease dual quotes.
 */
export const FinancingPreferenceSchema = z.enum([
  "cash",
  "finance",
  "lease",
  "undecided",
]);
export type FinancingPreference = z.infer<typeof FinancingPreferenceSchema>;

/** SQLite int boolean (0|1) — military_first_responder / current_brand_owner. */
export const IntBoolSchema = z.union([z.literal(0), z.literal(1)]);
export type IntBool = z.infer<typeof IntBoolSchema>;

export const SearchProfileSchema = z
  .object({
    // --- identity (PK + NOT NULL columns) ------------------------------------
    /** search_profile_id PK; TEXT synth = SHA-256 first-16-hex of
     *  make|model|trim|year|postal_code (deterministic, double-fire safe). */
    id: z.string().describe("Stable profile id (resolver returns this)."),
    year: z.number().int().describe("Model year; new cars only."),
    make: z.string(),
    model: z.string(),
    /** Trim must be present and LLM-verified at intake; null only mid-intake. */
    trim: z.string().nullable(),

    // --- budget (INTERNAL-ONLY — never dealer-facing) ------------------------
    budgetMax: z.number().nullable(),

    // --- location surface ----------------------------------------------------
    searchRadiusMiles: z.number().int().nullable(),
    /** Raw user-entered location text (distinct from the v2 `location` column). */
    locationQuery: z.string().nullable(),
    resolvedAddress: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    postalCode: z.string().nullable(),
    country: z.string().nullable(),
    /** Resolved coordinates — 裁定⑨: persist requires these resolved (never
     *  NULL-coord-to-DB on geocode failure); the row shape still allows null
     *  because the oracle column is nullable for legacy rows. */
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),

    // --- contact (PII) -------------------------------------------------------
    followUpEmail: z.string().nullable(),
    followUpPhone: z.string().nullable(),
    phonePolicy: PhonePolicySchema.nullable(),
    fakePhone: z.string().nullable(),

    // --- preferences ---------------------------------------------------------
    financingPreference: FinancingPreferenceSchema.nullable(),
    tradeInDescription: z.string().nullable(),
    militaryFirstResponder: IntBoolSchema.nullable(),
    currentBrandOwner: IntBoolSchema.nullable(),
    /** JSON-as-string blobs (parsed/serialized by higher layers). */
    preferredExteriorColorsJson: z.string().nullable(),
    preferredInteriorColorsJson: z.string().nullable(),
    acceptableTrimsJson: z.string().nullable(),
    featurePreferencesJson: z.string().nullable(),

    // --- account / lifecycle (v2 columns) ------------------------------------
    accountId: z.string().nullable(),
    /** Brand the search targets; (accountId, brand) is the active-uniqueness key. */
    brand: z.string().nullable(),
    /** v2 `location` column (origin label); kept distinct from `locationQuery`. */
    location: z.string().nullable(),
    /** No DB CHECK; a legacy row may carry NULL — hence nullable. */
    status: SearchProfileStatusSchema.nullable(),
    supersededBy: z.string().nullable(),
    /** TIMESTAMP text; there is NO created_at (newest resolved by ROWID DESC). */
    updatedAt: z.string().nullable(),
  })
  .strict()
  .describe("Full 33-column (account, brand) new-car search row; not the resolver.");

export type SearchProfile = z.infer<typeof SearchProfileSchema>;
