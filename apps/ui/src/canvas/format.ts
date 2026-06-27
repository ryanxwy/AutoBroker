/**
 * Shared, pure label formatters for the canvas surfaces (tiles + detail modals).
 *
 * These were duplicated verbatim across the section components and the detail
 * modals (the old `priceLabel`/`dollarLabel` pair were byte-identical — they are
 * consolidated here under one name, `dollarLabel`). No React, no side effects —
 * each returns a display string (or null/"" so the caller can omit the field).
 */

/** A "$43,210" dollar label from a number (no cents noise), or null for a
 *  missing value (so the row is omitted). */
export function dollarLabel(value: number | null): string | null {
  if (value === null) return null;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/** A "5.2 mi" distance label, or null when unknown. */
export function distanceLabel(value: number | null): string | null {
  if (value === null) return null;
  return `${value.toFixed(1)} mi`;
}

/** A "Jun 12, 2026" date label from an ISO string, or null when absent/unparsable. */
export function dateLabel(value: string | null): string | null {
  if (value === null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

/** A coarse "3 days ago" relative label from an ISO/timestamp string. Degrades to
 *  "" when the value is unparseable or null. */
export function relativeDate(value: string | null): string {
  if (value === null || value.trim() === "") return "";
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return "";
  const deltaDays = Math.floor((Date.now() - ms) / 86_400_000);
  if (deltaDays <= 0) return "today";
  if (deltaDays === 1) return "yesterday";
  return `${deltaDays} days ago`;
}

/** The "expires 2026-07-31" line from a raw expiry, dropping a missing one. */
export function expiryLine(expires: string | null): string {
  return expires !== null && expires !== "" ? `expires ${expires}` : "";
}

/** An ABSOLUTE "Jun 12, 2026, 3:04 PM" timestamp from an ISO string OR an
 *  epoch-ms number (the negotiation reply `received_at` wire shape is a
 *  `string | number`). Unlike `relativeDate` (which accepts only a string and
 *  returns "" on a number), this handles both. Degrades to "" when null, blank,
 *  or unparseable so the caller can omit the line. */
export function absoluteTimestamp(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "string" && value.trim() === "") return "";
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
