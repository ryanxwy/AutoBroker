/**
 * SearchProfileIntakeInputSchema (18 intake-form fields) + INTAKE_FIELD_META.
 *
 * This is the SINGLE SOURCE of the intake field set + UI metadata. The Zod
 * schema IS the source of truth and `INTAKE_FIELD_META` is exported for UI to
 * import directly — no codegen step.
 *
 * REQUIRED set (form contract): exactly
 *   { make, model, year, location_query, follow_up_email, financing_preference }.
 * The UI forces the user to fill these 6; the service-persist parity-minimum
 * (year/make/model) is enforced separately in the tools layer — NOT here.
 * Required fields are non-nullable; the other 12 are `.nullable()` (collected,
 * may be empty).
 *
 * Schema DECLARATION order is required-first for error surfacing (the 6 required
 * fields parse/report before the 12 nullable ones). The canonical UI RENDER
 * order = INTAKE_FIELD_META key order, the frozen 18-field order below.
 *
 * 18-field CANONICAL ORDER (frozen — the UI renders in this order;
 * INTAKE_FIELD_META keys are EXACTLY this): make, model, trim, year,
 * location_query, search_radius_miles, budget_max, follow_up_email,
 * follow_up_phone, phone_policy, preferred_exterior_colors_json,
 * preferred_interior_colors_json, acceptable_trims_json, feature_preferences_json,
 * financing_preference, trade_in_description, military_first_responder,
 * current_brand_owner.
 *
 * budget_max is COLLECTED (optional section) but sensitivity = 'internal_only':
 * it never enters dealer-facing output (budget red-line, _redact_budget enforced
 * in code — see CLAUDE.md). The META marks it so derived redaction sets can key
 * off it.
 *
 * Field names here are snake_case (form/wire names matching the DB columns); the
 * core↔db row adapter (camelCase SearchProfile ↔ snake_case row) lands in
 * packages/tools. core cannot import db (five-layer wall).
 *
 * This file MUST NOT import any framework. Pure types + Zod only.
 */

import { z } from "zod";
import {
  FinancingPreferenceSchema,
  IntBoolSchema,
  PhonePolicySchema,
} from "./searchProfile.js";

export const SearchProfileIntakeInputSchema = z
  .object({
    // --- required (form contract: 6 fields) ----------------------------------
    make: z.string().min(1),
    model: z.string().min(1),
    /** Required. New-cars-only year gate (canon guardrail): current or next
     *  model year, enforced server-side here — the form's year-segmented widget
     *  mirrors it client-side. */
    year: z
      .number()
      .int()
      .refine(
        (y) => {
          const current = new Date().getFullYear();
          return y === current || y === current + 1;
        },
        { message: "year must be the current or next model year (new cars only)" },
      ),
    /** Raw location text; the workflow layer geocodes this before persist
     *  (coordinate-resolution invariant: on parse/no-result/retry-exhausted →
     *  suspend back to form, never persist NULL coords). Required at the form. */
    location_query: z.string().min(1),
    /** PII; reply-to address. Required at the form. */
    follow_up_email: z.string().min(1),
    /** Required at the form; 'undecided' (skipped/unsure) → dual finance+lease. */
    financing_preference: FinancingPreferenceSchema,

    // --- optional / buyer context (12 fields, nullable) ----------------------
    trim: z.string().nullable(),
    /** Bounded HERE only (form lane; the partial patch schema inherits it).
     *  The LLM prefill emit schema stays unbounded on purpose: an out-of-range
     *  spoken radius must stay a recoverable prefill, never a thrown
     *  zod_validation failure. */
    search_radius_miles: z.number().int().min(1).max(500).nullable(),
    /** INTERNAL-ONLY: collected, never dealer-facing (_redact_budget). */
    budget_max: z.number().nullable(),
    /** PII. */
    follow_up_phone: z.string().nullable(),
    phone_policy: PhonePolicySchema.nullable(),
    preferred_exterior_colors_json: z.string().nullable(),
    preferred_interior_colors_json: z.string().nullable(),
    acceptable_trims_json: z.string().nullable(),
    feature_preferences_json: z.string().nullable(),
    /** PII. */
    trade_in_description: z.string().nullable(),
    military_first_responder: IntBoolSchema.nullable(),
    current_brand_owner: IntBoolSchema.nullable(),
  })
  .strict()
  .describe("18-field intake form contract; .strict() back-validates the form decision.");

