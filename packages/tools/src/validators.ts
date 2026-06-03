/**
 * validators — pure structural/safety validation for tool inputs and dealer
 * outputs. No SQLite, no network. Belt-and-suspenders Zod post-validation that
 * runs AFTER the model produces structured output (schema subsets differ per
 * provider, so post-validation is where the real guarantee lives).
 *
 * Two responsibilities:
 *   1. Re-validate model-produced structured output against the canonical Zod
 *      contracts in @autobroker/core (catch over-the-common-subset drift).
 *   2. Enforce safety rules that must hold regardless of the model: fake phone
 *      unless explicitly opted in, no budget in dealer-facing text.
 */

// TODO(phase-4): import canonical Zod contracts from @autobroker/core.
// import { DealerQuoteSchema, type DealerQuote } from "@autobroker/core";

/** Result of a post-validation pass. */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Belt-and-suspenders post-validation of model output against a core Zod schema.
 * TODO(phase-4): run `schema.safeParse(value)` and map issues into `errors`.
 */
export function postValidate(value: unknown): ValidationResult {
  // TODO(phase-4): real Zod parse; treat any failure as ok:false (fail-closed).
  void value;
  return { ok: true, errors: [] };
}

/**
 * Reject dealer-facing text that leaks budget. Mirrors the gmail redactor but as
 * a hard validator so a constraint violation is caught even if redaction missed.
 * TODO(phase-4): share the budget pattern set with gmail.redactBudget.
 */
export function assertNoBudget(text: string): ValidationResult {
  // TODO(phase-4): detect budget mentions; return ok:false if found.
  void text;
  return { ok: true, errors: [] };
}

/**
 * Enforce the fake-phone default: a real phone is only allowed when the user has
 * explicitly opted in.
 */
export function assertPhonePolicy(
  phone: string,
  userOptedIntoRealPhone: boolean,
): ValidationResult {
  // TODO(phase-4): compare against the configured fake-phone value.
  void phone;
  if (!userOptedIntoRealPhone) {
    // A real phone slipping through without opt-in is a violation.
    // TODO(phase-4): return ok:false when `phone` is not the fake placeholder.
  }
  return { ok: true, errors: [] };
}
