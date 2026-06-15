/**
 * The typed-YES confirmation token validator for the DESTRUCTIVE pipeline reset.
 *
 * The single source of truth for "did the human type YES". The destructive
 * second-confirm is gated on the literal word YES, case-insensitive, after a
 * surrounding-whitespace trim — and NOTHING else. "y", "yeah", "yes please",
 * the empty string, or any other phrase is REJECTED. This validator runs
 * SERVER-SIDE in the resume handler; the client-side check is convenience only.
 * No confirmation → zero destruction, so this gate is load-bearing: it must
 * never widen.
 *
 * Pure. No I/O, no DB, no env.
 */

/** The exact confirmation word, compared case-insensitively after trim. */
export const RESET_CONFIRM_TOKEN = "YES" as const;

/**
 * True iff `input` is the literal confirmation token (case-insensitive, after a
 * surrounding-whitespace trim). A non-string, the empty string, a partial match
 * ("y"), or any other phrase is false.
 */
export function validateResetToken(input: unknown): boolean {
  if (typeof input !== "string") return false;
  return input.trim().toLowerCase() === RESET_CONFIRM_TOKEN.toLowerCase();
}