export type SearchProfileIntakeInput = z.infer<typeof SearchProfileIntakeInputSchema>;

/** The 18 intake field names (schema keys). The frozen UI render order is the
 *  INTAKE_FIELD_META key order, not this type's declaration order. */
export type IntakeFieldName = keyof SearchProfileIntakeInput;

/** Where a field renders: the two form sections. */
export type IntakeSection = "Car & contact" | "Optional / Buyer context";

/**
 * Field sensitivity.
 *   - 'internal_only' → never leaves the app (budget_max).
 *   - 'pii'           → strip from drafts/localStorage before persist.
 *   - 'normal'        → freely usable.
 */
export type IntakeFieldSensitivity = "normal" | "pii" | "internal_only";

export interface IntakeFieldMeta {
  /** Human label (中文) for the form. */
  label: string;
  /** Whether the form forces this field (the 6-field required set). */
  required: boolean;
  sensitivity: IntakeFieldSensitivity;
  section: IntakeSection;
}

const CAR_CONTACT: IntakeSection = "Car & contact";
const BUYER_CONTEXT: IntakeSection = "Optional / Buyer context";

/**
 * Per-field UI metadata, exported for DIRECT UI import. Keys are EXACTLY the 18
 * field names in the frozen canonical UI RENDER order (NOT the schema's
 * required-first declaration order); a structural drift test asserts this
 * against the ordered list. `section` groups fields into the required Car &
 * contact section and the collapsed Optional / Buyer context section.
 */
export const INTAKE_FIELD_META = {
  // --- "Car & contact" (required section) ----------------------------------
  make: { label: "品牌", required: true, sensitivity: "normal", section: CAR_CONTACT },
  model: { label: "车型", required: true, sensitivity: "normal", section: CAR_CONTACT },
  trim: { label: "配置", required: false, sensitivity: "normal", section: CAR_CONTACT },
  year: { label: "年款", required: true, sensitivity: "normal", section: CAR_CONTACT },
  location_query: { label: "所在地", required: true, sensitivity: "normal", section: CAR_CONTACT },
  search_radius_miles: { label: "搜索半径", required: false, sensitivity: "normal", section: CAR_CONTACT },
  budget_max: { label: "预算上限", required: false, sensitivity: "internal_only", section: BUYER_CONTEXT },
  follow_up_email: { label: "回复邮箱", required: true, sensitivity: "pii", section: CAR_CONTACT },
  follow_up_phone: { label: "回复电话", required: false, sensitivity: "pii", section: CAR_CONTACT },
  phone_policy: { label: "电话策略", required: false, sensitivity: "normal", section: CAR_CONTACT },
  // --- "Optional / Buyer context" ------------------------------------------
  preferred_exterior_colors_json: { label: "偏好外观颜色", required: false, sensitivity: "normal", section: BUYER_CONTEXT },
  preferred_interior_colors_json: { label: "偏好内饰颜色", required: false, sensitivity: "normal", section: BUYER_CONTEXT },
  acceptable_trims_json: { label: "可接受配置", required: false, sensitivity: "normal", section: BUYER_CONTEXT },
  feature_preferences_json: { label: "功能偏好", required: false, sensitivity: "normal", section: BUYER_CONTEXT },
  financing_preference: { label: "购车方式", required: true, sensitivity: "normal", section: CAR_CONTACT },
  trade_in_description: { label: "置换车描述", required: false, sensitivity: "pii", section: BUYER_CONTEXT },
  military_first_responder: { label: "军人/急救人员", required: false, sensitivity: "normal", section: BUYER_CONTEXT },
  current_brand_owner: { label: "现有品牌车主", required: false, sensitivity: "normal", section: BUYER_CONTEXT },
} as const satisfies Record<IntakeFieldName, IntakeFieldMeta>;

/** The 6 form-required field names, derived from INTAKE_FIELD_META. */
export const INTAKE_REQUIRED_FIELDS = (
  Object.keys(INTAKE_FIELD_META) as IntakeFieldName[]
).filter((name) => INTAKE_FIELD_META[name].required);

/** Fields that must never leave the app (budget_max). */
export const INTAKE_INTERNAL_ONLY_FIELDS = (
  Object.keys(INTAKE_FIELD_META) as IntakeFieldName[]
).filter((name) => INTAKE_FIELD_META[name].sensitivity === "internal_only");
