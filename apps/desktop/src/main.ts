/**
 * Electron main — dev-solo thin launcher. Zero business logic, zero IPC, no
 * preload: the renderer loads the SAME built SPA over the SAME localhost
 * HTTP+SSE the browser form uses. Three jobs only:
 *
 *   1. read the repo-root .env (tiny hand parser; values never override an
 *      already-set process env var, so an outer override wins),
 *   2. fork bundle/server.cjs as a utilityProcess with PORT=0 and parse its
 *      one listening JSON line for the ACTUAL bound port (an ephemeral port
 *      never collides with the dev server on :8100),
 *   3. open one BrowserWindow on http://127.0.0.1:<port>.
 *
 * Safety: the fork env always arms AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS=1 and
 * MASTRA_TELEMETRY_DISABLED=1. The shell adds no second path to any side
 * effect — gates and approval UI are the same server+SPA code as the web form.
 *
 * `globalThis.__desktopHook` is a read-only introspection surface for the
 * deterministic smoke suite (smoke/electron.spec.ts): the server pid/port, the
 * safety subset of the fork env, and whether a second-instance ping was seen.
 *
 * LONG-RUNNING BACKGROUND (macOS): closing the window does NOT quit on darwin —
 * the app stays alive in the background so the server child keeps the schedule
 * running; `activate` (dock click) re-creates the window; Cmd+Q (before-quit)
 * still really quits. The SCHEDULER itself lives in the server child (croner +
 * the catch-up watermark), NOT here — main only forwards Electron's
 * powerMonitor resume/suspend down to the child (it alone can see those) over
 * the utilityProcess message channel, and lends a run-scoped powerSaveBlocker
 * AROUND a single job (never held long-term — a standing blocker would defeat
 * system sleep / drain the battery). notify() is a degradation ladder
 * (focused → in-app toast; else native Notification + dock badge; failure →
 * badge + toast-on-next-focus); a notification click shows/focuses the window
 * and navigates to a placeholder (the deep-link digest target is a later wave).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  app,
  BrowserWindow,
  dialog,
  nativeImage,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  shell,
  utilityProcess,
  type UtilityProcess,
} from "electron";

const here = dirname(fileURLToPath(import.meta.url)); // apps/desktop/dist
const desktopDir = resolve(here, "..");
const repoRoot = resolve(desktopDir, "..", "..");
// Packaged (electron-builder): bundle/ ships verbatim as extraResources under
// Contents/Resources/bundle, on a real filesystem path so the forked
// server.cjs can dlopen its native .node addons (asar cannot dlopen). Dev
// (`electron .`): bundle/ sits next to the launcher. Everything downstream —
// fork target, AUTOBROKER_UI_DIST, the drizzle path inside server.cjs — keys
// off this one dir, so the dev/packaged branch lives here alone.
const bundleDir = app.isPackaged ? join(process.resourcesPath, "bundle") : join(desktopDir, "bundle");

/** KEY=VALUE lines; '#' comments and blanks skipped; optional surrounding quotes. */
function parseDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    out[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

interface DesktopHook {
  serverPid: number | null;
  port: number | null;
  forkEnvSafety: Record<string, string>;
  secondInstanceSeen: boolean;
  /** How the most recent notify() call was delivered (smoke introspection):
   *  'toast' (window focused → posted to the renderer), 'native' (native
   *  Notification shown), or 'badge' (degraded to badge + deferred toast). */
  lastNotifyChannel: "toast" | "native" | "badge" | null;
  /** The dock badge count main last set (the degraded-path signal). */
  badgeCount: number;
}
const hook: DesktopHook = {
  serverPid: null,
  port: null,
  forkEnvSafety: {},
  secondInstanceSeen: false,
  lastNotifyChannel: null,
  badgeCount: 0,
};
(globalThis as Record<string, unknown>).__desktopHook = hook;

/** The real product data dir the launcher would boot against (honors an outer
 *  override, then the .env file, then the parity-period default — the SAME
 *  resolution startServer uses). Tilde-expanded; Node does not expand "~". */
function realDataDir(): string {
  const dotEnv = parseDotEnv(join(repoRoot, ".env"));
  const dir = process.env.AUTOBROKER_DATA_DIR ?? dotEnv.AUTOBROKER_DATA_DIR ?? join(homedir(), ".autobroker-ts");
  return dir === "~" || dir.startsWith("~/") ? join(homedir(), dir.slice(1)) : dir;
}

/** True when the persisted keys file carries a non-empty deepseek entry
 *  (<dataDir>/settings/keys.json). A missing / unreadable / malformed file is
 *  "no key" — fail safe toward offering the demo. The launcher reads only this
 *  presence bit; it never holds the secret. */
function hasDeepseekKey(dataDir: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, "settings", "keys.json"), "utf8")) as Record<string, unknown>;
    return typeof parsed.deepseek === "string" && parsed.deepseek.length > 0;
  } catch {
    return false;
  }
}

