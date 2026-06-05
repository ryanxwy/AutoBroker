/**
 * fake-phone generation (BACKEND_SERVICES §8.4, BRIEF §4, persist.md:36).
 *
 * RULE: keep the FIRST 6 digits (area code + prefix), RANDOMIZE the LAST 4. The
 * fake number is stored in `fake_phone`; the real number stays in
 * `follow_up_phone`. Default policy is 'fake' — dealer communication uses
 * `fake_phone` unless the user explicitly opts in to 'real'. This is a code-level
 * hard constraint (CLAUDE.md §9), not a prompt/temperature setting.
 *
 * DETERMINISTIC SEAM: the last-4 RNG is injectable. Production passes the default
 * crypto-free RNG; tests pass a seeded RNG so the output is reproducible without
 * touching the global Math.random.
 */

/** Returns a value in [0, 1). Matches Math.random's contract so it is drop-in. */
export type Rng = () => number;

/** Default RNG — Math.random. Non-deterministic; tests override it. */
const defaultRng: Rng = Math.random;

/**
 * Extract exactly the digits from an arbitrary phone string. Punctuation,
 * spaces, parens, and a leading '+' are dropped — only 0-9 survive.
 */
function digitsOf(phone: string): string {
  let out = "";
  for (const ch of phone) {
    if (ch >= "0" && ch <= "9") out += ch;
  }
  return out;
}

/**
 * Generate a fake phone from a real one: keep the first 6 digits, randomize the
 * last 4. Returns a 10-digit string of digits (no formatting) — callers store it
 * verbatim in `fake_phone`.
 *
 * FAIL-LOUD: a phone with fewer than 10 digits cannot satisfy "keep 6 + random 4"
 * — we throw rather than silently pad or truncate to a misleading number.
 *
 * @param realPhone the user-supplied real phone (any formatting).
 * @param rng       injected RNG for the last 4 digits (default Math.random).
 */
export function makeFakePhone(realPhone: string, rng: Rng = defaultRng): string {
  const digits = digitsOf(realPhone);
  if (digits.length < 10) {
    throw new Error(
      `makeFakePhone: need at least 10 digits to keep the first 6 and randomize ` +
        `the last 4; got ${digits.length} from ${JSON.stringify(realPhone)}.`,
    );
  }
  // Keep the first 6 digits (area code + prefix); use the 10-digit national
  // number's leading 6 even when the input carried a country code at the front
  // would shift this — but per the rule we take the first 6 of the national
  // number. We normalize to the trailing 10 digits so an optional leading '1'
  // country code does not steal a kept position.
  const national = digits.length > 10 ? digits.slice(digits.length - 10) : digits;
  const keep = national.slice(0, 6);
  let last4 = "";
  for (let i = 0; i < 4; i++) {
    // floor(rng()*10) ∈ [0,9]; clamp guards an RNG that returns exactly 1.
    const d = Math.min(9, Math.floor(rng() * 10));
    last4 += String(d);
  }
  return keep + last4;
}

/**
 * Resolve the phone to STORE for dealer-facing use, honoring policy. When policy
 * is 'fake' (the default) a real phone is converted via makeFakePhone; when
 * 'real' (explicit opt-in) the real phone passes through. Returns null when no
 * phone was supplied. Store-only-fake discipline: this is the value that lands in
 * `fake_phone`.
 */
export function resolveStoredPhone(
  realPhone: string | null,
  policy: "fake" | "real",
  rng: Rng = defaultRng,
): string | null {
  if (realPhone === null || realPhone === "") return null;
  if (policy === "real") return realPhone;
  return makeFakePhone(realPhone, rng);
}
