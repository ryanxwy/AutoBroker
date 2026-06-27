/**
 * Pure dealer-contact role parser. Given a reply body (or any free text), it
 * looks for a known job-title phrase in the email signature and returns its
 * canonical form. No DB, no LLM, no framework — a deterministic lexical scan.
 *
 * Only the tail of the message is examined (the last ~10 non-empty lines),
 * where signatures live; a role phrase quoted in the body prose above that
 * window is ignored. Matching is case-insensitive and word-boundary anchored so
 * that "supersalesmanagerial" never reads as a Sales Manager.
 *
 * Ordering is load-bearing: more-specific phrases (e.g. "Internet Sales
 * Manager", "General Sales Manager") are tested before the shorter phrases they
 * contain ("Sales Manager"), so the most-specific match wins.
 */

const SIGNATURE_TAIL_LINES = 10;

interface RoleRule {
  canonical: string;
  pattern: RegExp;
}

const ROLE_RULES: RoleRule[] = [
  { canonical: "Internet Sales Manager", pattern: /\binternet sales manager\b/i },
  { canonical: "General Sales Manager", pattern: /\bgeneral sales manager\b/i },
  { canonical: "Sales Manager", pattern: /\bsales manager\b/i },
  { canonical: "Sales Consultant", pattern: /\bsales consultant\b/i },
  { canonical: "Sales Associate", pattern: /\bsales associate\b/i },
  { canonical: "Fleet Manager", pattern: /\bfleet manager\b/i },
  { canonical: "Finance Manager", pattern: /\bfinance manager\b/i },
  { canonical: "Internet Director", pattern: /\binternet director\b/i },
  { canonical: "Product Specialist", pattern: /\bproduct specialist\b/i },
  {
    canonical: "Business Development / BDC",
    pattern: /\b(?:business development|bdc)\b/i,
  },
];

/**
 * Return the canonical role for a recognized signature phrase, or null when no
 * known role appears in the message tail (or the input is null/blank).
 */
export function parseContactRole(text: string | null): string | null {
  if (!text) return null;

  const tail = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-SIGNATURE_TAIL_LINES)
    .join("\n");

  if (tail.length === 0) return null;

  for (const rule of ROLE_RULES) {
    if (rule.pattern.test(tail)) return rule.canonical;
  }
  return null;
}