/** A FRESH install has no key configured AND no product DB yet (the server has
 *  never booted in the real dir, so there are no profiles). The launcher cannot
 *  open SQLite (the system-ABI build is not loaded into the main process — the
 *  bundle has its own Electron-ABI copy), so the absence of autobroker.db is the
 *  truthful zero-dep equivalent of "no profiles".
 *
 *  The demo offer is the PRODUCTION double-click path only: an explicit
 *  AUTOBROKER_DATA_DIR / AUTOBROKER_DB override (dev, harness, the smoke suite,
 *  or an already-armed demo launch) is a deliberate boot target and never
 *  prompts. */
function isFreshInstall(dataDir: string): boolean {
  if (process.env.AUTOBROKER_DATA_DIR !== undefined) return false; // explicit target
  if (process.env.AUTOBROKER_DB !== undefined) return false;
  if (process.env.AUTOBROKER_DEMO_SEED === "1") return false; // already a demo launch
  if (hasDeepseekKey(dataDir)) return false;
  return !existsSync(join(dataDir, "autobroker.db"));
}

/** The isolated demo data dir — NEVER the real ~/.autobroker-ts. */
function demoDataDir(): string {
  return join(homedir(), ".autobroker-ts", "demo");
}

let serverProc: UtilityProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let shuttingDown = false;
/** Set by the first-run dialog: when true, startServer forks the demo world
 *  into the isolated demo dir. Env-only handoff (no IPC, no preload). */
let demoMode = false;

// ---- notify() ladder -------------------------------------------------------
// Toasts the renderer should show on its NEXT focus (the degraded path: a
// native notification could not be shown, so the user learns about it via the
// badge now and an in-app toast when they next look at the window).
const deferredToasts: Array<{ title: string; body: string; deepLink: string }> = [];

/** Show a transient in-app toast by dispatching a window CustomEvent into the
 *  renderer. No preload/IPC bridge exists (the renderer loads over localhost
 *  HTTP), so main injects a tiny script that the App's toast listener picks up.
 *  Returns false when there is no live window to post into. */
async function postToastToRenderer(title: string, body: string, deepLink: string): Promise<boolean> {
  const wc = mainWindow?.webContents;
  if (wc === undefined || wc.isDestroyed()) return false;
  const payload = JSON.stringify({ title, body, deepLink });
  try {
    await wc.executeJavaScript(
      `window.dispatchEvent(new CustomEvent("autobroker:notify", { detail: ${payload} }));`,
      true,
    );
    return true;
  } catch {
    return false;
  }
}

/** Set the dock badge to `n` (0 clears it). macOS-only API — a no-op elsewhere. */
function setBadge(n: number): void {
  hook.badgeCount = n;
  app.setBadgeCount?.(n);
}

/**
 * notify — the degradation ladder for a background event (a finished poll, a
 * ready digest). NOT a bare `new Notification()`:
 *   - window focused → an in-app toast (posted to the renderer), no OS chrome;
 *   - else a native Notification + a dock badge bump;
 *   - the native 'failed' event → silently degrade to badge + a toast queued
 *     for the next focus;
 *   - 'click' → show/focus the window and navigate to the deep link (a
 *     placeholder/home for now — the digest result page is a later-wave seam).
 * Only title/body are used: notification action buttons / inline reply require
 * code-signing (Electron 42+), out of scope here (pinned to 41 behavior).
 */
