/**
 * Electron shell smoke — 7 deterministic, zero-LLM assertions over the REAL
 * shell (headed `_electron.launch()`): the window serves the same SPA + API the
 * web form does, the fork lifecycle leaves no orphans, crash recovery and the
 * single-instance lock work, and the renderer has no Node reach. Business
 * behavior (skills, gates, workflows) is covered by the website-lane harness —
 * this suite only proves the shell didn't break the product around it.
 *
 * Isolation: every launch points AUTOBROKER_DATA_DIR at a per-run tmp dir, so
 * S1 also proves the bundle's fresh-data-dir migration bootstrap end to end.
 *
 * Orphan checks probe the TRACKED fork pid (signal 0): a utilityProcess child
 * does not carry its module path on the OS command line, so `pgrep -f
 * server.cjs` can never see it — the pid probe is the truthful equivalent.
 *
 * Run: `pnpm desktop:smoke` (after `pnpm build` + `pnpm desktop:bundle`).
 * Sequential by construction — the single-instance lock allows one live app,
 * so every test closes its app in finally/afterAll even on failure.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron, type ElectronApplication, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url)); // apps/desktop/smoke
const desktopDir = resolve(here, "..");
const electronBin = createRequire(import.meta.url)("electron") as string;

const dataDir = mkdtempSync(join(tmpdir(), "autobroker-desktop-smoke-"));

/** process.env minus undefined values, plus the isolated data dir. */
function launchEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.AUTOBROKER_DATA_DIR = dataDir;
  return env;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence probe, no signal delivered
    return true;
  } catch {
    return false;
  }
}

async function poll<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, label: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await fn();
    if (ok(last)) return last;
    if (Date.now() > deadline) throw new Error(`poll timed out: ${label} (last=${JSON.stringify(last)})`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** The fork's OS pid via the main-process introspection hook. */
async function serverPidOf(app: ElectronApplication): Promise<number> {
  const pid = await poll(
    () =>
      app.evaluate(
        () =>
          ((globalThis as unknown as Record<string, unknown>).__desktopHook as { serverPid: number | null })
            .serverPid,
      ),
    (p) => typeof p === "number",
    "server fork pid available",
  );
  return pid as number;
}

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({ executablePath: electronBin, args: [desktopDir], env: launchEnv() });
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

/** Close + wait until the fork is really gone (frees the single-instance lock
 *  for the next launch). Tolerates an already-dead fork. */
async function closeApp(app: ElectronApplication): Promise<void> {
  const pid = await serverPidOf(app).catch(() => null);
  await app.close();
  if (pid !== null) await poll(() => pidAlive(pid), (alive) => !alive, "fork exits after close", 15_000);
}

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("shared window (S1, S2, S6, S7)", () => {
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    ({ app, page } = await launchApp());
  });
  afterAll(async () => {
    await closeApp(app);
  });

  it("S1: window visible and /api/skills serves the implemented-skill manifest", async () => {
    const visible = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((w) => w.isVisible()),
    );
    expect(visible).toBe(true);

    const res = await page.evaluate(async () => {
      const r = await fetch("/api/skills");
      return { status: r.status, body: (await r.json()) as Array<{ name: string }> };
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // /api/skills returns the IMPLEMENTED subset of the 17-skill registry
    // (3 at the time of writing, growing skill by skill) — assert the known
    // floor instead of a hardcoded 17 so the suite stays truthful.
    expect(res.body.length).toBeGreaterThanOrEqual(3);
    const names = res.body.map((s) => s.name);
    for (const skill of ["search_profile_intake", "dealer_geosearch", "inventory_site_scan"]) {
      expect(names).toContain(skill);
    }
  });

  it("S2: SPA really renders (root populated, shell landmarks present)", async () => {
    await page.waitForSelector('[data-testid="app-main"]', { timeout: 30_000 });
    await page.waitForSelector('[data-testid="topbar-diagnostics"]', { timeout: 30_000 });
    const rootChildren = await page.evaluate(() => document.getElementById("root")?.childElementCount ?? 0);
    expect(rootChildren).toBeGreaterThan(0);
  });

  it("S6: renderer is sealed — no require, no process, sandbox on", async () => {
    const surface = await page.evaluate(() => ({
      require: typeof (window as unknown as Record<string, unknown>).require,
      process: typeof (window as unknown as Record<string, unknown>).process,
    }));
    expect(surface.require).toBe("undefined");
    expect(surface.process).toBe("undefined");
    const sandboxed = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return w!.webContents.isSandboxed?.() ?? null;
    });
    expect(sandboxed).not.toBe(false);
  });

  it("S7: fork env arms the safety stack and the fork really runs in it", async () => {
    // The exact env subset main handed to utilityProcess.fork (test hook)...
    const hook = await app.evaluate(
      () =>
        (globalThis as unknown as Record<string, unknown>).__desktopHook as {
          forkEnvSafety: Record<string, string>;
        },
    );
    expect(hook.forkEnvSafety.AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS).toBe("1");
    expect(hook.forkEnvSafety.MASTRA_TELEMETRY_DISABLED).toBe("1");
    expect(hook.forkEnvSafety.PORT).toBe("0");
    expect(hook.forkEnvSafety.AUTOBROKER_DATA_DIR).toBe(dataDir);
    expect(hook.forkEnvSafety.AUTOBROKER_UI_DIST).toBe(join(desktopDir, "bundle", "ui-dist"));
    // ...cross-checked INSIDE the fork: the server reports the same isolated
    // data dir, proving the env actually reached the child process.
    const mode = await page.evaluate(async () => (await fetch("/api/mode")).json() as Promise<{ data_dir: string }>);
    expect(mode.data_dir).toBe(dataDir);
    expect(pidAlive(await serverPidOf(app))).toBe(true);
  });
});

