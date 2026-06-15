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
 * Thrown by assertNoBudget when a budget figure is found in dealer-facing text.
 * FAIL-LOUD (budget red-line, see CLAUDE.md): budget_max is internal-only and
 * must NEVER reach a dealer; a leak is a hard error, not a soft validation
 * result. `matches` carries the offending substrings for audit.
 */
export class BudgetLeakError extends Error {
  readonly code = "budget_leak" as const;
  readonly matches: readonly string[];
  constructor(matches: readonly string[]) {
    super(
      `budget_leak: dealer-facing text contains budget figure(s) ` +
        `[${matches.join(", ")}] — budget is internal-only and must never reach a ` +
        `dealer (_redact_budget, CLAUDE.md §9).`,
    );
    this.name = "BudgetLeakError";
    this.matches = matches;
  }
}

/**
 * Patterns that signal a leaked budget figure. The scan is intentionally broad
 * (better a false positive caught in review than a real budget reaching a
 * dealer): a dollar amount adjacent to budget-ish wording, OR explicit
 * cap/ceiling/limit/spend phrasing followed by a number.
 *
 * Each entry is anchored on intent words so a bare price quote (which dealers DO
 * see) is not flagged — only language framing a number as the buyer's CAP. The
 * amount tail `\$?\s?\d[\d,]*(?:\.\d+)?\s?k?` matches "$42,000", "45000", "39k".
 *
 * Anchors covered: budget; max(imum); ceiling; (my) limit; out-the-door/OTD cap;
 * negated spend ("can't / cannot / won't spend more than"); and standalone
 * below/under/over/at most + amount. A plain best-price ask ("send your best
 * out-the-door price …") carries none of these and is NOT flagged.
 */
const AMOUNT = String.raw`\$?\s?\d[\d,]*(?:\.\d+)?\s?k?`;
export const BUDGET_PHRASE_PATTERNS: readonly RegExp[] = [
  // "my budget is 35000", "budget max: $35,000", "budget of 35k"
  new RegExp(String.raw`\bbudget\b[^.\n]{0,40}?${AMOUNT}`, "i"),
  // "max(imum) (i can|spend) 35000", "max price 35k"
  new RegExp(String.raw`\bmax(?:imum)?\b[^.\n]{0,40}?${AMOUNT}`, "i"),
  // "my ceiling is $42,000", "keep it below 45000 ceiling", "spending ceiling 40k"
  new RegExp(String.raw`\bceiling\b[^.\n]{0,40}?${AMOUNT}`, "i"),
  // "my limit is 39k", "limit of 40000"
  new RegExp(String.raw`\blimit\b[^.\n]{0,40}?${AMOUNT}`, "i"),
  // "out the door / OTD cap" phrasing with a number — an OTD CEILING is the
  // buyer's private ceiling, not a quote request.
  new RegExp(
    String.raw`\b(?:out[- ]the[- ]door|otd)\b[^.\n]{0,40}?(?:cap|limit|max|ceiling|under|below)[^.\n]{0,20}?${AMOUNT}`,
    "i",
  ),
  // negated spend: "can't / cannot / won't spend (any) more than 42000"
  new RegExp(String.raw`\b(?:can'?t|cannot|won'?t)\b[^.\n]{0,20}?\bspend\b[^.\n]{0,30}?${AMOUNT}`, "i"),
  // ceiling/spend verbs + ceiling language: "spend up to 35000", "keep it below 45000"
  new RegExp(
    String.raw`\b(?:can'?t go over|no more than|up to|spend up to|cap(?:ped)? at|keep (?:it )?(?:below|under))\b[^.\n]{0,30}?${AMOUNT}`,
    "i",
  ),
  // standalone ceiling preposition + amount: "below 45000", "under $40k", "over 38000"
  new RegExp(String.raw`\b(?:below|under|over|at most)\b\s+${AMOUNT}`, "i"),
];

