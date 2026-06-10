/**
 * Browser tool — the Playwright-native browser service. This file is the ONLY
 * place in the codebase that drives a browser (five-layer rule: external I/O
 * lives in packages/tools alone; workflows/app reach the web only through this
 * surface).
 *
 * ENGINE — always throwaway, never the user's Chrome profile:
 *   - headless (product default): `chromium.launch()` + an incognito-style
 *     `newContext({serviceWorkers:"block"})` — no profile directory on disk.
 *   - headed (debug): `launchPersistentContext` over a FRESH mkdtemp dir under
 *     os.tmpdir(), removed unconditionally in `finally`. Temp profile dirs
 *     accumulate fast when debugging (one per launch), so cleanup must never
 *     be conditional on the happy path.
 *   An isolation denylist additionally STOPS the session cold if a personal
 *   page (Gmail, Google account, chrome:// internals) ever appears in the
 *   controlled browser — that smell means we are somehow inside a real profile.
 *
 * POLITENESS — per-host min-interval throttle with jitter; a once-per-origin
 * robots.txt Disallow signal that is RECORDED ONLY (navigation proceeds, the
 * opinion rides the event stream); bounded exponential backoff with full
 * jitter on HTTP 429/403; and block-signature classification once retries are
 * exhausted. A blocked dealer is surfaced to the caller as a refusal — never
 * escalated with stealth or retry-harder tactics.
 *
 * MUTATION — exactly one mutating face (`session.submitForm`). It routes
 * through the L2 `withGate` funnel; the form fill + submit click happen only
 * inside an approved commit, with the L1 env fuse re-asserted immediately
 * before the click. Read faces are ungated.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page, Response } from "playwright";
import { classifyBlockSignature } from "./blockSignature.js";
import {
  assertEnvFuseDisarmed,
  withGate,
  type Approver,
  type GateRequest,
} from "./gate/index.js";

// ---------------------------------------------------------------------------
// Emitter — the voiced-trace surface. The app layer adapts this onto the
// per-run SSE stream (browser.opened/.action/.error/.closed kinds).
// ---------------------------------------------------------------------------

export interface BrowserEmitter {
  opened(url?: string): void;
  action(type: string, target: string, screenshotB64?: string): void;
  error(message: string, screenshotB64?: string): void;
  closed(): void;
}

/** No-op emitter for callers that don't stream (unit paths, scripts). */
export const NULL_EMITTER: BrowserEmitter = {
  opened: () => undefined,
  action: () => undefined,
  error: () => undefined,
  closed: () => undefined,
};

/**
 * Wrap an emitter so `opened` fires AT MOST ONCE per session, remembering
 * whether it ever fired (the matching `closed` in cleanup is emitted only if
 * the browser was ever announced). Pure and unit-testable.
 */
export function openedOnce(emitter: BrowserEmitter): {
  opened(url?: string): void;
  didOpen(): boolean;
} {
  let fired = false;
  return {
    opened(url?: string): void {
      if (fired) return;
      fired = true;
      emitter.opened(url);
    },
    didOpen: () => fired,
  };
}

// ---------------------------------------------------------------------------
// Isolation — the controlled browser must never show a personal-profile page.
// ---------------------------------------------------------------------------

/** Substring denylist: any of these in a URL means the controlled browser is
 *  looking at the user's personal browsing surface — stop immediately. */
const ISOLATION_DENYLIST = [
  "chrome://history",
  "chrome://settings",
  "mail.google.com",
  "accounts.google.com",
] as const;

export class BrowserIsolationError extends Error {
  constructor(url: string, matched: string) {
    super(
      "BLOCKED: detected personal-profile Chrome page in the controlled browser. " +
        `URL "${url}" matched denylist entry "${matched}" — the automated browser must ` +
        "never touch personal pages; stopping this session.",
    );
    this.name = "BrowserIsolationError";
  }
}


/**
 * Throw `BrowserIsolationError` if any URL matches the personal-page denylist
 * (plain substring match — fail-closed over precision). Pure and unit-testable;
 * the session wires it onto page creation and every frame navigation.
 */
