/**
 * inventoryScout — lightweight HTTP probe that maps a dealer homepage onto its
 * most-likely new-vehicle search-results page (SRP). Ported from the legacy
 * Python implementation. Plain `fetch`, NO Playwright / JS rendering: this is
 * a cheap pre-flight that predicts whether the (expensive) browser walk has a
 * canned entry point — it never scrapes inventory itself.
 *
 * Flow: GET the homepage → discard on network error, anti-bot block signature,
 * or HTTP error → fingerprint the HTML against the known dealer-platform table
 * → probe the platform's canned SRP path on the same origin. Only a FRESH 200
 * from THIS scan counts — a canned path stored by a previous scan is never
 * trusted. The platform label is internal plumbing only; it is never persisted.
 */

import { classifyBlockSignature } from "./blockSignature.js";

/** Per-probe timeout: short enough that a 10-dealer × 2-probe scan stays under 4 min. */
const PROBE_TIMEOUT_MS = 10_000;

/** Cap body reads at 1 MB — plenty for the title + platform fingerprint markers. */
const BODY_READ_CAP_BYTES = 1_000_000;

/**
 * Plain headless-Chrome UA — the same one the LLM-driven browser walk presents,
 * so this probe's block rate predicts the real walk's.
 */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.0.0 Safari/537.36";

/**
 * Platform fingerprint table: [internal label, homepage-HTML marker, canned SRP
 * path]. Checked in order, first match wins. Dealer.com is the broadest
 * fingerprint — kept LAST so the more specific platforms get a chance first.
 */
const PLATFORM_FINGERPRINTS: ReadonlyArray<
  readonly [platform: string, marker: RegExp, cannedPath: string]
> = [
  ["dealeron_v1", /DealerOn/i, "/new-vehicles/"],
  ["dealerfire", /DealerFire|Powered by DealerFire/i, "/new-inventory.htm"],
  ["dealerinspire", /dealerinspire\.com|DealerInspire/i, "/new-vehicles/"],
  ["dealercom", /dealer\.com|cobalt\.com/i, "/new-inventory/index.htm"],
];

/**
 * Default when no fingerprint hits — the most common dealer convention. The
 * SRP probe simply 404s (→ null) if the site doesn't follow it.
 */
const DEFAULT_SRP_PATH = "/new-inventory";

/**
 * Return the most-likely SRP path for a homepage HTML: the canned path of the
 * first matching platform fingerprint, or the generic default. Pure.
 */
export function likelySrpPath(homepageHtml: string): string {
  for (const [, marker, cannedPath] of PLATFORM_FINGERPRINTS) {
    if (marker.test(homepageHtml)) {
      return cannedPath;
    }
  }
  return DEFAULT_SRP_PATH;
}

export interface ScoutOptions {
  /** Override for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Resolve a dealer homepage to a probed-live SRP URL, or null when it can't be
 * done cheaply (the caller falls back to the browser walk). Null on: homepage
 * network error / timeout, anti-bot block signature, homepage HTTP >= 400, or
 * a canned-path probe that is anything but a fresh 200.
 */
export async function resolveSrp(
  homepageUrl: string,
  opts: ScoutOptions = {},
): Promise<{ srpUrl: string } | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  const home = await probeGet(fetchImpl, homepageUrl);
  if (home === null) return null;
  // Blocked → surface nothing and never escalate (no stealth, no retry-harder).
  if (classifyBlockSignature(home.body, home.status) !== null) return null;
  if (home.status >= 400) return null;

  // Canned paths are origin-absolute ("/new-vehicles/"), so this resolves
  // against the homepage's origin regardless of any homepage path component.
  const srpUrl = new URL(likelySrpPath(home.body), homepageUrl).toString();
  const probe = await probeGet(fetchImpl, srpUrl);
  if (probe === null || probe.status !== 200) return null;
  return { srpUrl };
}

interface ProbeCapture {
  status: number;
  body: string;
}

/**
 * GET a URL (following redirects) and return status + capped body text, or
 * null on any network error / timeout — unreachable means not-resolvable here,
 * never an exception. GET rather than HEAD: some dealer sites 405 on HEAD, and
 * the fingerprint regex needs the body anyway.
 */
async function probeGet(
  fetchImpl: typeof fetch,
  url: string,
): Promise<ProbeCapture | null> {
  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { status: res.status, body: await readBodyCapped(res) };
  } catch {
    return null;
  }
}

/**
 * Decode the response body, aborting the read once BODY_READ_CAP_BYTES have
 * been consumed so a multi-MB page never sits fully in memory.
 */
async function readBodyCapped(res: Response): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let text = "";
  let bytesRead = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = BODY_READ_CAP_BYTES - bytesRead;
    const chunk = value.byteLength > room ? value.subarray(0, room) : value;
    bytesRead += chunk.byteLength;
    text += decoder.decode(chunk, { stream: true });
    if (bytesRead >= BODY_READ_CAP_BYTES) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return text + decoder.decode();
}
