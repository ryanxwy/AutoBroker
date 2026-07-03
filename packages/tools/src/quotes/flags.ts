/**
 * quotes/flags — the shared `flags_json` → code list decoder.
 *
 * `quote_audits.flags_json` stores a JSON array of finding objects
 * (`{code, severity, text, suggestion}`). Compare/summary surfaces only need the
 * codes. This decoder is defensive: a null / empty / non-JSON / non-array blob
 * (or any individual non-dict / field-less / non-string-field entry) degrades to
 * an empty list rather than throwing, preserving the order of valid values.
 */

/** Extract the ordered list of non-empty string values at `field` from a
 *  flags_json blob. Any malformed shape (null / empty / non-JSON / non-array,
 *  or an individual non-dict / field-less / non-string-field entry) degrades to
 *  an empty list rather than throwing. */
function extractStringField(blob: unknown, field: string): string[] {
  if (blob === null || blob === undefined || blob === "") return [];

  let parsed: unknown;
  if (typeof blob === "string") {
    try {
      parsed = JSON.parse(blob);
    } catch {
      return [];
    }
  } else {
    parsed = blob;
  }

  if (!Array.isArray(parsed)) return [];

  const out: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = (entry as Record<string, unknown>)[field];
    if (typeof value === "string" && value) out.push(value);
  }
  return out;
}

/** Extract the ordered list of non-empty string `code`s from a flags_json blob. */
export function flagCodesFromJson(blob: unknown): string[] {
  return extractStringField(blob, "code");
}

/** Extract the ordered list of non-empty string `suggestion`s from a flags_json
 *  blob (the concrete next steps the audit findings carry). */
export function flagSuggestionsFromJson(blob: unknown): string[] {
  return extractStringField(blob, "suggestion");
}