describe("lifecycle (S3)", () => {
  it("S3: quitting the app leaves no orphan server fork", async () => {
    const { app } = await launchApp();
    try {
      const pid = await serverPidOf(app);
      expect(pidAlive(pid)).toBe(true);
      await app.close();
      await poll(() => pidAlive(pid), (alive) => !alive, "no orphan server fork after quit", 15_000);
    } finally {
      await app.close().catch(() => {});
    }
  });
});

describe("crash recovery (S4)", () => {
  it("S4: killing the fork raises the relaunch dialog; relaunch restores the app", async () => {
    const { app, page } = await launchApp();
    try {
      // Stub the native dialog from inside the main process (native UI is not
      // scriptable): record the call, answer "Relaunch server" (button 0).
      await app.evaluate(({ dialog }) => {
        const g = globalThis as unknown as Record<string, unknown>;
        g.__dialogCalls = [];
        dialog.showMessageBox = (async (opts: unknown) => {
          (g.__dialogCalls as unknown[]).push(opts);
          return { response: 0, checkboxChecked: false };
        }) as typeof dialog.showMessageBox;
      });
      const pid1 = await serverPidOf(app);
      process.kill(pid1, "SIGKILL");

      const calls = await poll(
        () =>
          app.evaluate(() => ((globalThis as unknown as Record<string, unknown>).__dialogCalls as unknown[]).length),
        (n) => n > 0,
        "relaunch dialog shown",
      );
      expect(calls).toBeGreaterThan(0);

      const pid2 = await poll(
        () =>
          app.evaluate(
            () =>
              ((globalThis as unknown as Record<string, unknown>).__desktopHook as { serverPid: number | null })
                .serverPid,
          ),
        (p) => typeof p === "number" && p !== pid1,
        "fork relaunched with a new pid",
      );
      expect(pid2).not.toBe(pid1);

      // The window reloaded onto the new port and the API answers again.
      await poll(
        async () => {
          try {
            return await page.evaluate(async () => (await fetch("/api/skills")).status);
          } catch {
            return 0; // navigation in flight
          }
        },
        (s) => s === 200,
        "API reachable after relaunch",
      );
    } finally {
      await closeApp(app).catch(() => {});
    }
  });
});

describe("single instance (S5)", () => {
  it("S5: a second instance exits immediately and pings the first", async () => {
    const { app } = await launchApp();
    try {
      const pid = await serverPidOf(app);
      const second = spawn(electronBin, [desktopDir], { env: launchEnv(), stdio: "ignore" });
      const exitCode = await new Promise<number | null>((resolveExit) => {
        const t = setTimeout(() => resolveExit(null), 30_000);
        second.on("exit", (code) => {
          clearTimeout(t);
          resolveExit(code);
        });
      });
      expect(exitCode).toBe(0); // lock denied → clean immediate quit

      const seen = await poll(
        () =>
          app.evaluate(
            () =>
              ((globalThis as unknown as Record<string, unknown>).__desktopHook as { secondInstanceSeen: boolean })
                .secondInstanceSeen,
          ),
        (v) => v,
        "first instance received second-instance ping",
      );
      expect(seen).toBe(true);
      expect(pidAlive(pid)).toBe(true); // first instance + its fork unharmed
    } finally {
      await closeApp(app).catch(() => {});
    }
  });
});
