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
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, nativeImage, utilityProcess, type UtilityProcess } from "electron";

const here = dirname(fileURLToPath(import.meta.url)); // apps/desktop/dist
const desktopDir = resolve(here, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const bundleDir = join(desktopDir, "bundle");

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
const hook: DesktopHook = { serverPid: null, port: null, forkEnvSafety: {}, secondInstanceSeen: false };
(globalThis as Record<string, unknown>).__desktopHook = hook;

let serverProc: UtilityProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let shuttingDown = false;

/** Fork the bundled server; resolve with the actual bound port once the
 *  listening JSON line ({"server":"listening",...,"port":N}) appears. */
function startServer(): Promise<number> {
  const dotEnv = parseDotEnv(join(repoRoot, ".env"));
  const env: Record<string, string> = {
    ...dotEnv,
    ...(process.env as Record<string, string>), // an already-set var beats the .env file
    PORT: "0",
    AUTOBROKER_DATA_DIR:
      process.env.AUTOBROKER_DATA_DIR ?? dotEnv.AUTOBROKER_DATA_DIR ?? join(homedir(), ".autobroker-ts"),
    AUTOBROKER_UI_DIST: join(bundleDir, "ui-dist"),
    AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS: "1",
    MASTRA_TELEMETRY_DISABLED: "1",
  };
  hook.forkEnvSafety = {
    PORT: env.PORT!,
    AUTOBROKER_DATA_DIR: env.AUTOBROKER_DATA_DIR!,
    AUTOBROKER_UI_DIST: env.AUTOBROKER_UI_DIST!,
    AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS: env.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS!,
    MASTRA_TELEMETRY_DISABLED: env.MASTRA_TELEMETRY_DISABLED!,
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

    proc.on("exit", (code) => {
      clearTimeout(timer);
      serverProc = null;
      hook.serverPid = null;
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

async function run(): Promise<void> {
  // Optional runtime dock icon — `electron .` otherwise shows Electron's
  // default. The artwork is a machine-local artifact (generated next to the
  // dev launcher, never committed); silently skipped when absent.
  if (process.platform === "darwin") {
    const dockIcon = nativeImage.createFromPath(join(homedir(), ".autobroker-ts", "desktop-launcher", "icon.png"));
    if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon);
  }
  const port = await startServer();
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

app.setName("autobroker-desktop"); // stable userData path → stable single-instance lock

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    hook.secondInstanceSeen = true;
    if (mainWindow !== null) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      // Showing/focusing the window delivers the standard page-level `focus` +
      // `visibilitychange:visible` events to the renderer; the SPA's
      // fresh-on-refocus listeners (apps/ui useRefocusRefetch) refetch the read
      // views from there — no native refetch nudge, no preload/IPC needed. The
      // window stays open for the app's life (window-all-closed → quit), so
      // dock re-activation focuses this same window and fires the same events.
      mainWindow.focus();
    }
  });
  app.on("window-all-closed", () => app.quit()); // dev-solo: no hidden background app
  app.on("before-quit", () => {
    shuttingDown = true;
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
