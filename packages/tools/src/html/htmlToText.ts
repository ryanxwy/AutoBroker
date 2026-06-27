/**
 * Generic HTML-to-plain-text utility. Strips script/style blocks, all tags,
 * common HTML entities, and collapses whitespace to a single space. The result
 * is suitable as grounding text for downstream LLM extraction or keyword search.
 *
 * This is deliberately a PURE string utility — no framework imports, no I/O,
 * no structured-data harvesting (that concern belongs to the caller). The only
 * external dependency is the JS runtime's built-in string and RegExp support.
 *
 * Surrogate-safe cap: after slicing to `cap` characters the function drops a
 * lone high surrogate (U+D800–U+DBFF) that may have been exposed at the cut
 * boundary, so the returned string is always a valid UTF-16 sequence.
 *
 * Default cap (100 000 chars) is generous enough for a full HTML email body
 * while preventing unbounded allocations on pathological inputs.
 */

/** Characters before the default cap that we keep. */
const DEFAULT_CAP = 100_000;

/**
 * Strip an HTML string to readable plain text and return at most `cap`
 * characters, surrogate-safe.
 *
 * Processing order:
 *   1. Drop `<script>` and `<style>` blocks (including their content).
 *   2. Strip remaining HTML tags.
 *   3. Decode common HTML entities (&nbsp; &amp; &apos; family &quot; &foo;).
 *   4. Collapse runs of whitespace to a single space and trim.
 *   5. Slice to `cap`, then drop a lone high surrogate at the cut boundary.
 */
export function stripHtmlToText(html: string, cap: number = DEFAULT_CAP): string {
  const visible = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  let result = visible.slice(0, cap);

  // Drop a lone high surrogate that slicing may have left at the tail.
  if (result.length > 0) {
    const last = result.charCodeAt(result.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      result = result.slice(0, -1);
    }
  }

  return result;
}
