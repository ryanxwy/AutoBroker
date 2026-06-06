/**
 * SearchProfile — one new-car search for an (account, brand); the camelCase
 * Zod mirror of all 33 `search_profiles` columns (snake_case column names are on
 * each field's drizzle definition in packages/db/src/schema.ts). nullable()
 * mirrors a column with no NOT NULL; non-null DB columns stay required
 * (year/make/model); the PK is `id`. There is NO created_at column —
 * newest-active is resolved by ROWID DESC in the tools-layer resolver, not a
 * timestamp here.
 *
 * The db column `status` has NO CHECK constraint (only the partial unique index
 * `uq_search_profiles_active_account_brand … WHERE status = 'active'` references
 * it). The enum below is the product vocabulary, not a DB-enforced domain — a
 * row read from the database may carry a NULL status, so the field is
 * `.nullable()`.
 *
 * Invariants this contract underpins (see the safety invariants in CLAUDE.md):
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
 * wall). The adapter lands in packages/tools. This package exports the
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

/** Fake by default; real only on explicit opt-in (see CLAUDE.md). */
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
    /** Resolved coordinates — coordinate-resolution invariant: coordinates must
     *  be resolved before persist (never NULL-coord-to-DB on geocode failure;
     *  geocode failure suspends, never silently passes). The row shape still
     *  allows null because the DB column is nullable for legacy rows. */
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
