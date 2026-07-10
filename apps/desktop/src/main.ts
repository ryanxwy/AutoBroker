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
 * Safety: BUYER-BY-DEFAULT. Real Gmail/web-form send is reachable only through
 * the L2 gate (the same server+SPA code as the web form; the shell adds NO second
 * path to any side effect). Approval is manual unless the persisted Settings
 * policy explicitly enables fresh first-send automation. The DEMO showcase pins
 * test mode (AUTOBROKER_MODE=test) since it runs on seeded sample data.
 * AUTOBROKER_MODE is the sole send-control var: setting it to "test" in the
 * environment keeps every send fake/local.
 * MASTRA_TELEMETRY_DISABLED=1 is still always pinned.
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
 * system sleep / drain the battery).
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

import {
  isValidRepoPath,
  markerPathFor,
  readMarker,
  readStagedSignal,
  refreshSpawnSpec,
  stagedPathFor,
  type DesktopRefreshMarker,
} from "./launchFreshness.js";

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
}
const hook: DesktopHook = {
  serverPid: null,
  port: null,
  forkEnvSafety: {},
  secondInstanceSeen: false,
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

/** Show a transient in-app toast by dispatching a window CustomEvent into the
 *  renderer. No preload/IPC bridge exists (the renderer loads over localhost
 *  HTTP), so main injects a tiny script that the App's toast listener picks up.
 *  Returns false when there is no live window to post into. The launch-freshness
 *  path is the only caller: announceUpdateReady's no-native-notification
 *  fallback and checkFreshnessInBackground's "preparing update" toast. */
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
    MASTRA_TELEMETRY_DISABLED: "1",
    // Buyer-by-default: real send remains behind the L2 gate; the separately
    // persisted auto-send approval policy defaults off. The DEMO showcase pins
    // test mode — keyed on the EFFECTIVE demo posture (the dialog flag OR an
    // externally-exported AUTOBROKER_DEMO_SEED), so an already-demo launch is test
    // too; boot re-applies this server-side as the floor. AUTOBROKER_MODE is the
    // sole send-control var (honored from process.env via the spread above).
    ...(demoMode || process.env.AUTOBROKER_DEMO_SEED === "1"
      ? { AUTOBROKER_DEMO_SEED: "1", AUTOBROKER_MODE: "test" }
      : {}),
  };
  hook.forkEnvSafety = {
    PORT: env.PORT!,
    AUTOBROKER_DATA_DIR: env.AUTOBROKER_DATA_DIR!,
    AUTOBROKER_UI_DIST: env.AUTOBROKER_UI_DIST!,
    MASTRA_TELEMETRY_DISABLED: env.MASTRA_TELEMETRY_DISABLED!,
    ...(env.AUTOBROKER_DEMO_SEED !== undefined ? { AUTOBROKER_DEMO_SEED: env.AUTOBROKER_DEMO_SEED } : {}),
    ...(env.AUTOBROKER_MODE !== undefined ? { AUTOBROKER_MODE: env.AUTOBROKER_MODE } : {}),
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

/** Create the single BrowserWindow on the running server's port. */
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
  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

// ---- packaged launch-time freshness (mechanism C) --------------------------
// Make the INSTALLED build auto-fresh without ever blocking or blanking the
// launch: boot immediately, and if a newer build is staged (cold start) or the
// repo source has moved past what is installed, surface a NON-blocking "Update
// ready — Relaunch". Entirely INERT unless this is the packaged app AND a valid
// external marker for this install path exists — so dev (`electron .`,
// app.isPackaged === false, used by the smoke suite) and a shipped dmg / copied
// .app (no marker) take none of this. Fail-soft throughout: any error degrades
// to a normal launch of the installed build. The marker lives OUTSIDE the
// bundle and holds DATA ONLY; interpreters resolve by fixed rule (never the
// marker). No new IPC/preload — the UI reuses the existing toast + notification
// seams.

/** Resolved, validated launch-freshness state for THIS install. */
interface FreshnessContext {
  dataDir: string;
  marker: DesktopRefreshMarker;
  stagedPath: string;
}

/** The installed `.app` bundle root, derived by FIXED RULE from this packaged
 *  process — never from the marker. process.resourcesPath is
 *  `<AutoBroker.app>/Contents/Resources`, so the bundle root is two dirs up; the
 *  refresh script keys the marker by sha256 of this same path. */
function installedAppPath(): string {
  return dirname(dirname(process.resourcesPath));
}

/** Read + validate the external marker for this install. null when there is no
 *  usable marker (missing / corrupt / repoPath is not a git work-tree) → the
 *  caller boots the installed build unchanged. */
function resolveFreshnessContext(): FreshnessContext | null {
  const dataDir = realDataDir();
  const appPath = installedAppPath();
  const marker = readMarker(markerPathFor(dataDir, appPath));
  if (marker === null) return null;
  if (!isValidRepoPath(marker.repoPath)) return null;
  return { dataDir, marker, stagedPath: stagedPathFor(dataDir, appPath) };
}

/** Spawn the refresh orchestrator detached. Interpreters by fixed rule
 *  (process.execPath + ELECTRON_RUN_AS_NODE=1, the repo's desktop-refresh.mjs);
 *  env-clean (no AUTOBROKER_MODE). The child outlives us (it waits for our exit
 *  on the install path), so it is detached + unref'd. */
function spawnRefresh(ctx: FreshnessContext, mode: "install" | "launch-bg"): void {
  const spec = refreshSpawnSpec({
    execPath: process.execPath,
    repoPath: ctx.marker.repoPath,
    dataDir: ctx.dataDir,
    mode,
    selfPid: process.pid,
  });
  spawn(spec.file, spec.args, { detached: true, stdio: "ignore", env: spec.env }).unref();
}

/** Step 0 — cold-start consume of an ALREADY-staged build. When a staged build
 *  with a different (non-null) stamp is waiting, relaunch into it via the
 *  orchestrator (it waits for our exit, installs the staged .app, then re-opens
 *  by absolute path) rather than booting stale bytes. v1 always relaunches to
 *  consume a staged build — no in-process bundle mutation (a future optimization
 *  can hot-swap Contents/Resources/bundle in place). Returns true when it has
 *  initiated a quit, in which case the caller must NOT keep booting. */
function consumeStagedBuild(ctx: FreshnessContext): boolean {
  const staged = readStagedSignal(ctx.stagedPath);
  if (staged === null) return false;
  if (staged.builtStamp === null || staged.builtStamp === ctx.marker.builtStamp) return false;
  spawnRefresh(ctx, "install"); // --install --quitting-pid <self> --open
  app.quit();
  return true;
}

let updateReadyAnnounced = false;

/** Surface the NON-modal "Update ready — Relaunch" affordance exactly once. A
 *  native Notification whose click triggers the relaunch is the simplest action
 *  affordance that adds no preload/IPC bridge (the click handler runs in main).
 *  If native notifications are unsupported, degrade
 *  to an in-app toast (informational — the staged build installs on the next
 *  manual relaunch / next cold start anyway). */
function announceUpdateReady(ctx: FreshnessContext): void {
  if (updateReadyAnnounced) return;
  updateReadyAnnounced = true;
  if (!Notification.isSupported()) {
    void postToastToRenderer("AutoBroker update ready", "Relaunch to use the latest build.", "/");
    return;
  }
  const n = new Notification({ title: "AutoBroker update ready", body: "Click to relaunch into the latest build." });
  n.on("click", () => relaunchIntoStaged(ctx));
  n.show();
}

/** Relaunch into the staged build: spawn the orchestrator in install mode
 *  (consumes the staged .app, then re-opens) and quit. Fail-soft — a spawn
 *  failure leaves the running build untouched. */
function relaunchIntoStaged(ctx: FreshnessContext): void {
  try {
    spawnRefresh(ctx, "install");
    app.quit();
  } catch {
    /* leave the running build untouched */
  }
}

/** Compute the live built stamp for the marker's repo by importing THAT repo's
 *  compiled freshness module (cache-busted so a rebuilt dist is re-read). Using
 *  the repo's own algorithm — not the installed build's possibly-older copy —
 *  is what makes "live === staged.builtStamp" compare like-for-like (the refresh
 *  script stamps a staged build with the same repo-side algorithm). Returns the
 *  stamp string, or null on any error / in-progress git op / missing dist. */
async function computeLiveBuiltStamp(repoPath: string): Promise<string | null> {
  try {
    const distFreshness = join(repoPath, "apps", "desktop", "dist", "freshness.js");
    if (!existsSync(distFreshness)) return null;
    const mod = (await import(pathToFileURL(distFreshness).href + "?v=" + Date.now())) as typeof import("./freshness.js");
    const stamp = mod.computeBuiltStamp(repoPath, { git: mod.resolveGit() });
    return stamp.state === "ok" ? stamp.builtStamp : null;
  } catch {
    return null;
  }
}

/** Poll (bounded) for the staged build whose stamp matches `live`, then surface
 *  the relaunch affordance. Best-effort — a build that never lands just lets the
 *  poll lapse, leaving the running app untouched. */
function watchForStaged(ctx: FreshnessContext, live: string): void {
  let attempts = 0;
  const maxAttempts = 120; // ~10 min at a 5s cadence
  const tick = (): void => {
    const s = readStagedSignal(ctx.stagedPath);
    if (s !== null && s.builtStamp === live) {
      announceUpdateReady(ctx);
      return;
    }
    if (++attempts < maxAttempts) setTimeout(tick, 5_000);
  };
  setTimeout(tick, 5_000);
}

/** Step 3 — off-critical-path freshness check, run AFTER the window is shown.
 *  Never gates the launch. If the installed build is current → nothing. If the
 *  repo source moved past it: surface the relaunch immediately when a matching
 *  build is already staged, else kick a background prepare and watch for it. */
async function checkFreshnessInBackground(ctx: FreshnessContext): Promise<void> {
  try {
    const live = await computeLiveBuiltStamp(ctx.marker.repoPath);
    if (live === null) return; // threw / in-progress / dist missing → do nothing
    if (live === ctx.marker.builtStamp) return; // installed build is current

    const matchingStaged = (): boolean => {
      const s = readStagedSignal(ctx.stagedPath);
      return s !== null && s.builtStamp === live;
    };
    if (matchingStaged()) {
      announceUpdateReady(ctx);
      return;
    }
    spawnRefresh(ctx, "launch-bg");
    void postToastToRenderer("Preparing AutoBroker update", "A newer build is being prepared in the background.", "/");
    watchForStaged(ctx, live);
  } catch {
    /* fail-soft — running build untouched */
  }
}

async function run(): Promise<void> {
  // Packaged-only launch-time freshness (mechanism C). Gated on app.isPackaged
  // so dev/smoke (unpackaged) takes NONE of this. Each step is fail-soft.
  let freshness: FreshnessContext | null = null;
  if (app.isPackaged) {
    try {
      freshness = resolveFreshnessContext();
      // Step 0 (before startServer): consume an already-staged build by
      // relaunching into it. If that initiates a quit, stop — do not keep booting.
      if (freshness !== null && consumeStagedBuild(freshness)) return;
    } catch {
      freshness = null; // any error → boot the installed build normally
    }
  }

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

  // Step 3 (after the window is shown): off-critical-path staleness check. Never
  // awaited — the launch is never gated on the stamp.
  if (freshness !== null) void checkFreshnessInBackground(freshness);
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
