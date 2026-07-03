/**
 * time — the one numeric|ISO-string → epoch-ms parser the inbox reads share.
 * Timestamps in the product schema are stored as EITHER an ISO-8601 string OR an
 * epoch-ms number, and no single SQL sort orders both (a CAST(... AS INTEGER)
 * collapses an ISO string to its year; a string sort breaks epoch-ms numbers), so
 * the reads parse to epoch-ms in JS and sort/compare there. Mirrors the
 * readFirstLeadSubmitAtMs convention: a number passes through (finite check), an
 * ISO string is Date.parse'd, empty/non-string/non-finite → null.
 *
 * Dependency wall: pure, imports nothing.
 */

/** Parse a numeric|ISO-string timestamp to epoch-ms, or null. */
export function toEpochMs(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    if (raw.trim() === "") return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}