/**
 * Reject dealer-facing text that leaks budget. THROWS BudgetLeakError on any
 * match (fail-LOUD) — the budget red-line is non-negotiable, so the caller
 * cannot ignore a soft `{ok:false}`. Returns a ValidationResult (ok:true)
 * only when the text is clean, so it composes with the other validators.
 *
 * @param text the candidate dealer-facing string (email body, form comment, …).
 */
export function assertNoBudget(text: string): ValidationResult {
  const matches: string[] = [];
  for (const pattern of BUDGET_PHRASE_PATTERNS) {
    const m = text.match(pattern);
    if (m !== null) matches.push(m[0].trim());
  }
  if (matches.length > 0) {
    throw new BudgetLeakError(matches);
  }
  return { ok: true, errors: [] };
}

/**
 * Thrown by assertUnicodeSafe when dealer-facing text carries a lone UTF-16
 * surrogate half (an unpaired U+D800–U+DFFF code unit). FAIL-LOUD: a lone
 * surrogate is not valid Unicode and corrupts the assembled RFC-2822 message
 * (it cannot round-trip through UTF-8 encoding), so it must be rejected before
 * the send path, never silently substituted. `index` is the offending code
 * unit's position for audit.
 */
export class UnicodeUnsafeError extends Error {
  readonly code = "unicode_unsafe" as const;
  readonly index: number;
  constructor(index: number) {
    super(
      `unicode_unsafe: text contains a lone UTF-16 surrogate half at index ` +
        `${index} — unpaired surrogates are invalid Unicode and must never reach ` +
        `the send path.`,
    );
    this.name = "UnicodeUnsafeError";
    this.index = index;
  }
}

/**
 * Reject text that carries a lone (unpaired) UTF-16 surrogate half. A valid
 * surrogate PAIR is a high half (U+D800–U+DBFF) immediately followed by a low
 * half (U+DC00–U+DFFF); either half on its own — a high half not followed by a
 * low half, or a low half not preceded by a high half — is invalid Unicode.
 * THROWS UnicodeUnsafeError on the first lone half (fail-LOUD); returns
 * ValidationResult (ok:true) when every surrogate is correctly paired (or there
 * are none) so it composes with the other validators.
 *
 * @param text the candidate string about to enter the send path.
 */
export function assertUnicodeSafe(text: string): ValidationResult {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate — must be immediately followed by a low surrogate.
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++; // consume the paired low half
        continue;
      }
      throw new UnicodeUnsafeError(i);
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      // Low surrogate not preceded by a high half (those advance past it above).
      throw new UnicodeUnsafeError(i);
    }
  }
  return { ok: true, errors: [] };
}

/**
 * Thrown by assertPhonePolicy when a REAL phone is present but the user did not
 * opt in to policy 'real'. FAIL-LOUD: fake-by-default is a code-level hard
 * constraint (CLAUDE.md §9), so a real number under a 'fake' policy is an error,
 * not a soft result.
 */
export class PhonePolicyViolationError extends Error {
  readonly code = "phone_policy_violation" as const;
  constructor() {
    super(
      `phone_policy_violation: a real phone is only allowed when phone_policy is ` +
        `'real' (explicit opt-in); the default 'fake' policy stores a fake number.`,
    );
    this.name = "PhonePolicyViolationError";
  }
}

/**
 * Enforce the fake-phone default: a real phone may be used in dealer-facing
 * surfaces ONLY under policy 'real' (explicit opt-in). Under any other policy a
 * non-empty real phone throws PhonePolicyViolationError. An empty/absent phone is
 * always fine.
 *
 * @param phone  the phone about to be surfaced to a dealer.
 * @param policy the profile's phone_policy ('fake' default | 'real' opt-in).
 */
export function assertPhonePolicy(
  phone: string,
  policy: "fake" | "real",
): ValidationResult {
  if (phone !== "" && policy !== "real") {
    throw new PhonePolicyViolationError();
  }
  return { ok: true, errors: [] };
}
