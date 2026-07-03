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

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page, Response } from "playwright";
import { classifyBlockSignature } from "./blockSignature.js";
import {
  ExternalMutationsBlockedError,
  withGate,
  type Approver,
  type GateRequest,
} from "./gate/index.js";
import { hostLimiter } from "./limiter/index.js";
import { isBuyerMode } from "./realSend.js";

// The per-host politeness math + robots parsing now live in the Playwright-free
// limiter package (so the Gmail/LLM paths can share the LimiterRegistry without
// pulling in Playwright). Re-exported here so this module's public surface and
// its tests are unchanged.
export {
  POLITENESS_JITTER_MS,
  politenessDelayMs,
  parseRobotsDisallow,
} from "./limiter/robots.js";

// ---------------------------------------------------------------------------
// Emitter — the voiced-trace surface. The app layer adapts this onto the
// per-run SSE stream (browser.opened/.action/.error/.closed kinds).
// ---------------------------------------------------------------------------

export interface BrowserEmitter {
  opened(url?: string): void;
  action(type: string, target: string, screenshotB64?: string): void;
  error(message: string, screenshotB64?: string): void;
  closed(): void;
  /**
   * On-demand browser-acquire progress. Fired only on the cold path where the
   * Playwright browser binary is absent and is being installed before the first
   * launch (see `ensureBrowserAcquired`). OPTIONAL so existing emitter
   * implementations stay valid without change — the acquire path calls it via
   * optional-chaining, and the app layer adapts it onto the
   * `browser.acquire.progress` SSE kind when present. `progress` is a 0..1
   * fraction when known, omitted when the installer only streams log lines.
   */
  acquireProgress?(message: string, progress?: number): void;
}

/** No-op emitter for callers that don't stream (unit paths, scripts). */
export const NULL_EMITTER: BrowserEmitter = {
  opened: () => undefined,
  action: () => undefined,
  error: () => undefined,
  closed: () => undefined,
  acquireProgress: () => undefined,
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

// (POLITENESS_JITTER_MS, politenessDelayMs, parseRobotsDisallow now live in
// ./limiter/robots.ts and are re-exported above; the per-host throttle itself is
// the process-global hostLimiter — see navigate().)

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
  /** Optional abort: on abort the context is closed, which rejects any in-flight
   *  nav ("Target closed") so `fn` settles promptly and the finally below runs FULL
   *  teardown (incl. browser.close()). A caller wraps this with a per-call deadline so
   *  one slow/hung site can never leave a Chromium process (and its FDs) leaked. */
  signal?: AbortSignal;
}

export interface DealerLeadForm {
  url: string;
  /** Field `name` attribute -> value. Fake phone unless the user explicitly opted in. */
  fields: Record<string, string>;
  /** CSS selector for the submit control. */
  submitSelector: string;
}

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
  /** Filter face (read-side inventory refinement; allowlisted + fenced,
   *  ungated by design — see the filter-face section below). */
  setFilterSelect(page: Page, selector: string, option: string): Promise<void>;
  clickFilterApply(page: Page, selector: string): Promise<void>;
  /** Location-ZIP face (opt-in per skill): type the profile's ZIP into the
   *  page's own location picker so region-priced content renders. Fenced like
   *  the filter face + a US-ZIP-only value constraint; ungated, holds no
   *  Approver. ZIP DIGITS ONLY — never a name/phone/address. */
  fillLocationZip(page: Page, selector: string, zip: string): Promise<void>;
  extract<R>(page: Page, fn: () => R[]): Promise<R[]>;
  snapshot(page: Page): Promise<string>;
  extractWithFallback<R extends Record<string, unknown>>(
    page: Page,
    fn: () => R[],
    required: (keyof R & string)[],
  ): Promise<ExtractFallbackResult<R>>;
  submitForm(
    page: Page,
    form: DealerLeadForm,
    approver: Approver,
  ): Promise<{ submitted: true } | { declined: true }>;
}

// ---------------------------------------------------------------------------
// Tunables.
// ---------------------------------------------------------------------------

