/**
 * Electron shell smoke — deterministic, zero-LLM assertions over the REAL
 * shell (headed `_electron.launch()`): the window serves the same SPA + API the
 * web form does, the fork lifecycle leaves no orphans, crash recovery and the
 * single-instance lock work, the renderer has no Node reach, and the
 * long-running-background lifecycle (close-keepalive on darwin + dock-activate
 * re-create) plus the notify focused→toast ladder behave. Business behavior
 * (skills, gates, workflows) is covered by the website-lane harness — this
 * suite only proves the shell didn't break the product around it.
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
// A SEPARATE isolated dir for the demo-mode launch (S8) — proving demo never
// reuses the normal smoke data dir, and certainly never the real ~/.autobroker-ts.
const demoDataDir = mkdtempSync(join(tmpdir(), "autobroker-desktop-demo-"));

/** process.env minus undefined values, plus the isolated data dir. `extra`
 *  overlays demo-mode (or any) env for a single launch. */
function launchEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.AUTOBROKER_DATA_DIR = dataDir;
  return { ...env, ...extra };
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

async function launchApp(extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await _electron.launch({
    executablePath: electronBin,
    args: [desktopDir],
    env: launchEnv(extraEnv),
  });
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
  rmSync(demoDataDir, { recursive: true, force: true });
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
    // /api/skills returns the IMPLEMENTED subset of the 18-skill registry
    // (3 at the time of writing, growing skill by skill) — assert the known
    // floor instead of a hardcoded count so the suite stays truthful.
    expect(res.body.length).toBeGreaterThanOrEqual(3);
    const names = res.body.map((s) => s.name);
    for (const skill of ["search_profile_intake", "dealer_geosearch", "inventory_site_scan"]) {
      expect(names).toContain(skill);
    }
  });

  it("S2: SPA really renders (root populated, shell landmarks present)", async () => {
    await page.waitForSelector('[data-testid="app-main"]', { timeout: 30_000 });
    // topbar-settings is the stable topbar landmark (the old topbar-diagnostics
    // testid was removed from the UI; this assertion just needs a shell landmark).
    await page.waitForSelector('[data-testid="topbar-settings"]', { timeout: 30_000 });
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

  it("S7: fork env carries the safety subset (real-by-default, fuse not auto-armed) and the fork really runs in it", async () => {
    // The exact env subset main handed to utilityProcess.fork (test hook)...
    const hook = await app.evaluate(
      () =>
        (globalThis as unknown as Record<string, unknown>).__desktopHook as {
          forkEnvSafety: Record<string, string>;
        },
    );
    // Buyer-by-default: a NORMAL launch arms nothing send-related — AUTOBROKER_MODE
    // is the sole send-control var and is unset (= buyer), so real send is reachable
    // behind the per-action human-approval gate. (Demo mode pins test mode instead.)
    expect(hook.forkEnvSafety.AUTOBROKER_MODE).toBeUndefined(); // unset = buyer
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

// Demo mode (S8, S9): one launch armed with AUTOBROKER_DEMO_SEED=1 against a
// SEPARATE tmp demo dir. The seed runs in boot; the SPA reads /api/mode.demo.
describe("demo mode (S8, S9)", () => {
  let app: ElectronApplication;
  let page: Page;

  beforeAll(async () => {
    ({ app, page } = await launchApp({ AUTOBROKER_DEMO_SEED: "1", AUTOBROKER_DATA_DIR: demoDataDir }));
  });
  afterAll(async () => {
    await closeApp(app);
  });

  it("S8: demo is invocable AND isolated — seeded profiles + demo dir, never the real one", async () => {
    // The boot seed wrote the sample world into THIS demo dir; the active list
    // now carries ≥2 profiles (the two distinct-brand actives).
    const profiles = await page.evaluate(
      async () => (await fetch("/api/profiles?status=active")).json() as Promise<unknown[]>,
    );
    expect(Array.isArray(profiles)).toBe(true);
    expect(profiles.length).toBeGreaterThanOrEqual(2);

    // /api/mode reports demo:true AND the isolated demo dir — proving the run
    // never touched the normal smoke dir, let alone the real ~/.autobroker-ts.
    const mode = await page.evaluate(
      async () => (await fetch("/api/mode")).json() as Promise<{ demo: boolean; data_dir: string }>,
    );
    expect(mode.demo).toBe(true);
    expect(mode.data_dir).toBe(demoDataDir);
    expect(mode.data_dir).not.toBe(dataDir);
    expect(mode.data_dir).not.toContain("/.autobroker-ts/autobroker.db");

    // Demo is a seeded PRACTICE showcase — it must run in test mode so the demo can
    // never reach a real dealer. The launcher keys the mode on the effective demo
    // posture (this launch armed AUTOBROKER_DEMO_SEED in the env), so the fork-env
    // safety subset pins AUTOBROKER_MODE="test".
    const hook = await app.evaluate(
      () =>
        (globalThis as unknown as Record<string, unknown>).__desktopHook as {
          forkEnvSafety: Record<string, string>;
        },
    );
    expect(hook.forkEnvSafety.AUTOBROKER_MODE).toBe("test");
  });

  it("S9: the demo banner is present in demo mode", async () => {
    await page.waitForSelector('[data-testid="demo-banner"]', { timeout: 30_000 });
    const text = await page.evaluate(
      () => document.querySelector('[data-testid="demo-banner"]')?.textContent ?? "",
    );
    expect(text).toContain("DEMO DATA");
  });
});

describe("demo banner absent in a normal launch (S9)", () => {
  it("S9: a non-demo launch renders the SPA shell with NO demo banner", async () => {
    const { app, page } = await launchApp();
    try {
      await page.waitForSelector('[data-testid="app-main"]', { timeout: 30_000 });
      const mode = await page.evaluate(async () => (await fetch("/api/mode")).json() as Promise<{ demo: boolean }>);
      expect(mode.demo).toBe(false);
      expect(await page.locator('[data-testid="demo-banner"]').count()).toBe(0);
    } finally {
      await closeApp(app).catch(() => {});
    }
  });
});

// Layout integrity at the smallest supported window (S10): the chrome must not
// clip at 900×600. Plain non-demo launch; deterministic, no LLM.
describe("small-window layout integrity (S10)", () => {
  it("S10: at 900×600 app-main + the composer are visible and the topbar isn't clipped", async () => {
    const { app, page } = await launchApp();
    try {
      await page.setViewportSize({ width: 900, height: 600 });
      await page.waitForSelector('[data-testid="app-main"]', { timeout: 30_000 });

      // The main region + the chat composer render and are visible.
      expect(await page.locator('[data-testid="app-main"]').isVisible()).toBe(true);
      expect(await page.locator('[data-testid="chat-input-textarea"]').isVisible()).toBe(true);

      // The topbar settings gear + the app-mode lamp sit fully within the
      // 900-wide viewport (right edge not clipped past the window).
      for (const testid of ["topbar-settings", "mode-toggle"]) {
        const loc = page.locator(`[data-testid="${testid}"]`);
        if ((await loc.count()) === 0) continue; // tolerate a renamed/absent control
        const box = await loc.first().boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(900 + 1); // sub-pixel slack
      }

      // If a gate banner is present its approve/deny controls are in-viewport.
      for (const testid of ["approval-approve", "approval-deny"]) {
        const loc = page.locator(`[data-testid="${testid}"]`);
        if ((await loc.count()) === 0) continue;
        const box = await loc.first().boundingBox();
        if (box === null) continue;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(900 + 1);
        expect(box.y + box.height).toBeLessThanOrEqual(600 + 1);
      }
    } finally {
      await closeApp(app).catch(() => {});
    }
  });
});

// Long-running background (S11): on darwin closing the WINDOW does not quit the
// app — the server child keeps running so the background schedule lives on, and
// the dock click (`activate`) re-creates the window. (On non-darwin the app
// would quit; this suite runs on darwin, the platform that ships the desktop
// shell.)
describe("background lifecycle (S11)", () => {
  it("S11: closing the window keeps the app + server alive (darwin); activate re-creates the window", async () => {
    const { app } = await launchApp();
    try {
      const pid = await serverPidOf(app);
      expect(pidAlive(pid)).toBe(true);

      // Close every window (fires window-all-closed). On darwin the app stays up.
      await app.evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) w.close();
      });
      await poll(
        () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
        (n) => n === 0,
        "all windows closed",
      );

      // The app did NOT quit: the server fork is still alive and the main
      // process still answers app.evaluate.
      expect(pidAlive(pid)).toBe(true);
      const stillUp = await app.evaluate(({ app: a }) => a.isReady());
      expect(stillUp).toBe(true); // main process still responsive

      // Dock re-activation re-creates the window on the same background server.
      await app.evaluate(({ app: a }) => {
        a.emit("activate");
      });
      await poll(
        () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
        (n) => n >= 1,
        "window re-created on activate",
      );
      const newWindow = await app.firstWindow({ timeout: 30_000 });
      await newWindow.waitForLoadState("domcontentloaded");
      const apiOk = await newWindow.evaluate(async () => (await fetch("/api/skills")).status);
      expect(apiOk).toBe(200); // re-created window points at the still-running fork
      expect(pidAlive(pid)).toBe(true); // same server fork — never relaunched
    } finally {
      await closeApp(app).catch(() => {});
    }
  });
});

// notify() ladder (S12): native notifications are not scriptable headless, so
// this proves (a) the renderer toast SURFACE end-to-end (the injected
// autobroker:notify event renders the testid'd toast) and (b) the focused→toast
// branch of main's notify() ladder posts to the renderer (lastNotifyChannel).
describe("notify ladder — focused → in-app toast (S12)", () => {
  it("S12a: an injected autobroker:notify event renders the app-toast surface", async () => {
    const { app, page } = await launchApp();
    try {
      await page.waitForSelector('[data-testid="app-main"]', { timeout: 30_000 });
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("autobroker:notify", {
            detail: { title: "Background update", body: "An inbox poll finished.", deepLink: "/" },
          }),
        );
      });
      await page.waitForSelector('[data-testid="app-toast"]', { timeout: 10_000 });
      const text = await page.evaluate(
        () => document.querySelector('[data-testid="app-toast"]')?.textContent ?? "",
      );
      expect(text).toContain("Background update");
      expect(text).toContain("An inbox poll finished.");
    } finally {
      await closeApp(app).catch(() => {});
    }
  });

  it("S12b: notify() while the window is focused posts a toast to the renderer", async () => {
    const { app, page } = await launchApp();
    try {
      await page.waitForSelector('[data-testid="app-main"]', { timeout: 30_000 });
      // Force focus from the main process (a headless launch may not have OS
      // focus), then drive main's notify() and assert the focused→toast branch.
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        w?.show();
        w?.focus();
        (
          globalThis as unknown as { __desktopHook: { notify: (t: string, b: string) => void } }
        ).__desktopHook.notify("Digest ready", "Your daily digest is ready.");
      });
      const channel = await poll(
        () =>
          app.evaluate(
            () =>
              (globalThis as unknown as Record<string, unknown>).__desktopHook as {
                lastNotifyChannel: string | null;
              },
          ),
        (h) => h.lastNotifyChannel !== null,
        "notify chose a delivery channel",
      );
      // A focused window takes the toast branch (never a native notification).
      expect((channel as { lastNotifyChannel: string }).lastNotifyChannel).toBe("toast");
      await page.waitForSelector('[data-testid="app-toast"]', { timeout: 10_000 });
      const text = await page.evaluate(
        () => document.querySelector('[data-testid="app-toast"]')?.textContent ?? "",
      );
      expect(text).toContain("Digest ready");
    } finally {
      await closeApp(app).catch(() => {});
    }
  });
});