export function assertIsolated(urls: string[]): void {
  for (const url of urls) {
    for (const entry of ISOLATION_DENYLIST) {
      if (url.includes(entry)) {
        throw new BrowserIsolationError(url, entry);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pure politeness helpers (unit-tested with injected rand).
// ---------------------------------------------------------------------------

/** Full-jitter exponential backoff: a uniform draw over [0, min(cap, base*2^attempt)). */
export function computeBackoffMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  rand: () => number = Math.random,
): number {
  return rand() * Math.min(capMs, baseMs * 2 ** attempt);
}

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

// ---------------------------------------------------------------------------
// Pure read helpers (unit-tested).
// ---------------------------------------------------------------------------

/** Snapshot text cap — keeps the fallback payload bounded for model context. */
export const SNAPSHOT_CAP_CHARS = 120_000;

export function capSnapshot(text: string): string {
  return text.length > SNAPSHOT_CAP_CHARS ? text.slice(0, SNAPSHOT_CAP_CHARS) : text;
}

/**
 * The extract-vs-snapshot completeness decision: a row is complete when every
 * required key is non-null/non-undefined; the evaluate path wins only when at
 * least one row came back AND all rows are complete.
 */
export function rowsComplete<R extends Record<string, unknown>>(
  rows: R[],
  required: (keyof R & string)[],
): { allComplete: boolean; completeRows: R[] } {
  const completeRows = rows.filter((row) =>
    required.every((key) => row[key] !== null && row[key] !== undefined),
  );
  return {
    allComplete: rows.length > 0 && completeRows.length === rows.length,
    completeRows,
  };
}

// ---------------------------------------------------------------------------
// Session types.
// ---------------------------------------------------------------------------

export interface BrowserContextOptions {
  /** Default: headless unless AUTOBROKER_CHROME_HEADLESS=0 (explicit value wins). */
  headless?: boolean;
  emitter?: BrowserEmitter;
  /** Default: <AUTOBROKER_DATA_DIR or ~/.autobroker-ts>/traces (created if missing). */
  tracesDir?: string;
}

export interface DealerLeadForm {
  url: string;
  /** Field `name` attribute -> value. Fake phone unless the user explicitly opted in. */
  fields: Record<string, string>;
  /** CSS selector for the submit control. */
  submitSelector: string;
}

/** Matcher accepted by `readJson` — same shapes Playwright's waitForResponse takes. */
export type ResponseMatch =
  | string
  | RegExp
  | ((response: Response) => boolean | Promise<boolean>);

export type ExtractFallbackResult<R extends Record<string, unknown>> =
  | { via: "evaluate"; rows: R[] }
  | { via: "snapshot"; completeRows: R[]; snapshotText: string };

export interface BrowserSession {
  newPage(): Promise<Page>;
  navigate(
    page: Page,
    url: string,
  ): Promise<{ robotsDisallowed: boolean; blocked: string | null }>;
  lazyScroll(page: Page): Promise<void>;
  readJson(
    page: Page,
    opts: { match: ResponseMatch; trigger: () => Promise<unknown> },
  ): Promise<unknown>;
  extract<R>(page: Page, fn: () => R[]): Promise<R[]>;
  snapshot(page: Page): Promise<string>;
  screenshot(page: Page): Promise<Buffer>;
  extractWithFallback<R extends Record<string, unknown>>(
    page: Page,
    fn: () => R[],
    required: (keyof R & string)[],
  ): Promise<ExtractFallbackResult<R>>;
  withTraceChunk<T>(name: string, fn: () => Promise<T>): Promise<T>;
  submitForm(
    page: Page,
    form: DealerLeadForm,
    approver: Approver,
  ): Promise<{ submitted: true } | { declined: true }>;
}

// ---------------------------------------------------------------------------
// Tunables.
// ---------------------------------------------------------------------------

const MIN_HOST_INTERVAL_MS = 2_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 8_000;
const MAX_BLOCK_RETRIES = 2; // retries AFTER the first 429/403 response
const NAV_TIMEOUT_MS = 15_000;
const NETWORK_IDLE_TIMEOUT_MS = 4_000;
const ROBOTS_FETCH_TIMEOUT_MS = 5_000;
const MAX_LAZY_SCROLL_PASSES = 8;
const LAZY_SCROLL_PAUSE_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default traces dir under the active data dir. The data-dir resolution is a
 *  deliberate tiny duplicate of the db package's resolver so loading the
 *  browser service never drags the native sqlite module into the import graph.
 *  Tilde is expanded — Node does not expand "~" itself. */
function defaultTracesDir(): string {
  const raw = process.env.AUTOBROKER_DATA_DIR ?? join(homedir(), ".autobroker-ts");
  const dataDir = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
  return join(dataDir, "traces");
}

// ---------------------------------------------------------------------------
// withBrowserContext — the lifecycle owner.
// ---------------------------------------------------------------------------

/**
 * Open a throwaway browser context for one run, hand the caller a
 * `BrowserSession`, and tear everything down in `finally` regardless of how
 * `fn` exits. Guarantees:
 *   - the user's real Chrome profile is never opened (ephemeral context, or a
 *     fresh temp profile dir for headed debug — removed unconditionally);
 *   - `closed()` is emitted exactly when `opened()` was ever emitted;
 *   - cleanup never throws (each step is isolated, so a failed close cannot
 *     leak the next resource or mask `fn`'s own result/error).
 */
export async function withBrowserContext<T>(
  runId: string,
  opts: BrowserContextOptions,
  fn: (session: BrowserSession) => Promise<T>,
): Promise<T> {
  const headless = opts.headless ?? process.env.AUTOBROKER_CHROME_HEADLESS !== "0";
  const emitter = opts.emitter ?? NULL_EMITTER;
  const tracesDir = opts.tracesDir ?? defaultTracesDir();
  mkdirSync(tracesDir, { recursive: true });

  const open = openedOnce(emitter);
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let tempProfileDir: string | null = null;

  try {
    if (headless) {
      // Product engine: ephemeral browser + incognito-style context. No profile
      // directory exists on disk; nothing persists between sessions.
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({ serviceWorkers: "block" });
    } else {
      // Headed debug engine: a persistent context needs a profile dir — give it
      // a FRESH throwaway one under os.tmpdir(), never the user's real profile.
      // Removed in the finally below: temp profiles leak one-per-launch when
      // debugging, so removal must be unconditional.
      tempProfileDir = mkdtempSync(join(tmpdir(), "autobroker-chromium-"));
      context = await chromium.launchPersistentContext(tempProfileDir, {
        headless: false,
        serviceWorkers: "block",
      });
    }

    await context.tracing.start({ snapshots: true, screenshots: true });

    const session = makeSession({ runId, context, emitter, open, tracesDir });
    return await fn(session);
  } catch (err) {
    try {
      emitter.error(err instanceof Error ? err.message : String(err));
    } catch {
      // a throwing emitter must not mask the original error
    }
    throw err;
  } finally {
    if (open.didOpen()) {
      try {
        emitter.closed();
      } catch {
        // cleanup never throws
      }
    }
    if (context !== null) {
      try {
        await context.tracing.stop();
      } catch {
        // tracing may already be stopped / never started
      }
      try {
        await context.close();
      } catch {
        // already closed (e.g. isolation hard-stop)
      }
    }
    if (browser !== null) {
      try {
        await browser.close();
      } catch {
        // already closed
      }
    }
    if (tempProfileDir !== null) {
      try {
        rmSync(tempProfileDir, { recursive: true, force: true });
      } catch {
        // best effort — never throw from cleanup
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Session implementation (closure over per-session state).
// ---------------------------------------------------------------------------

interface SessionDeps {
  runId: string;
  context: BrowserContext;
  emitter: BrowserEmitter;
  open: ReturnType<typeof openedOnce>;
  tracesDir: string;
}

function makeSession(deps: SessionDeps): BrowserSession {
  const { runId, context, emitter, open, tracesDir } = deps;

  // Both maps live exactly as long as one session (= one run over a handful of
  // dealer hosts), so they are never evicted.
  /** Last navigation timestamp per host — drives the min-interval throttle. */
  const lastRequestByHost = new Map<string, number>();
  /** robots.txt body per origin (null = fetch failed/non-OK → no signal). */
  const robotsByOrigin = new Map<string, string | null>();
  /** Latched by the async page guard on a denylist hit; every later session
   *  call rethrows it — the session is dead, it never proceeds. */
  let breach: BrowserIsolationError | null = null;
  let chunkCounter = 0;

  function assertNotBreached(): void {
    if (breach !== null) throw breach;
  }

  /** Isolation guard for page events. A throw inside a Playwright event
   *  listener cannot reach the caller, so the breach is latched, voiced on the
   *  emitter, and the context is torn down immediately; the next session call
   *  (and any in-flight page op, via "target closed") surfaces the stop. */
  function guard(url: string): void {
    if (breach !== null) return;
    try {
      assertIsolated([url]);
    } catch (err) {
      if (!(err instanceof BrowserIsolationError)) throw err;
      breach = err;
      try {
        emitter.error(err.message);
      } catch {
        // emitter failures never mask the breach
      }
      void context.close().catch(() => undefined); // hard stop — drop the browser
    }
  }

  async function newPage(): Promise<Page> {
    assertNotBreached();
    const page = await context.newPage();
    page.on("framenavigated", (frame) => {
      guard(frame.url());
    });
    guard(page.url()); // creation check
    assertNotBreached();
    return page;
  }

  /** Fetch + cache robots.txt once per origin per session, then answer the
   *  Disallow question for this path. Any fetch problem = no signal (false) —
   *  the robots check NEVER blocks or delays navigation beyond its own fetch. */
  async function robotsDisallowedFor(url: URL): Promise<boolean> {
    const origin = url.origin;
    if (!robotsByOrigin.has(origin)) {
      let body: string | null = null;
      try {
        const resp = await fetch(`${origin}/robots.txt`, {
          signal: AbortSignal.timeout(ROBOTS_FETCH_TIMEOUT_MS),
        });
        body = resp.ok ? await resp.text() : null;
      } catch {
        body = null;
      }
      robotsByOrigin.set(origin, body);
    }
    const robots = robotsByOrigin.get(origin) ?? null;
    return robots === null ? false : parseRobotsDisallow(robots, url.pathname + url.search);
  }

  /** Best-effort dismissal of consent banners by clicking REJECT-style buttons
   *  ONLY. Never clicks Accept — we must not consent on the user's behalf. All
   *  failures are swallowed: a stubborn banner only degrades extraction, it
   *  must never fail the navigation. */
  async function rejectCookieBanner(page: Page): Promise<void> {
    try {
      const byRole = page
        .getByRole("button", { name: /^(reject all|decline|deny|reject)$/i })
        .first();
      if (await byRole.isVisible().catch(() => false)) {
        await byRole.click({ timeout: 2_000 });
        emitter.action("cookie_reject", page.url());
        return;
      }
      const byText = page.locator("text=/^(Reject All|Decline|Deny)$/i").first();
      if (await byText.isVisible().catch(() => false)) {
        await byText.click({ timeout: 2_000 });
        emitter.action("cookie_reject", page.url());
      }
    } catch {
      // best-effort by design
    }
  }

  async function navigate(
    page: Page,
    url: string,
  ): Promise<{ robotsDisallowed: boolean; blocked: string | null }> {
    assertNotBreached();
    assertIsolated([url]); // check the TARGET before driving there
    open.opened(url); // first navigate of the session announces the browser

    // data:/about:/file: targets have no host — skip throttle and robots.
    let httpUrl: URL | null = null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") httpUrl = parsed;
    } catch {
      httpUrl = null;
    }

    let robotsDisallowed = false;
    if (httpUrl !== null) {
      const last = lastRequestByHost.get(httpUrl.hostname);
      if (last !== undefined) {
        const waitMs = politenessDelayMs(last, Date.now(), MIN_HOST_INTERVAL_MS);
        if (waitMs > 0) await sleep(waitMs);
      }
      lastRequestByHost.set(httpUrl.hostname, Date.now());
      robotsDisallowed = await robotsDisallowedFor(httpUrl);
    }

    let resp: Response | null = null;
    for (let attempt = 0; ; attempt++) {
      resp = await page.goto(url, {
        timeout: NAV_TIMEOUT_MS,
        waitUntil: "domcontentloaded",
      });
      const status = resp?.status();
      if ((status === 429 || status === 403) && attempt < MAX_BLOCK_RETRIES) {
        await sleep(computeBackoffMs(attempt, BACKOFF_BASE_MS, BACKOFF_CAP_MS));
        continue;
      }
      break;
    }

    // Best-effort settle; lazy pages keep sockets open, so a timeout is normal.
    await page
      .waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS })
      .catch(() => undefined);

    // Redirects can land anywhere — re-check where we actually ended up.
    assertIsolated([page.url()]);
    assertNotBreached();

    let blocked: string | null = null;
    const status = resp === null ? null : resp.status();
    if (resp !== null && (status === 429 || status === 403)) {
      // Retries exhausted on a block status: classify and RETURN the marker —
      // the caller tells the user this dealer refuses automated access.
      let body = "";
      try {
        body = await resp.text();
      } catch {
        try {
          body = await page.content();
        } catch {
          body = "";
        }
      }
      blocked = classifyBlockSignature(body, status);
    } else {
      await rejectCookieBanner(page);
    }

    emitter.action("navigate", url);
    if (robotsDisallowed) {
      // Recorded-only: the robots opinion rides the event stream for the audit
      // trail, but the user-directed fetch proceeded.
      emitter.action("robots_disallowed", url);
    }
    // The banner click can itself redirect; don't return success on a session
    // that latched a breach during dismissal.
    assertNotBreached();
    return { robotsDisallowed, blocked };
  }

  /** Bounded lazy-load scroll: at most 8 passes, stopping early once the
   *  document height is unchanged for 2 consecutive passes. Waits are a short
   *  network settle plus one small fixed pause per pass — bounded by
   *  construction, never an open-ended page wait. */
  async function lazyScroll(page: Page): Promise<void> {
    assertNotBreached();
    let lastHeight = -1;
    let stablePasses = 0;
    for (let pass = 0; pass < MAX_LAZY_SCROLL_PASSES && stablePasses < 2; pass++) {
      await page.evaluate("window.scrollBy(0, window.innerHeight)");
      await page
        .waitForLoadState("networkidle", { timeout: 1_000 })
        .catch(() => undefined);
      await sleep(LAZY_SCROLL_PAUSE_MS);
      const height = Number(
        await page.evaluate("document.body ? document.body.scrollHeight : 0"),
      );
      if (height === lastHeight) stablePasses += 1;
      else stablePasses = 0;
      lastHeight = height;
    }
  }

  /** Promise-before-action, enforced structurally: the response waiter is
   *  ARMED before `trigger` runs. Subscribing after the click loses the race
   *  whenever the XHR returns fast — the #1 flake source — so the helper makes
   *  the wrong ordering unwritable. */
  async function readJson(
    page: Page,
    opts: { match: ResponseMatch; trigger: () => Promise<unknown> },
  ): Promise<unknown> {
    assertNotBreached();
    const armed = page.waitForResponse(opts.match, { timeout: NAV_TIMEOUT_MS });
    try {
      await opts.trigger();
    } catch (err) {
      armed.catch(() => undefined); // don't leave a dangling rejection behind
      throw err;
    }
    const resp = await armed;
    emitter.action("read_json", resp.url());
    return resp.json();
  }

  /** Read-only in-page extraction. A non-array return (drifted page script)
   *  yields [] rather than a lying cast. */
  async function extract<R>(page: Page, fn: () => R[]): Promise<R[]> {
    assertNotBreached();
    const out = await page.evaluate(fn);
    return Array.isArray(out) ? (out as R[]) : [];
  }

  /** Rendered-text snapshot, capped so the fallback payload stays bounded. */
  async function snapshot(page: Page): Promise<string> {
    assertNotBreached();
    const text = String(
      await page.evaluate('document.body ? document.body.innerText : ""'),
    );
    return capSnapshot(text);
  }

  async function screenshot(page: Page): Promise<Buffer> {
    assertNotBreached();
    return page.screenshot();
  }

  /** Drop a tiny trace chunk into the traces dir as a durable marker that
   *  something noteworthy (e.g. an extraction fallback) happened at this point
   *  in the run. Best-effort — tracing trouble never affects the read result. */
  async function markTraceChunk(name: string): Promise<void> {
    chunkCounter += 1;
    const path = join(tracesDir, `${runId}-${name}-${chunkCounter}.zip`);
    try {
      await context.tracing.startChunk({ name });
      await context.tracing.stopChunk({ path });
    } catch {
      // marker only
    }
  }

  /**
   * Structured-extract with a voiced snapshot fallback. The evaluate path wins
   * only when at least one row came back AND every row has all required keys;
   * otherwise the degradation is announced on the emitter (this is the
   * auto-allowed equivalent-read fallback class — allowed, but never silent),
   * a trace marker is recorded, and the capped snapshot text is returned with
   * whatever complete rows were salvaged so the caller can merge.
   */
  async function extractWithFallback<R extends Record<string, unknown>>(
    page: Page,
    fn: () => R[],
    required: (keyof R & string)[],
  ): Promise<ExtractFallbackResult<R>> {
    assertNotBreached();
    const rows = await extract(page, fn);
    const { allComplete, completeRows } = rowsComplete(rows, required);
    if (allComplete) {
      return { via: "evaluate", rows };
    }
    emitter.action(
      "fallback",
      `evaluate extractor returned ${completeRows.length}/${rows.length} complete rows; falling back to snapshot`,
    );
    await markTraceChunk("fallback-snapshot");
    const snapshotText = await snapshot(page);
    return { via: "snapshot", completeRows, snapshotText };
  }

  /** Run `body` inside a trace chunk: discarded on success, saved as
   *  <tracesDir>/<runId>-<name>-<n>.zip on failure (then the error rethrows
   *  unchanged — a tracing problem never masks the real failure). Chunks do not
   *  nest; if one is already open (or tracing is unavailable) the body simply
   *  runs untraced. */
  async function withTraceChunk<T>(name: string, body: () => Promise<T>): Promise<T> {
    assertNotBreached();
    chunkCounter += 1;
    const n = chunkCounter;
    let chunkOpen = true;
    try {
      await context.tracing.startChunk({ name });
    } catch {
      chunkOpen = false; // tracing trouble must not fail the step itself
    }
    try {
      const result = await body();
      if (chunkOpen) {
        await context.tracing.stopChunk().catch(() => undefined); // success: discard
      }
      return result;
    } catch (err) {
      if (chunkOpen) {
        try {
          await context.tracing.stopChunk({
            path: join(tracesDir, `${runId}-${name}-${n}.zip`),
          });
        } catch {
          // keep the original error
        }
      }
      throw err;
    }
  }

  /**
   * The ONE mutating face of the browser service — submit a dealer lead form.
   * Delegates to `gatedSubmitForm` (factored out so the gate/decline/fuse paths
   * are unit-testable against a fake page without a browser).
   */
  async function submitForm(
    page: Page,
    form: DealerLeadForm,
    approver: Approver,
  ): Promise<{ submitted: true } | { declined: true }> {
    assertNotBreached();
    return gatedSubmitForm({ runId, page, form, approver, emitter });
  }

  return {
    newPage,
    navigate,
    lazyScroll,
    readJson,
    extract,
    snapshot,
    screenshot,
    extractWithFallback,
    withTraceChunk,
    submitForm,
  };
}

// ---------------------------------------------------------------------------
// The gated form-submit core — exported so its safety branches are pinned by
// unit tests with a fake page.
// ---------------------------------------------------------------------------

/** The minimal slice of Page the mutating face needs (real Pages satisfy it). */
export interface FormPage {
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
}

/**
 * Submit a dealer lead form through the L2 gate. The fill and the submit click
 * are reachable ONLY inside an approved gate commit; a decline returns without
 * touching the page. The L1 env fuse is re-asserted immediately before the
 * click so the outer ring holds independently of the gate path that brought us
 * here. Each verdict branch is explicit — nothing non-approved is silently
 * folded into a decline by accident.
 */
export async function gatedSubmitForm(deps: {
  runId: string;
  page: FormPage;
  form: DealerLeadForm;
  approver: Approver;
  emitter: BrowserEmitter;
}): Promise<{ submitted: true } | { declined: true }> {
  const { runId, page, form, approver, emitter } = deps;
  const req: GateRequest = {
    kind: "dealer_form_submit",
    runId,
    summary: `Submit dealer lead form at ${form.url}`,
    payload: { url: form.url, fieldCount: Object.keys(form.fields).length },
  };

  const result = await withGate(req, approver, async () => {
    for (const [name, value] of Object.entries(form.fields)) {
      await page.fill(`[name="${name}"]`, value);
    }
    // L1 outer ring, asserted AGAIN at the click boundary itself so the fuse
    // holds even if a bug ever found a way around the L2 path above.
    assertEnvFuseDisarmed("dealer_form_submit");
    await page.click(form.submitSelector); // the network mutation — gate-approved only
    emitter.action("submit", form.url);
    return { submitted: true as const };
  });

  if ("decision" in result) {
    switch (result.decision) {
      case "declined":
        return { declined: true };
      case "needs_approval":
        // The gate never returns this today; if a future gate change does, the
        // suspend-and-ask semantics must be wired here deliberately, not
        // flattened into a decline.
        throw new Error(
          "gate returned needs_approval — submitForm has no suspend path wired",
        );
      default:
        return { declined: true }; // an approved verdict never reaches here
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Names kept only because the package index re-exports them (the public
// surface is re-wired separately from this file).
// ---------------------------------------------------------------------------

/** Now simply the real Playwright Page — the scaffold-era structural slice is gone. */
export type PageLike = Page;

/** Superseded scaffold entry point. Constructing it throws so no caller can
 *  silently keep a dead path alive; the browser service API is
 *  `withBrowserContext()` / `BrowserSession` (mutating face: `submitForm`). */
export class BrowserTool {
  constructor(_approver?: Approver) {
    throw new Error(
      "BrowserTool is superseded — use withBrowserContext(runId, opts, fn); " +
        "the mutating face is session.submitForm().",
    );
  }
}