function notify(title: string, body: string, opts: { deepLink?: string } = {}): void {
  const deepLink = opts.deepLink ?? "/";
  const focused = mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isFocused();
  if (focused) {
    hook.lastNotifyChannel = "toast";
    void postToastToRenderer(title, body, deepLink);
    return;
  }

  // Not focused: native notification + badge. If the platform cannot show one
  // (Notification.isSupported() false, or the 'failed' event), degrade to a
  // badge bump plus a toast deferred to the next focus.
  const degrade = (): void => {
    hook.lastNotifyChannel = "badge";
    setBadge(hook.badgeCount + 1);
    deferredToasts.push({ title, body, deepLink });
  };

  if (!Notification.isSupported()) {
    degrade();
    return;
  }
  const n = new Notification({ title, body });
  n.on("failed", degrade);
  n.on("click", () => {
    showAndFocusWindow();
    // Deep-link navigation: the digest result page is a later wave, so navigate
    // to the placeholder/home for now. The target is the only seam here.
    void mainWindow?.webContents
      .executeJavaScript(`window.location.hash = ${JSON.stringify(deepLink)};`, true)
      .catch(() => {});
    setBadge(0);
  });
  hook.lastNotifyChannel = "native";
  setBadge(hook.badgeCount + 1);
  n.show();
}

/** Flush any toasts that were deferred while the window was unfocused/closed.
 *  Called when the window regains focus; clears the dock badge once shown. */
function flushDeferredToasts(): void {
  if (deferredToasts.length === 0) return;
  const pending = deferredToasts.splice(0, deferredToasts.length);
  void (async (): Promise<void> => {
    let shown = false;
    for (const t of pending) {
      if (await postToastToRenderer(t.title, t.body, t.deepLink)) shown = true;
    }
    if (shown) setBadge(0);
    else deferredToasts.unshift(...pending); // window vanished mid-flush; keep them
  })();
}

// Expose notify on the introspection hook. This is BOTH the injection point a
// later wave calls to raise a background notification from main (e.g. when a
// scheduled digest is ready) AND the surface the deterministic smoke suite
// drives to exercise the focused→toast path (native notifications are not
// scriptable headless). No new IPC: the renderer toast arrives via a window
// CustomEvent injected through webContents.executeJavaScript.
(hook as DesktopHook & { notify: typeof notify }).notify = notify;

// ---- powerSaveBlocker: RUN-SCOPED ONLY -------------------------------------
// A standing power-save blocker would defeat system sleep and drain the
// battery, so one is acquired ONLY for the duration of a single scheduled
// run and released immediately after. The scheduler lives in the server child,
// so main lends the blocker over the message channel: the child asks to
// acquire before a run and release after. (Jobs are no-op seams today, but the
// acquire/release contract is wired now so it is correct when jobs become
// real.) blockerId !== null means a run is currently holding the blocker.
let blockerId: number | null = null;
function acquirePowerBlocker(): void {
  if (blockerId !== null) return; // one at a time — a run is already holding it
  blockerId = powerSaveBlocker.start("prevent-app-suspension");
}
function releasePowerBlocker(): void {
  if (blockerId === null) return;
  if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
  blockerId = null;
}

/** Fork the bundled server; resolve with the actual bound port once the
 *  listening JSON line ({"server":"listening",...,"port":N}) appears. */
