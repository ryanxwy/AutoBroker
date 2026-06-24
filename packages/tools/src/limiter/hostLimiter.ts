/**
 * Per-dealer-HOST politeness limiter — PROCESS-GLOBAL, shared across every
 * profile's browser scans (the bug it fixes: the throttle used to be per-Browser
 * session, so two profiles scanning the same dealer host hammered it in
 * parallel). For each host it enforces:
 *   - a min-interval spacing between requests (+ ±0.5s jitter), with a robots
 *     `Crawl-delay` honored as the floor;
 *   - a concurrency cap (≤ 2 in-flight to one host).
 * robots.txt is fetched + cached per ORIGIN (once per process). Disallow stays
 * advisory/recorded-only (parity); only Crawl-delay changes pacing.
 *
 * Sits BELOW the L2 gate — it paces read-side navigation, never a send/submit.
 * Dependency wall: pure within tools (no Playwright) — that is why it lives in
 * the limiter package and not browser.ts.
 */

import { systemClock, type Clock } from "./clock.js";
import { AsyncSemaphore } from "./primitives.js";
import { parseCrawlDelaySeconds, parseRobotsDisallow, politenessDelayMs } from "./robots.js";

/** Default per-host spacing — matches the legacy per-session throttle. */
const DEFAULT_MIN_INTERVAL_MS = 2_000;
const DEFAULT_MAX_CONCURRENT_PER_HOST = 2;
const ROBOTS_FETCH_TIMEOUT_MS = 5_000;

/** Real robots fetch — best effort; any problem = no signal (null). */
async function defaultFetchRobots(origin: string): Promise<string | null> {
  try {
    const resp = await fetch(`${origin}/robots.txt`, {
      signal: AbortSignal.timeout(ROBOTS_FETCH_TIMEOUT_MS),
    });
    return resp.ok ? await resp.text() : null;
  } catch {
    return null;
  }
}

export interface HostPolitenessLimiterOptions {
  clock?: Clock;
  rand?: () => number;
  minIntervalMs?: number;
  maxConcurrentPerHost?: number;
  /** Injectable for tests — defaults to a real, timeout-bounded HTTP fetch. */
  fetchRobots?: (origin: string) => Promise<string | null>;
}

interface HostState {
  /** Last request time (ms); undefined until the first request. */
  lastRequestAt: number | undefined;
  sem: AsyncSemaphore;
}

interface OriginState {
  body: string | null;
  crawlDelayMs: number;
}

export class HostPolitenessLimiter {
  private readonly clock: Clock;
  private readonly rand: () => number;
  private readonly minIntervalMs: number;
  private readonly maxConcurrentPerHost: number;
  private readonly fetchRobots: (origin: string) => Promise<string | null>;

  private readonly hosts = new Map<string, HostState>();
  private readonly origins = new Map<string, OriginState>();
  /** In-flight robots fetches, so concurrent first-hits coalesce to one fetch. */
  private readonly originInFlight = new Map<string, Promise<OriginState>>();

  constructor(opts: HostPolitenessLimiterOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.rand = opts.rand ?? Math.random;
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.maxConcurrentPerHost = opts.maxConcurrentPerHost ?? DEFAULT_MAX_CONCURRENT_PER_HOST;
    this.fetchRobots = opts.fetchRobots ?? defaultFetchRobots;
  }

  private hostState(host: string): HostState {
    let st = this.hosts.get(host);
    if (st === undefined) {
      st = { lastRequestAt: undefined, sem: new AsyncSemaphore(this.maxConcurrentPerHost) };
      this.hosts.set(host, st);
    }
    return st;
  }

  /** Fetch + cache robots for an origin once (coalescing concurrent first-hits). */
  private async ensureOrigin(origin: string): Promise<OriginState> {
    const cached = this.origins.get(origin);
    if (cached !== undefined) return cached;
    const pending = this.originInFlight.get(origin);
    if (pending !== undefined) return pending;

    const p = (async (): Promise<OriginState> => {
      const body = await this.fetchRobots(origin);
      const crawlSec = body === null ? null : parseCrawlDelaySeconds(body);
      const state: OriginState = {
        body,
        crawlDelayMs: crawlSec === null ? 0 : crawlSec * 1000,
      };
      this.origins.set(origin, state);
      this.originInFlight.delete(origin);
      return state;
    })();
    this.originInFlight.set(origin, p);
    return p;
  }

  /** Is this URL Disallowed by the host's robots (advisory, recorded-only)? */
  async robotsDisallowed(url: string | URL): Promise<boolean> {
    const u = typeof url === "string" ? new URL(url) : url;
    const { body } = await this.ensureOrigin(u.origin);
    return body === null ? false : parseRobotsDisallow(body, u.pathname + u.search);
  }

  /**
   * Run `fn` (a navigation) under this host's politeness: hold one of the host's
   * concurrency slots, wait out the min-interval (or robots Crawl-delay) spacing,
   * then run. Shared across profiles via the process-global host/origin maps.
   */
  async runHostRequest<T>(url: string | URL, fn: () => Promise<T>): Promise<T> {
    const u = typeof url === "string" ? new URL(url) : url;
    const st = this.hostState(u.hostname);
    return st.sem.run(async () => {
      const { crawlDelayMs } = await this.ensureOrigin(u.origin);
      const interval = Math.max(this.minIntervalMs, crawlDelayMs);
      const now = this.clock.now();
      const wait =
        st.lastRequestAt === undefined
          ? 0
          : politenessDelayMs(st.lastRequestAt, now, interval, this.rand);
      // Reserve the next-allowed instant SYNCHRONOUSLY (before yielding to the
      // sleep). Two concurrent slot-holders then chain off each other's reserved
      // time rather than both reading the same stale lastRequestAt and colliding.
      st.lastRequestAt = now + wait;
      if (wait > 0) await this.clock.sleep(wait);
      return fn();
    });
  }
}