// Per-host min-interval throttling moved to the process-global hostLimiter
// (shared across profiles); its default per-host interval is 2_000ms.
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 8_000;
const MAX_BLOCK_RETRIES = 2; // retries AFTER the first 429/403 response
const NAV_TIMEOUT_MS = 15_000;
const NETWORK_IDLE_TIMEOUT_MS = 4_000;
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
// Browser acquire — install the Playwright browser ON DEMAND.
//
// The packaged desktop app does NOT bundle the ~150MB Chromium binary (it would
// blow the .app size budget and force code-signing of a third-party binary).
// Instead the binary is fetched on first use into the standard ms-playwright
// cache, which lives OUTSIDE the app bundle (no codesign, survives app updates).
// The first browser launch ensures the binary is acquired: present → fast no-op;
// absent → `playwright install chromium` with progress voiced on the emitter so
// the UI can show a download bar, then launch proceeds normally.
//
// The presence check and the installer are injected (real defaults below) so the
// unit tests never touch the filesystem or spawn a real download.
// ---------------------------------------------------------------------------

/** Streamed progress callback the installer feeds (one call per noteworthy line
 *  / step). `progress` is a 0..1 fraction when the installer reports one. */
export type AcquireProgress = (message: string, progress?: number) => void;

/** Injectable acquire seam: is the browser binary present, and how to install
 *  it. Real implementations resolve/launch Playwright's own CLI; tests stub both
 *  so no real download or filesystem touch happens. */
export interface BrowserAcquireDeps {
  /** True when the launchable Chromium binary already exists on disk. */
  isPresent(): boolean;
  /** Download the Chromium binary, reporting progress as it goes. Resolves once
   *  the binary is installed; rejects if the install fails (e.g. no network). */
  install(onProgress: AcquireProgress): Promise<void>;
}

/** Whether Playwright's expected Chromium executable actually exists on disk.
 *  `chromium.executablePath()` returns the EXPECTED cache path even when the
 *  binary was never downloaded, so existence must be checked separately. */
function realBrowserPresent(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    // executablePath() can throw if the registry can't resolve a path at all;
    // treat that as "absent" so the install path runs.
    return false;
  }
}

/** Run `playwright install chromium` via Playwright's own CLI, streaming its
 *  stdout/stderr lines to `onProgress`. Lands the binary in the ms-playwright
 *  cache outside any app bundle. Rejects on a non-zero exit (e.g. no network),
 *  so the caller can surface the failure rather than launch into a missing
 *  binary. */