function startServer(): Promise<number> {
  const dotEnv = parseDotEnv(join(repoRoot, ".env"));
  const env: Record<string, string> = {
    ...dotEnv,
    ...(process.env as Record<string, string>), // an already-set var beats the .env file
    PORT: "0",
    // Demo mode forks into the ISOLATED demo dir + arms the seed; normal boot
    // uses the real data dir. The demo dir is never the real ~/.autobroker-ts.
    AUTOBROKER_DATA_DIR: demoMode
      ? demoDataDir()
      : process.env.AUTOBROKER_DATA_DIR ?? dotEnv.AUTOBROKER_DATA_DIR ?? join(homedir(), ".autobroker-ts"),
    AUTOBROKER_UI_DIST: join(bundleDir, "ui-dist"),
    AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS: "1",
    MASTRA_TELEMETRY_DISABLED: "1",
    ...(demoMode ? { AUTOBROKER_DEMO_SEED: "1" } : {}),
  };
  hook.forkEnvSafety = {
    PORT: env.PORT!,
    AUTOBROKER_DATA_DIR: env.AUTOBROKER_DATA_DIR!,
    AUTOBROKER_UI_DIST: env.AUTOBROKER_UI_DIST!,
    AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS: env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS!,
    MASTRA_TELEMETRY_DISABLED: env.MASTRA_TELEMETRY_DISABLED!,
    ...(env.AUTOBROKER_DEMO_SEED !== undefined ? { AUTOBROKER_DEMO_SEED: env.AUTOBROKER_DEMO_SEED } : {}),
  };

  return new Promise<number>((resolvePort, reject) => {
    const proc = utilityProcess.fork(join(bundleDir, "server.cjs"), [], {
      env,
      stdio: "pipe",
      serviceName: "autobroker-server",
    });
    serverProc = proc;
    // pid is only defined once the child actually spawns.
    proc.once("spawn", () => {
      hook.serverPid = proc.pid ?? null;
    });

    const timer = setTimeout(() => reject(new Error("server did not report listening within 30s")), 30_000);
    let buf = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk); // keep server logs visible when launched from a terminal
      buf += chunk.toString("utf8");
      for (const line of buf.split("\n")) {
        if (!line.includes('"server":"listening"')) continue;
        try {
          const parsed = JSON.parse(line.trim()) as { port?: number };
          if (typeof parsed.port === "number" && parsed.port > 0) {
            clearTimeout(timer);
            hook.port = parsed.port;
            resolvePort(parsed.port);
          }
        } catch {
          /* partial line — keep accumulating */
        }
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));

    // The server child asks main to lend the run-scoped powerSaveBlocker around
    // a single scheduled job (acquire before, release after). Only main can call
    // the Electron powerSaveBlocker API, so the blocker is held HERE for the
    // run's duration only — never long-term. On the UtilityProcess 'message'
    // event the payload arrives directly (no MessageEvent wrapper, unlike the
    // child's parentPort side).
    proc.on("message", (msg: unknown) => {
      if (typeof msg !== "object" || msg === null) return;
      if ((msg as { scheduler?: unknown }).scheduler !== "power_blocker") return;
      const action = (msg as { action?: unknown }).action;
      if (action === "acquire") acquirePowerBlocker();
      else if (action === "release") releasePowerBlocker();
    });

    proc.on("exit", (code) => {
      clearTimeout(timer);
      serverProc = null;
      hook.serverPid = null;
      releasePowerBlocker(); // a fork that dies mid-run must not leak the blocker
      if (!shuttingDown) void onServerExit(code);
    });
  });
}

/** Unexpected fork exit: offer relaunch (restart fork + reload window) or quit. */
async function onServerExit(code: number): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: "error",
    title: "AutoBroker",
    message: `The AutoBroker server exited unexpectedly (code ${code}).`,
    buttons: ["Relaunch server", "Quit"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    try {
      const port = await startServer();
      await mainWindow?.loadURL(`http://127.0.0.1:${port}`);
    } catch (err) {
      // A relaunched fork that spawns but never reports listening would
      // otherwise outlive the swallowed rejection as an orphan.
      serverProc?.kill();
      dialog.showErrorBox("AutoBroker", `Relaunch failed: ${String(err)}`);
      app.quit();
    }
  } else {
    app.quit();
  }
}

/**
 * First-run gate (env-only, no IPC): on a FRESH install (no DeepSeek key + no
 * product DB) offer the demo. "Try demo data" arms demoMode → startServer forks
 * the demo seed into the ISOLATED demo dir; "Set up keys" boots normally (the
 * SPA's own first-run gate then routes to /settings). Already-configured
 * installs never see this dialog. Honored only when the launcher is interactive
 * (skipped when AUTOBROKER_DEMO_SEED is already set, e.g. the smoke S8 launch).
 */
