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
// A spelled-out monetary amount (no digits): a number word optionally scaled by
// thousand/grand, immediately tagged "dollars". This catches a PARAPHRASED
// budget leak ("around three thousand dollars", "twenty grand") that carries no
// digit and no $-sign, so a digit-anchored pattern would miss it. The trailing
// "dollars"/"grand"/"bucks" tag is what makes it a money figure (a bare "three
// thousand miles" is not flagged).
const NUMBER_WORD =
  String.raw`(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|` +
  String.raw`thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|` +
  String.raw`thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)`;
const SPELLED_AMOUNT =
  String.raw`(?:${NUMBER_WORD}[\s-]+){1,4}(?:thousand|grand)?[\s-]*(?:dollars|bucks|grand)`;
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
  // PARAPHRASED leak — a budget/cap anchor followed by a SPELLED-OUT dollar
  // amount ("my budget is about thirty thousand dollars", "max around twenty
  // grand"): no digit, so the digit-anchored patterns above miss it.
  new RegExp(
    String.raw`\b(?:budget|max(?:imum)?|ceiling|limit|spend|afford)\b[^.\n]{0,40}?${SPELLED_AMOUNT}`,
    "i",
  ),
  // PARAPHRASED leak — a soft approximation cue ("around / about / roughly /
  // up to / no more than") immediately before a SPELLED dollar amount
  // ("around three thousand dollars"): the approximation + "dollars" tag frames
  // it as the buyer's private ceiling, not a precise quote request.
  new RegExp(
    String.raw`\b(?:around|about|roughly|approximately|up to|no more than)\b[\s-]+${SPELLED_AMOUNT}`,
    "i",
  ),
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
 * Thrown by assertPaymentMethodConsistent when a dealer-facing draft asserts a
 * payment method the buyer did NOT choose. FAIL-LOUD (hard constraints in code,
 * CLAUDE.md §9): the buyer's financing preference is internal ground truth; an
 * LLM prose draft must never fabricate "cash purchase" for a finance buyer (or
 * the reverse) — that misrepresents the buyer to the dealer and skews the
 * cash-vs-finance quote. `preference` is the chosen method; `matches` carries the
 * offending self-claim substrings for audit.
 */
export class PaymentMethodMismatchError extends Error {
  readonly code = "payment_method_mismatch" as const;
  readonly preference: string;
  readonly matches: readonly string[];
  constructor(preference: string, matches: readonly string[]) {
    super(
      `payment_method_mismatch: dealer-facing text asserts a payment method ` +
        `[${matches.join(", ")}] contradicting the buyer's chosen financing ` +
        `preference "${preference}" — a draft must never state a payment method ` +
        `the buyer did not choose (CLAUDE.md §9, hard constraints in code).`,
    );
    this.name = "PaymentMethodMismatchError";
    this.preference = preference;
    this.matches = matches;
  }
}

/**
 * Self-claim patterns for each payment method in BUYER-authored outbound text.
 * The scanned text is the buyer's own draft (no dealer quotes are spliced in),
 * so a matched phrase is the buyer self-describing a payment method — not a
 * question about one. Each pattern is affirmative/intent-anchored so a neutral
 * QUESTION ("do you offer financing?") is NOT a claim: only first-person intent
 * ("I'll finance", "plan to lease") or a concrete noun phrase ("cash purchase",
 * "finance through you") counts.
 */
const CASH_CLAIM_PATTERN =
  /\b(?:cash\s+(?:purchase|buyer|customer|sale|transaction|payment)|(?:pay(?:ing)?|paid)\s+(?:in\s+|with\s+|by\s+)?cash|all[-\s]cash|cash\s+in\s+full)\b/i;
const FINANCE_CLAIM_PATTERN =
  /\b(?:(?:i'?(?:ll|m)|we'?(?:ll|re))\s+financ(?:e|es|ed|ing)|(?:plan(?:ning)?|intend(?:ing)?|going|want|hoping|hope|like|prefer)\s+to\s+financ(?:e|ing)|will\s+be\s+financ(?:e|ing)|financ(?:e|es|ed|ing)\s+(?:through|with|this|the)\b)/i;
const LEASE_CLAIM_PATTERN =
  /\b(?:(?:i'?(?:ll|m)|we'?(?:ll|re))\s+leas(?:e|es|ed|ing)|(?:plan(?:ning)?|intend(?:ing)?|going|want|hoping|hope|like|prefer)\s+to\s+leas(?:e|ing)|will\s+be\s+leas(?:e|ing)|leas(?:e|es|ed|ing)\s+(?:through|with|this|the|it)\b)/i;

/**
 * A negation/contrast cue immediately before a claim, within a short same-clause
 * window (no sentence boundary between). Suppresses a NEGATED or CONTRASTED
 * mention so it is not read as an affirmative self-claim: "I'm NOT financing it",
 * "don't pay cash", "RATHER THAN paying cash, I'll finance". Without this, a
 * consistent draft that negates the other method would falsely abort the batch.
 */
const NEGATION_CUE =
  /\b(?:not|never|no|without|don'?t|doesn'?t|won'?t|wouldn'?t|isn'?t|aren'?t|can'?t|cannot|rather\s+than|instead\s+of)\b[^.?!\n]{0,24}$/i;

/** The first match of `pattern` in `text` that is NOT immediately preceded by a
 *  negation/contrast cue, or null. */
function firstUnnegatedClaim(text: string, pattern: RegExp): string | null {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (const m of text.matchAll(re)) {
    if (!NEGATION_CUE.test(text.slice(0, m.index))) return m[0].trim();
  }
  return null;
}

/**
 * Reject a dealer-facing draft that asserts a payment method contradicting the
 * buyer's CHOSEN financing preference. THROWS PaymentMethodMismatchError on a
 * contradiction (fail-LOUD, like assertNoBudget) so the caller cannot send a
 * misrepresentation; returns ValidationResult (ok:true) when the draft is silent
 * on payment method or consistent with the preference.
 *
 * Only a buyer who has CHOSEN a method (`cash` / `finance` / `lease`) can be
 * contradicted; an `undecided`/empty/unknown preference leaves the method open,
 * so no claim is forbidden (the draft is told it is still comparing). Mirrors
 * the deterministic initial-email `financingLine` mapping.
 *
 * @param text the candidate dealer-facing draft body.
 * @param financingPreference the buyer's chosen method (search_profiles.financing_preference).
 */
export function assertPaymentMethodConsistent(
  text: string,
  financingPreference: string | null,
): ValidationResult {
  const pref = (financingPreference ?? "").trim().toLowerCase();
  let forbidden: { label: string; pattern: RegExp }[];
  if (pref === "finance") {
    forbidden = [
      { label: "cash", pattern: CASH_CLAIM_PATTERN },
      { label: "lease", pattern: LEASE_CLAIM_PATTERN },
    ];
  } else if (pref === "lease") {
    forbidden = [
      { label: "cash", pattern: CASH_CLAIM_PATTERN },
      { label: "finance", pattern: FINANCE_CLAIM_PATTERN },
    ];
  } else if (pref === "cash") {
    forbidden = [
      { label: "finance", pattern: FINANCE_CLAIM_PATTERN },
      { label: "lease", pattern: LEASE_CLAIM_PATTERN },
    ];
  } else {
    return { ok: true, errors: [] };
  }

  const matches: string[] = [];
  for (const f of forbidden) {
    const claim = firstUnnegatedClaim(text, f.pattern);
    if (claim !== null) matches.push(claim);
  }
  if (matches.length > 0) {
    throw new PaymentMethodMismatchError(pref, matches);
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
