/**
 * formModel — pure form model for the schema-driven IntakeForm (FRONTEND_LAYOUT
 * §5.2-§5.4). Derives the ordered field list + sections from the single source
 * (core INTAKE_FIELD_META), maps each field to one of the 7 widgets, validates
 * per-field for instant feedback (the AUTHORITATIVE check is the server's
 * SearchProfileIntakeInputSchema.strict() on form-decision — this is UI sugar),
 * and serializes the form values into the form-decision `content` (empty optional
 * → null; required empty stays empty so the server rejects it).
 *
 * No framework below the app layer; imports core (field meta + enum schemas) only.
 */

import {
  FinancingPreferenceSchema,
  INTAKE_FIELD_META,
  PhonePolicySchema,
  type IntakeFieldMeta,
  type IntakeFieldName,
  type IntakeSection,
} from "@autobroker/core";

/** The 7 UI widgets (FRONTEND §5.2). The widget is derived here from the field's
 *  type + name (core's IntakeFieldMeta carries label/required/sensitivity/section
 *  but not the widget enum — the §5.1 widget map is a UI concern). */
export type Widget =
  | "text"
  | "number"
  | "email"
  | "tel"
  | "year-segmented"
  | "segmented"
  | "boolean-int";

/** The widget for a field (FRONTEND §5.1 widget map, verbatim). */
const WIDGET_BY_FIELD: Record<IntakeFieldName, Widget> = {
  make: "text",
  model: "text",
  trim: "text",
  year: "year-segmented",
  location_query: "text",
  search_radius_miles: "number",
  budget_max: "number",
  follow_up_email: "email",
  follow_up_phone: "tel",
  phone_policy: "segmented",
  preferred_exterior_colors_json: "text",
  preferred_interior_colors_json: "text",
  acceptable_trims_json: "text",
  feature_preferences_json: "text",
  financing_preference: "segmented",
  trade_in_description: "text",
  military_first_responder: "boolean-int",
  current_brand_owner: "boolean-int",
};

/** Per-field placeholder hints (FRONTEND §5.1; UI sugar only). */
const PLACEHOLDER_BY_FIELD: Partial<Record<IntakeFieldName, string>> = {
  make: "Hyundai",
  model: "Tucson Hybrid",
  trim: "Limited",
  location_query: "Irvine, CA 92614",
};

/** Enum option labels for the `segmented` widgets (FRONTEND §5.1 optionLabels). */
const ENUM_OPTIONS: Partial<Record<IntakeFieldName, { value: string; label: string }[]>> = {
  phone_policy: PhonePolicySchema.options.map((v) => ({
    value: v,
    label: v === "fake" ? "Use a fake number" : "Use my real number",
  })),
  financing_preference: FinancingPreferenceSchema.options.map((v) => ({
    value: v,
    label: v[0]!.toUpperCase() + v.slice(1),
  })),
};

/** The UI-resolved field descriptor the renderer consumes. */
export interface FieldDescriptor {
  name: IntakeFieldName;
  widget: Widget;
  meta: IntakeFieldMeta;
  placeholder: string | undefined;
  /** For `segmented` widgets: the enum option list. */
  options: { value: string; label: string }[] | undefined;
}

/** The frozen render order = INTAKE_FIELD_META key order (core owns it). */
export const INTAKE_FIELD_NAMES = Object.keys(INTAKE_FIELD_META) as IntakeFieldName[];

export function fieldDescriptor(name: IntakeFieldName): FieldDescriptor {
  const widget = WIDGET_BY_FIELD[name];
  return {
    name,
    widget,
    meta: INTAKE_FIELD_META[name],
    placeholder: PLACEHOLDER_BY_FIELD[name],
    options: widget === "segmented" ? ENUM_OPTIONS[name] : undefined,
  };
}

/** The two sections in render order, with their ordered field descriptors. */
export const SECTION_ORDER: IntakeSection[] = ["Car & contact", "Optional / Buyer context"];

export function fieldsForSection(section: IntakeSection): FieldDescriptor[] {
  return INTAKE_FIELD_NAMES.filter((n) => INTAKE_FIELD_META[n].section === section).map(
    fieldDescriptor,
  );
}

/** The form value map (string-keyed; widgets keep their own typed value). */
export type FormValues = Partial<Record<IntakeFieldName, unknown>>;

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/** Email shape: an `@` with a TLD-ish tail (FRONTEND §5.2 isValidEmailShape). */
export function isValidEmailShape(v: unknown): boolean {
  return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

/** Phone shape: ≥7 digits (FRONTEND §5.2 isValidPhoneShape). */
export function isValidPhoneShape(v: unknown): boolean {
  if (typeof v !== "string") return false;
  return v.replace(/\D/g, "").length >= 7;
}

/** The allowed years for the year-segmented widget: [now, now+1] (constraint
 *  current-or-next, §5.2). `now` is injectable for deterministic tests. */
export function allowedYears(now = new Date()): [number, number] {
  const y = now.getFullYear();
  return [y, y + 1];
}

/** Validate one field — returns a message string or null (valid). Mirrors the
 *  legacy validateField (§5.4); the server's strict() Zod is authoritative. */
export function validateField(
  name: IntakeFieldName,
  value: unknown,
  now = new Date(),
): string | null {
  const desc = fieldDescriptor(name);
  if (desc.meta.required && isEmpty(value)) return "This field is required.";
  if (isEmpty(value)) return null; // optional + empty is fine.
  switch (desc.widget) {
    case "email":
      return isValidEmailShape(value) ? null : "Enter a valid email.";
    case "tel":
      return isValidPhoneShape(value) ? null : "Enter a valid phone.";
    case "year-segmented": {
      const [a, b] = allowedYears(now);
      return value === a || value === b ? null : "Pick this year or next.";
    }
    default:
      return null;
  }
}

/** The required field names (the 6-field submit gate), in render order. */
export const REQUIRED_FIELD_NAMES = INTAKE_FIELD_NAMES.filter(
  (n) => INTAKE_FIELD_META[n].required,
);

/** Count how many required fields are currently filled (drives the §5.3 meter). */
export function requiredCompleteCount(values: FormValues, now = new Date()): number {
  return REQUIRED_FIELD_NAMES.filter((n) => validateField(n, values[n], now) === null).length;
}

/** All required fields valid → submit allowed (§5.4 allRequiredValid). */
export function allRequiredValid(values: FormValues, now = new Date()): boolean {
  return REQUIRED_FIELD_NAMES.every((n) => validateField(n, values[n], now) === null);
}

/**
 * Build the form-decision `content` from the form values (§5.7). Optional empties
 * coerce to null; required empties stay (the server rejects them). Number widgets
 * coerce numeric strings; boolean-int stays 0|1; the year stays a number. The
 * server re-validates with .strict(), so this only needs to be shape-faithful.
 */
export function buildFormDecisionContent(values: FormValues): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const name of INTAKE_FIELD_NAMES) {
    const desc = fieldDescriptor(name);
    const v = values[name];
    if (isEmpty(v)) {
      content[name] = desc.meta.required ? "" : null; // required-empty surfaces server-side.
      continue;
    }
    if (desc.widget === "number" || desc.widget === "year-segmented") {
      const n = typeof v === "number" ? v : Number(v);
      content[name] = Number.isFinite(n) ? n : v;
    } else {
      content[name] = v;
    }
  }
  return content;
}