function realBrowserInstall(onProgress: AcquireProgress): Promise<void> {
  return new Promise((resolve, reject) => {
    // Resolve Playwright's bundled CLI entry so we run the SAME version that
    // owns the cache (no global `playwright` binary dependency). The CLI file is
    // not exposed via the package `exports` map, so derive it from the package
    // root + its `bin.playwright` entry (package.json IS exported).
    let cliPath: string;
    try {
      const req = createRequire(import.meta.url);
      const pkgJsonPath = req.resolve("playwright/package.json");
      const pkg = req("playwright/package.json") as { bin?: Record<string, string> };
      const cliRel = pkg.bin?.["playwright"] ?? "cli.js";
      cliPath = join(dirname(pkgJsonPath), cliRel);
    } catch (err) {
      reject(
        new Error(
          "cannot locate the Playwright CLI to install the browser on demand: " +
            (err instanceof Error ? err.message : String(err)),
        ),
      );
      return;
    }

    onProgress("Downloading browser…");
    const child = spawn(process.execPath, [cliPath, "install", "chromium"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onLine = (chunk: Buffer): void => {
      const text = chunk.toString("utf8").trim();
      if (text === "") return;
      // Playwright prints a percentage during the download (e.g. "|  42% of …");
      // surface it as a fraction when present so the UI can render a bar.
      const pctMatch = text.match(/(\d{1,3})%/);
      const progress = pctMatch ? Math.min(100, Number(pctMatch[1])) / 100 : undefined;
      onProgress(text, progress);
    };
    child.stdout?.on("data", onLine);
    child.stderr?.on("data", onLine);

    child.on("error", (err) => {
      reject(
        new Error(
          `browser install failed to start (no network or missing toolchain): ${err.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        onProgress("Browser ready.", 1);
        resolve();
      } else {
        reject(new Error(`browser install exited with code ${code ?? "null"}`));
      }
    });
  });
}

const realAcquireDeps: BrowserAcquireDeps = {
  isPresent: realBrowserPresent,
  install: realBrowserInstall,
};

let injectedAcquireDeps: BrowserAcquireDeps | undefined;

function acquireDeps(): BrowserAcquireDeps {
  return injectedAcquireDeps ?? realAcquireDeps;
}

/**
 * TEST-ONLY seam. Refused outside a test runner — a production caller must never
 * redirect the real presence check / installer. Pass a partial; unspecified
 * members keep their real implementation.
 */
export function __setBrowserAcquireDepsForTests(partial: Partial<BrowserAcquireDeps>): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__setBrowserAcquireDepsForTests is a test-only seam (refused outside a test runner)",
    );
  }
  injectedAcquireDeps = { ...realAcquireDeps, ...partial };
}

/** Restore the real acquire wiring between test cases. */
export function __resetBrowserAcquireDepsForTests(): void {
  injectedAcquireDeps = undefined;
}

/**
 * Ensure the Playwright browser binary is acquired before a launch. Idempotent:
 *   - present → return immediately (the install path is NEVER invoked, so a
 *     normal launch on a provisioned machine pays nothing — the built browser
 *     skills behave exactly as before);
 *   - absent → run the on-demand install, voicing each progress step on the
 *     emitter's `acquireProgress` (when the emitter provides one) so the UI can
 *     adapt it onto the `browser.acquire.progress` SSE kind, then return.
 * An install failure rejects so the launch is not attempted into a missing
 * binary (the caller surfaces the error rather than hanging on a launch).
 */
export async function ensureBrowserAcquired(
  emitter: BrowserEmitter = NULL_EMITTER,
  deps: BrowserAcquireDeps = acquireDeps(),
): Promise<void> {
  if (deps.isPresent()) return; // fast path — already provisioned
  await deps.install((message, progress) => {
    emitter.acquireProgress?.(message, progress);
  });
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
    // Ensure the browser binary exists before launching. Present → instant
    // no-op (launch behavior unchanged); absent → install-on-demand with
    // progress voiced on the emitter, then launch into the freshly-cached
    // binary. Both engines below need the same binary, so this guards both.
    await ensureBrowserAcquired(emitter);

    if (headless) {
      // Product engine: ephemeral browser + incognito-style context. No profile
      // directory exists on disk; nothing persists between sessions.
      // channel:"chromium" = the NEW headless mode (the full browser binary,
      // not the legacy headless shell) — its network fingerprint matches real
      // Chrome, which measurably lowers first-request anti-bot refusals on
      // dealer sites; the legacy shell announced itself at the TLS layer.
      browser = await chromium.launch({ headless: true, channel: "chromium" });
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

    // Abort → close the context so a per-call timeout actually frees the browser
    // tree. Closing the context rejects any in-flight nav, `fn` settles, and the
    // finally below runs full teardown (incl. browser.close()). Without this an
    // un-deadlined hung nav never lets `fn` settle, so the finally never runs and
    // the Chromium process + its FDs leak — the batch-submit hang root cause when
    // many dealer sites are navigated at once.
    if (opts.signal !== undefined) {
      const ctx = context;
      if (opts.signal.aborted) {
        void ctx.close().catch(() => undefined);
      } else {
        opts.signal.addEventListener(
          "abort",
          () => void ctx.close().catch(() => undefined),
          { once: true },
        );
      }
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

  // Per-host throttle state + robots cache are now PROCESS-GLOBAL (the
  // hostLimiter), shared across every session/profile, not per-session maps.
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

  /** Best-effort dismissal of consent banners by clicking ACCEPT-style buttons.
   *  Consent is authorized for access: many OEM/dealer pages gate their
   *  localized content (region-priced offers, inventory) behind a cookie
   *  acceptance, so accepting raises the access rate without leaking any user
   *  data (a cookie click carries no PII). All failures are swallowed: a
   *  stubborn banner only degrades extraction, it must never fail the
   *  navigation. */
  async function acceptCookieConsent(page: Page): Promise<void> {
    try {
      const byRole = page
        .getByRole("button", { name: /^(accept all|accept|allow all|allow|agree|i accept|got it|ok)$/i })
        .first();
      if (await byRole.isVisible().catch(() => false)) {
        await byRole.click({ timeout: 2_000 });
        emitter.action("cookie_accept", page.url());
        return;
      }
      const byText = page
        .locator("text=/^(Accept All|Accept|Allow All|Allow|Agree|I Accept|Got it|OK)$/i")
        .first();
      if (await byText.isVisible().catch(() => false)) {
        await byText.click({ timeout: 2_000 });
        emitter.action("cookie_accept", page.url());
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
      // robots (recorded-only Disallow) + crawl-delay come from the
      // process-global hostLimiter; this also warms the per-host spacing/cache.
      robotsDisallowed = await hostLimiter.robotsDisallowed(httpUrl);
    }

    // The navigation runs UNDER the process-global per-host politeness:
    // min-interval (or robots crawl-delay) spacing + concurrency ≤ 2, SHARED
    // across every profile/session. The 429/403 backoff-retry is unchanged.
    // runGoto RETURNS the response (rather than closing over an outer `let`) so
    // the type stays Response|null through the host-limiter wrapper.
    const runGoto = async (): Promise<Response | null> => {
      let r: Response | null = null;
      for (let attempt = 0; ; attempt++) {
        r = await page.goto(url, {
          timeout: NAV_TIMEOUT_MS,
          waitUntil: "domcontentloaded",
        });
        const status = r?.status();
        if ((status === 429 || status === 403) && attempt < MAX_BLOCK_RETRIES) {
          await sleep(computeBackoffMs(attempt, BACKOFF_BASE_MS, BACKOFF_CAP_MS));
          continue;
        }
        break;
      }
      return r;
    };
    const resp: Response | null =
      httpUrl !== null ? await hostLimiter.runHostRequest(httpUrl, runGoto) : await runGoto();

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
      await acceptCookieConsent(page);
    }

    // Live-view screenshot at the navigate-settle moment — the one read-path
    // capture point ("I can see what the browser sees"). Bounded by format:
    // jpeg quality 50 at the default 1280×720 viewport (~12–24KB; Playwright
    // supports only png|jpeg). Best-effort: a capture failure never fails the
    // navigation. READ FACE ONLY — the mutating face (gatedSubmitForm) never
    // captures: a filled lead form is user PII, and its durable evidence
    // channel is the lead_submissions.screenshot_path FILE, never the wire.
    let settleShotB64: string | undefined;
    try {
      settleShotB64 = (await page.screenshot({ type: "jpeg", quality: 50 })).toString("base64");
    } catch {
      settleShotB64 = undefined;
    }
    emitter.action("navigate", url, settleShotB64);
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

  // Filter face — the rung-ii inventory refinement verbs. Page-scoped,
  // fenced (denylist → lead-form structure → positive allowlist) and voiced;
  // ungated BY DESIGN: filtering is not a mutation, and these verbs hold no
  // Approver so the submitForm/withGate funnel is unreachable from here.
  async function setFilterSelect(page: Page, selector: string, option: string): Promise<void> {
    assertNotBreached();
    await runFilterVerb({ page, emitter, verb: "select", selector, option });
  }

  async function clickFilterApply(page: Page, selector: string): Promise<void> {
    assertNotBreached();
    await runFilterVerb({ page, emitter, verb: "apply", selector });
  }

  // Location-ZIP face — fill the profile's ZIP into the page's own location
  // picker so region-priced content renders. Same fences as the filter face
  // plus a US-ZIP-only value gate; ungated, no Approver — a localizer is not a
  // mutation, so the submitForm/withGate funnel is unreachable from here.
  async function fillLocationZip(page: Page, selector: string, zip: string): Promise<void> {
    assertNotBreached();
    await runLocationZip({ page, emitter, selector, zip });
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
    setFilterSelect,
    clickFilterApply,
    fillLocationZip,
    extract,
    snapshot,
    extractWithFallback,
    submitForm,
  };
}

// ---------------------------------------------------------------------------
// Filter interaction face — read-side inventory refinement (modeled on the
// acceptCookieConsent idiom: page-scoped, allowlisted, voiced on the emitter).
// These verbs hold NO Approver and never touch withGate/submitForm — filter
// refinement is not a mutation, so the capture path stays structurally unable
// to reach the one mutating funnel. Three code-level fences, in precedence
// order:
//   (a) hard text+selector DENYLIST, checked FIRST — anything worded like a
//       lead-capture control refuses loudly;
//   (b) structural assertion — the target must NOT sit inside a <form>
//       subtree that collects email/phone (a lead-capture form);
//   (c) positive allowlist — only <select> option setting, checkbox/radio
//       ticking, and clicking an apply/update-results/search-inventory
//       button are expressible at all.
// ---------------------------------------------------------------------------

/** Lead-capture wording observed across the major dealer platforms ("Check
 *  Availability", "Get Pre-approved Now", "Value Your Trade", "Get Quote",
 *  "Test Drive", …). A target whose accessible text OR selector matches is
 *  refused outright. */
export const FILTER_DENYLIST_RE =
  /e-?price|check availability|value( your)? trade|pre-?approv|test drive|contact|quote|chat|offer|financ|reserve/i;

/** The only button wording the apply verb may click. */
export const FILTER_APPLY_TEXT_RE = /apply|update results|search inventory/i;

export type FilterVerb = "select" | "apply";

/** Structural DOM slices for the in-page probe (this package compiles without
 *  the DOM lib; real elements satisfy these, tests stub them). */
export interface FilterDomElement {
  tagName: string;
  textContent: string | null;
  parentElement: FilterDomElement | null;
  getAttribute(name: string): string | null;
  closest(selector: string): FilterDomElement | null;
  querySelector(selector: string): FilterDomElement | null;
}
export interface FilterDomDocument {
  querySelector(selector: string): FilterDomElement | null;
}

/** What the in-page probe reports about a proposed filter target. */
export interface FilterTargetProbe {
  tag: string;
  inputType: string | null;
  role: string | null;
  accessibleText: string;
  inPiiForm: boolean;
}

export class FilterInteractionRefusedError extends Error {
  constructor(verb: FilterVerb, selector: string, why: string) {
    super(
      `REFUSED filter ${verb} on "${selector}": ${why}. Filter verbs only ` +
        "refine read-side inventory results; anything shaped like a " +
        "lead-capture control is out of bounds.",
    );
    this.name = "FilterInteractionRefusedError";
  }
}

/**
 * In-page probe: describe the FIRST element matching `selector` for the
 * fences (null = no match / no document). Executes inside the page via
 * page.evaluate, so it is fully self-contained — it must not reference
 * anything from module scope.
 */
export function probeFilterTarget(selector: string): FilterTargetProbe | null {
  const doc = (globalThis as { document?: FilterDomDocument }).document;
  if (doc === undefined) return null;
  const el = doc.querySelector(selector);
  if (el === null) return null;

  const tag = el.tagName.toLowerCase();
  const typeAttr = el.getAttribute("type");

  // A control's lead-capture wording usually lives on its label rather than
  // the control itself — fold wrapping and for-linked labels into the text.
  let labelText = "";
  const wrapping = el.closest("label");
  if (wrapping !== null) labelText += ` ${wrapping.textContent ?? ""}`;
  const id = el.getAttribute("id");
  if (id !== null && id !== "") {
    const forLabel = doc.querySelector(`label[for="${id.replace(/"/g, '\\"')}"]`);
    if (forLabel !== null) labelText += ` ${forLabel.textContent ?? ""}`;
  }

  let inPiiForm = false;
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    if (
      node.tagName.toLowerCase() === "form" &&
      node.querySelector('input[type="email"], input[type="tel"]') !== null
    ) {
      inPiiForm = true;
      break;
    }
  }

  return {
    tag,
    inputType: typeAttr === null ? null : typeAttr.toLowerCase(),
    role: el.getAttribute("role"),
    accessibleText: [
      el.textContent ?? "",
      el.getAttribute("aria-label") ?? "",
      el.getAttribute("value") ?? "",
      el.getAttribute("title") ?? "",
      labelText,
    ].join(" "),
    inPiiForm,
  };
}

/**
 * The three fences, in precedence order — denylist FIRST, then the lead-form
 * structure check, then the per-verb positive allowlist. Pure; throws
 * `FilterInteractionRefusedError` (refuse loudly, never skip silently).
 */
export function assertFilterTargetAllowed(
  verb: FilterVerb,
  selector: string,
  probe: FilterTargetProbe,
): void {
  if (FILTER_DENYLIST_RE.test(probe.accessibleText) || FILTER_DENYLIST_RE.test(selector)) {
    throw new FilterInteractionRefusedError(
      verb,
      selector,
      "target matches the lead-capture denylist",
    );
  }
  if (probe.inPiiForm) {
    throw new FilterInteractionRefusedError(
      verb,
      selector,
      "target sits inside a <form> that collects email/phone (a lead-capture form)",
    );
  }
  switch (verb) {
    case "select":
      if (probe.tag !== "select") {
        throw new FilterInteractionRefusedError(
          verb,
          selector,
          `only <select> widgets are settable (got <${probe.tag}>)`,
        );
      }
      return;
    case "apply": {
      const buttonish =
        probe.tag === "button" ||
        probe.role === "button" ||
        (probe.tag === "input" &&
          (probe.inputType === "button" || probe.inputType === "submit"));
      if (!buttonish) {
        throw new FilterInteractionRefusedError(
          verb,
          selector,
          `apply target must be a button (got <${probe.tag}>)`,
        );
      }
      if (!FILTER_APPLY_TEXT_RE.test(probe.accessibleText)) {
        throw new FilterInteractionRefusedError(
          verb,
          selector,
          "apply button text must read apply / update results / search inventory",
        );
      }
      return;
    }
  }
}

/** The minimal slice of Page the filter verbs need (real Pages satisfy it). */
export interface FilterControlPage {
  evaluate(
    fn: (selector: string) => FilterTargetProbe | null,
    selector: string,
  ): Promise<FilterTargetProbe | null>;
  selectOption(
    selector: string,
    values: ReadonlyArray<{ value?: string; label?: string }>,
  ): Promise<unknown>;
  click(selector: string): Promise<void>;
}

/**
 * The filter-verb core — exported so the fences and the no-action-on-refusal
 * guarantee are pinned by unit tests with a fake page. Probe → fences → act →
 * voice; a refusal throws BEFORE any page action.
 */
export async function runFilterVerb(deps: {
  page: FilterControlPage;
  emitter: BrowserEmitter;
  verb: FilterVerb;
  selector: string;
  /** Option for the select verb — matched by option value OR visible label. */
  option?: string;
}): Promise<void> {
  const { page, emitter, verb, selector } = deps;
  const probe = await page.evaluate(probeFilterTarget, selector);
  if (probe === null) {
    throw new FilterInteractionRefusedError(verb, selector, "no element matches the selector");
  }
  assertFilterTargetAllowed(verb, selector, probe);
  switch (verb) {
    case "select": {
      const option = deps.option;
      if (option === undefined || option === "") {
        throw new FilterInteractionRefusedError(verb, selector, "select verb needs an option");
      }
      await page.selectOption(selector, [{ value: option }, { label: option }]);
      emitter.action("filter_select", `${selector} = ${option}`);
      return;
    }
    case "apply":
      await page.click(selector);
      emitter.action("filter_apply", selector);
      return;
  }
}

// ---------------------------------------------------------------------------
// Location-ZIP face — sidesteps the SSRF two-param block by letting the PAGE
// make its own localization XHR: we fill the profile's POSTAL CODE into the
// page's own ZIP/location picker (DOM interaction), so region-priced content
// (localized "Featured Cash"/offers, local inventory) renders. Built on the
// SAME safety construction as the filter face, with the SAME three fences PLUS
// a positive input allowlist and a hard value constraint:
//   (a) hard lead-capture DENYLIST (FILTER_DENYLIST_RE), checked FIRST;
//   (b) structural fence — a ZIP field inside an email/tel lead form is
//       REFUSED (inPiiForm), so we never type into a contact funnel;
//   (c) positive allowlist — the target must be a text/tel/number/search
//       <input> whose name/id/placeholder/accessible text reads zip/postal/
//       location;
//   (d) VALUE hard-constraint — only a US ZIP (/^\d{5}(-\d{4})?$/) types at
//       all. Name, phone, and street address are NEVER passed to this face and
//       structurally cannot be (a non-ZIP value is refused loudly).
// This face holds NO Approver and never touches withGate/submitForm — a
// localizer is not a mutation, so the capture path stays structurally unable to
// reach the mutating funnel.
// ---------------------------------------------------------------------------

/** The ONLY value shape the ZIP face accepts: a US 5-digit ZIP, optionally
 *  ZIP+4. Anything else (a name, phone, street, partial digits) is refused —
 *  the localizer types digits, never identity. */
export const ZIP_VALUE_RE = /^\d{5}(-\d{4})?$/;

/** Positive allowlist for the target: its name/id/placeholder/accessible text
 *  must read like a location/ZIP control. A clean-worded but unrelated input
 *  (search-by-keyword, quantity, …) is refused. */
export const ZIP_FIELD_RE = /zip|postal|location/i;

/** What the in-page probe reports about a proposed ZIP target. Extends the
 *  filter probe shape with the attributes the input allowlist matches on. */
export interface ZipTargetProbe {
  tag: string;
  inputType: string | null;
  name: string | null;
  id: string | null;
  placeholder: string | null;
  accessibleText: string;
  inPiiForm: boolean;
}

export class LocationZipRefusedError extends Error {
  constructor(selector: string, why: string) {
    super(
      `REFUSED location-zip fill on "${selector}": ${why}. The localizer only ` +
        "types a US ZIP into a page's own location picker to render region-" +
        "priced content; identity fields and lead-capture forms are out of bounds.",
    );
    this.name = "LocationZipRefusedError";
  }
}

/**
 * In-page probe: describe the FIRST element matching `selector` for the ZIP
 * fences (null = no match / no document). Executes inside the page via
 * page.evaluate, so it is fully self-contained — it must not reference anything
 * from module scope.
 */
export function probeZipTarget(selector: string): ZipTargetProbe | null {
  const doc = (globalThis as { document?: FilterDomDocument }).document;
  if (doc === undefined) return null;
  const el = doc.querySelector(selector);
  if (el === null) return null;

  const tag = el.tagName.toLowerCase();
  const typeAttr = el.getAttribute("type");

  // Lead-capture wording usually lives on the label, not the control.
  let labelText = "";
  const wrapping = el.closest("label");
  if (wrapping !== null) labelText += ` ${wrapping.textContent ?? ""}`;
  const id = el.getAttribute("id");
  if (id !== null && id !== "") {
    const forLabel = doc.querySelector(`label[for="${id.replace(/"/g, '\\"')}"]`);
    if (forLabel !== null) labelText += ` ${forLabel.textContent ?? ""}`;
  }

  let inPiiForm = false;
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    if (
      node.tagName.toLowerCase() === "form" &&
      node.querySelector('input[type="email"], input[type="tel"]') !== null
    ) {
      inPiiForm = true;
      break;
    }
  }

  return {
    tag,
    inputType: typeAttr === null ? null : typeAttr.toLowerCase(),
    name: el.getAttribute("name"),
    id: id === "" ? null : id,
    placeholder: el.getAttribute("placeholder"),
    accessibleText: [
      el.textContent ?? "",
      el.getAttribute("aria-label") ?? "",
      el.getAttribute("title") ?? "",
      labelText,
    ].join(" "),
    inPiiForm,
  };
}

/**
 * The ZIP fences, in precedence order — denylist FIRST, then the lead-form
 * structure check, then the positive input-type+wording allowlist. Pure;
 * throws `LocationZipRefusedError` (refuse loudly, never skip silently). Does
 * NOT validate the value — `assertZipValue` does that separately so a bad value
 * is rejected even before a target is probed.
 */
export function assertZipTargetAllowed(selector: string, probe: ZipTargetProbe): void {
  const idText = [probe.name ?? "", probe.id ?? "", probe.placeholder ?? "", probe.accessibleText]
    .join(" ");
  if (FILTER_DENYLIST_RE.test(idText) || FILTER_DENYLIST_RE.test(selector)) {
    throw new LocationZipRefusedError(selector, "target matches the lead-capture denylist");
  }
  if (probe.inPiiForm) {
    throw new LocationZipRefusedError(
      selector,
      "target sits inside a <form> that collects email/phone (a lead-capture form)",
    );
  }
  const ALLOWED_INPUT_TYPES = new Set([null, "text", "tel", "number", "search"]);
  if (probe.tag !== "input" || !ALLOWED_INPUT_TYPES.has(probe.inputType)) {
    throw new LocationZipRefusedError(
      selector,
      `only text/tel/number/search <input> is fillable (got <${probe.tag} type=${probe.inputType ?? "?"}>)`,
    );
  }
  if (!ZIP_FIELD_RE.test(idText)) {
    throw new LocationZipRefusedError(
      selector,
      "target name/id/placeholder/label must read zip / postal / location",
    );
  }
}

/** The value gate — pure. Only a US ZIP types; anything else throws. Kept
 *  separate so the constraint is provable in isolation and a non-ZIP value is
 *  rejected up front (no identity field can ever flow into the fill). */
export function assertZipValue(value: string): void {
  if (!ZIP_VALUE_RE.test(value)) {
    throw new LocationZipRefusedError(
      "<value>",
      `value ${JSON.stringify(value)} is not a US ZIP (/^\\d{5}(-\\d{4})?$/); the ` +
        "localizer types ZIP digits only — never a name, phone, or address",
    );
  }
}

/** The minimal slice of Page the ZIP face needs (real Pages satisfy it). The
 *  options arg carries Playwright's { force, timeout } so the localizer can
 *  fall back to a forced fill when a real picker is present but visually
 *  collapsed (many OEM pages park the ZIP input behind a "set location" widget
 *  with zero layout box until opened). */
export interface ZipFillOptions {
  force?: boolean;
  timeout?: number;
}
export interface ZipControlPage {
  evaluate(
    fn: (selector: string) => ZipTargetProbe | null,
    selector: string,
  ): Promise<ZipTargetProbe | null>;
  fill(selector: string, value: string, options?: ZipFillOptions): Promise<void>;
  press(selector: string, key: string, options?: ZipFillOptions): Promise<void>;
}

/** Bound on the normal-fill actionability wait before the forced-fill fallback
 *  kicks in (a collapsed picker never becomes actionable, so this is the cost
 *  of discovering it is collapsed). */
const ZIP_FILL_TIMEOUT_MS = 2_500;

/**
 * The location-ZIP core — exported so the fences, the value constraint and the
 * no-action-on-refusal guarantee are pinned by unit tests with a fake page.
 * Order: validate the VALUE (before any page touch) → probe → fences → fill →
 * submit (Enter) → voice. A refusal throws BEFORE the fill. Holds no Approver.
 *
 * The fill is attempted normally first; if the (already-fenced) input is
 * present but not actionable — a collapsed/hidden picker — it retries with
 * Playwright's force flag and VOICES a `location_zip_forced` trace span. This
 * is a transient/equivalent fallback (the SAME fenced element, only its layout
 * box differs), never a semantic one: the safety gate already ran, so force
 * only changes the actionability wait, not what may be typed.
 */
export async function runLocationZip(deps: {
  page: ZipControlPage;
  emitter: BrowserEmitter;
  selector: string;
  zip: string;
}): Promise<void> {
  const { page, emitter, selector, zip } = deps;
  assertZipValue(zip); // value gate first — a non-ZIP never reaches the page
  const probe = await page.evaluate(probeZipTarget, selector);
  if (probe === null) {
    throw new LocationZipRefusedError(selector, "no element matches the selector");
  }
  assertZipTargetAllowed(selector, probe);
  try {
    await page.fill(selector, zip, { timeout: ZIP_FILL_TIMEOUT_MS });
    await page.press(selector, "Enter", { timeout: ZIP_FILL_TIMEOUT_MS });
  } catch {
    // The fenced input is present but not actionable (a collapsed picker) —
    // force the fill/submit and voice the equivalent-read fallback.
    emitter.action("location_zip_forced", selector);
    await page.fill(selector, zip, { force: true, timeout: ZIP_FILL_TIMEOUT_MS });
    await page.press(selector, "Enter", { force: true, timeout: ZIP_FILL_TIMEOUT_MS });
  }
  emitter.action("location_zip", `${selector} = ${zip}`);
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
 * touching the page. The AUTOBROKER_MODE send brake is asserted at the TOP of
 * the approved commit — before any fill or click — so test mode refuses without
 * touching the page at all. Each verdict branch is explicit — nothing
 * non-approved is silently folded into a decline by accident.
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
    // Mode brake at the TOP of the approved commit: in test mode the dealer form
    // submit is refused BEFORE touching the page — no real-form fill, no network
    // click. The lead-submit workflow maps the ExternalMutationsBlockedError to a
    // recorded FAKE submission, so the existing fake-record path handles the test
    // case without depending on a brittle real-form fill. (Real dealer forms vary;
    // `form.fields` is keyed by each form's real `name` attributes, so a fill on a
    // selector the live form lacks would otherwise wait the default 30s and throw
    // a hard timeout that fails the whole approved batch.) AUTOBROKER_MODE is the
    // sole send-control var: this `!isBuyerMode()` brake is the floor.
    if (!isBuyerMode()) throw new ExternalMutationsBlockedError("dealer_form_submit");
    for (const [name, value] of Object.entries(form.fields)) {
      await page.fill(`[name="${name}"]`, value);
    }
    await page.click(form.submitSelector); // the network mutation — gate-approved only
    emitter.action("submit", form.url);
    return { submitted: true as const };
  });

  if ("decision" in result) {
    switch (result.decision) {
      case "declined":
        return { declined: true };
      case "approved":
        // withGate returns a bare verdict ONLY on non-approval, so an approved
        // verdict never reaches here at runtime (the commit result is returned
        // below instead). Fold to no-effect defensively.
        return { declined: true };
      default: {
        // Exhaustiveness tripwire (replaced the old `needs_approval` throw): a
        // future GateVerdict variant can no longer silently flatten into a
        // decline — it becomes a compile error here until its suspend-and-ask
        // semantics are wired deliberately.
        const _exhaustive: never = result;
        void _exhaustive;
        return { declined: true };
      }
    }
  }
  return result;
}

