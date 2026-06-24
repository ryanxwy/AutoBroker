/**
 * robots.txt + politeness math — the PURE host-courtesy helpers. They live here
 * (not in browser.ts) so the process-global HostPolitenessLimiter can use them
 * WITHOUT pulling Playwright into the Gmail/LLM code paths that also touch the
 * LimiterRegistry. browser.ts re-exports them, so its public surface and tests
 * are unchanged.
 *
 * Dependency wall: pure — imports nothing.
 */

/** Jitter amplitude for the per-host throttle (±0.5 s around the min interval). */
export const POLITENESS_JITTER_MS = 500;

/**
 * How long to wait before hitting the same host again: the min interval plus
 * ±0.5 s jitter, minus the time already elapsed; never negative.
 */
export function politenessDelayMs(
  lastRequestAtMs: number,
  nowMs: number,
  minIntervalMs: number,
  rand: () => number = Math.random,
): number {
  const jitterMs = (rand() * 2 - 1) * POLITENESS_JITTER_MS;
  const waitMs = minIntervalMs + jitterMs - (nowMs - lastRequestAtMs);
  return Math.max(0, waitMs);
}

/**
 * Minimal robots.txt Disallow check: only the `User-agent: *` group(s) are
 * considered (specific-agent groups are ignored), only `Disallow` lines count,
 * the longest matching prefix decides, and an empty `Disallow:` value means
 * allow. Rule paths are matched literally (no `*`/`$` wildcard expansion) —
 * this is an advisory, RECORDED-ONLY signal, never a navigation blocker.
 * Fetch failures are the caller's concern (no robots reachable = no signal).
 */
export function parseRobotsDisallow(robotsTxt: string, path: string): boolean {
  let inAgentLines = false; // currently reading a group's User-agent header lines
  let starGroup = false; // the group being read applies to '*'
  const disallows: string[] = [];

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (field === "user-agent") {
      // A User-agent line after rule lines starts a NEW group; consecutive
      // User-agent lines extend the same group.
      if (!inAgentLines) starGroup = false;
      inAgentLines = true;
      if (value === "*") starGroup = true;
    } else {
      inAgentLines = false;
      if (field === "disallow" && starGroup && value !== "") {
        disallows.push(value);
      }
    }
  }

  let longest = "";
  for (const rule of disallows) {
    if (path.startsWith(rule) && rule.length > longest.length) longest = rule;
  }
  return longest.length > 0;
}

/**
 * Parse the `Crawl-delay` (seconds) declared for the `User-agent: *` group, or
 * null when none/invalid. Crawl-delay is HONORED (unlike Disallow): the host
 * limiter uses it as a floor on the per-host spacing. Same group-tracking rules
 * as parseRobotsDisallow (star group only; a non-`*` group's value is ignored).
 * A negative or non-numeric value is treated as "no signal" (null).
 */
export function parseCrawlDelaySeconds(robotsTxt: string): number | null {
  let inAgentLines = false;
  let starGroup = false;
  let best: number | null = null;

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (field === "user-agent") {
      if (!inAgentLines) starGroup = false;
      inAgentLines = true;
      if (value === "*") starGroup = true;
    } else {
      inAgentLines = false;
      if (field === "crawl-delay" && starGroup) {
        const n = Number(value);
        // The most generous (largest) crawl-delay declared for '*' wins.
        if (Number.isFinite(n) && n >= 0) best = best === null ? n : Math.max(best, n);
      }
    }
  }
  return best;
}