async function maybeOfferDemo(): Promise<void> {
  if (!isFreshInstall(realDataDir())) return;
  const { response } = await dialog.showMessageBox({
    type: "question",
    title: "AutoBroker",
    message: "No API key found",
    detail: "Try AutoBroker with sample demo data, or set up your keys first?",
    buttons: ["Try demo data", "Set up keys"],
    defaultId: 0,
    cancelId: 1,
  });
  demoMode = response === 0;
}

/** Show + focus the window, restoring it if minimized. A no-op when no window
 *  exists (a closed-then-background app re-creates it via `activate`). */
function showAndFocusWindow(): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Create the single BrowserWindow on the running server's port. The 'focus'
 *  listener flushes any toasts that were deferred while the window was away. */
async function createWindow(port: number): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    // plugins:true enables Chromium's built-in PDF viewer so the quote
    // source-document <embed type="application/pdf"> renders in-app (the desktop
    // shell, like the browser, shows the original PDF quote inline).
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, plugins: true },
  });

  const appOrigin = `http://127.0.0.1:${port}`;
  // External links (e.g. an inventory card's "View listing" VDP href, target=_blank)
  // must NEVER spawn a second sealed Electron window — hand http(s) URLs to the
  // system browser instead. Same one-anchor implementation works in the browser
  // (native new tab) and here.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // Belt-and-suspenders: an off-origin full navigation (a bare external <a href>
  // with no target) is cancelled and opened externally; same-origin SPA routing is
  // untouched (this fires for full-page nav, not pushState/hash deep-links).
  mainWindow.webContents.on("will-navigate", (event, url) => {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(url).origin === appOrigin; // exact origin, not a prefix
    } catch {
      sameOrigin = false; // unparseable URL → treat as off-origin
    }
    if (sameOrigin) return; // same-origin SPA navigation stays in-app
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.on("focus", flushDeferredToasts);
  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

async function run(): Promise<void> {
  // Optional runtime dock icon — `electron .` otherwise shows Electron's
  // default. The artwork is a machine-local artifact (generated next to the
  // dev launcher, never committed); silently skipped when absent.
  if (process.platform === "darwin") {
    const dockIcon = nativeImage.createFromPath(join(homedir(), ".autobroker-ts", "desktop-launcher", "icon.png"));
    if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon);
  }
  await maybeOfferDemo();
  const port = await startServer();
  await createWindow(port);
}

app.setName("autobroker-desktop"); // stable userData path → stable single-instance lock

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    hook.secondInstanceSeen = true;
    // Showing/focusing the window delivers the standard page-level `focus` +
    // `visibilitychange:visible` events to the renderer; the SPA's
    // fresh-on-refocus listeners (apps/ui useRefocusRefetch) refetch the read
    // views from there — no native refetch nudge, no preload/IPC needed.
    showAndFocusWindow();
  });

  // LONG-RUNNING BACKGROUND (darwin): closing the window does NOT quit — the
  // app (and its server child + scheduler) stays alive in the background, the
  // platform-standard macOS behavior. The dock click / `activate` re-creates
  // the window. Cmd+Q (before-quit) still really quits. Other platforms keep
  // the prior quit-on-last-window behavior.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Dock re-activation: re-create the window if it was closed (background
  // app), else just show/focus the existing one.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // The server is still running in the background; reuse its known port.
      if (hook.port !== null) void createWindow(hook.port);
    } else {
      showAndFocusWindow();
    }
  });

  // powerMonitor lives in the MAIN process (Electron) only; forward its
  // resume/suspend to the server child where the scheduler runs, so a wake
  // re-runs the catch-up pass. A lid-sleep that the resume event misses is
  // still caught by the child's heartbeat — this is the fast path, not the
  // only one.
  powerMonitor.on("resume", () => {
    serverProc?.postMessage({ scheduler: "power", kind: "resume" });
  });
  powerMonitor.on("suspend", () => {
    serverProc?.postMessage({ scheduler: "power", kind: "suspend" });
  });

  app.on("before-quit", () => {
    shuttingDown = true;
    releasePowerBlocker();
    serverProc?.kill();
  });
  app
    .whenReady()
    .then(run)
    .catch((err: unknown) => {
      dialog.showErrorBox("AutoBroker failed to start", String(err instanceof Error ? err.stack ?? err.message : err));
      app.quit();
    });
}
