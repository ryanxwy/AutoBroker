/**
 * Anti-bot / block-page signature classifier. A capture that matches is marked
 * `blocked` and its content is DISCARDED — we surface the refusal to the user
 * and never escalate (no stealth, no retry-harder). Only the first 8 KB is
 * scanned: block interstitials announce themselves early, and this keeps the
 * check O(1) on multi-MB pages.
 */

const BLOCK_SIGNATURE_RE =
  /cloudflare|attention required|access denied|complyauto|bot detection|captcha/i;

const SCAN_WINDOW_BYTES = 8192;

/**
 * Classify a page body (HTML/text). Returns the lowercased matched signature
 * (e.g. "cloudflare", "captcha"), or — when the HTTP status already signals a
 * block (403/429/503) without a recognizable body marker — `http_<status>`.
 * Returns null when the capture looks like a normal page.
 */
export function classifyBlockSignature(
  body: string,
  status?: number,
): string | null {
  const window = body.slice(0, SCAN_WINDOW_BYTES);
  const m = BLOCK_SIGNATURE_RE.exec(window);
  if (status !== undefined && [403, 429, 503].includes(status)) {
    return m ? m[0].toLowerCase() : `http_${status}`;
  }
  return m ? m[0].toLowerCase() : null;
}
