/**
 * quotes/flags — the shared `flags_json` → code list decoder.
 *
 * `quote_audits.flags_json` stores a JSON array of finding objects
 * (`{code, severity, text, suggestion}`). Compare/summary surfaces only need the
 * codes. This decoder is defensive: a null / empty / non-JSON / non-array blob
 * (or any individual non-dict / code-less / non-string-code entry) degrades to
 * an empty list rather than throwing, preserving the order of valid codes.
 */

/** Extract the ordered list of non-empty string `code`s from a flags_json blob. */
export function flagCodesFromJson(blob: unknown): string[] {
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
    const code = (entry as { code?: unknown }).code;
    if (typeof code === "string" && code) out.push(code);
  }
  return out;
}
