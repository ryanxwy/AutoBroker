/**
 * Browser service SMOKE tests — REAL chromium, launched headless. The whole
 * file is gated behind AUTOBROKER_BROWSER_SMOKE=1 so normal unit runs never
 * touch a browser binary. data: URLs are used as targets (no host → the
 * throttle/robots logic is skipped by design, and nothing leaves the machine).
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Page } from "playwright";

import { withBrowserContext, type BrowserEmitter } from "./browser.js";

const SMOKE = process.env.AUTOBROKER_BROWSER_SMOKE === "1";

function recordingEmitter(): { events: string[]; emitter: BrowserEmitter } {
  const events: string[] = [];
  return {
    events,
    emitter: {
      opened: (url?: string) => {
        events.push(`opened:${url ?? ""}`);
      },
      action: (type: string, target: string) => {
        events.push(`action:${type}:${target}`);
      },
      error: (message: string) => {
        events.push(`error:${message}`);
      },
      closed: () => {
        events.push("closed");
      },
    },
  };
}

/** Headed-debug profiles live under this prefix; the ephemeral (headless)
 *  engine must never create one. */
function tempProfileDirCount(): number {
  return readdirSync(tmpdir()).filter((d) => d.startsWith("autobroker-chromium-")).length;
}

describe.skipIf(!SMOKE)("browser smoke — real headless chromium", () => {
  let tracesDir: string;

  afterEach(() => {
    rmSync(tracesDir, { recursive: true, force: true });
  });

  it(
    "launches, navigates a data: page, snapshots/screenshots, emits opened→navigate→closed, closes cleanly",
    async () => {
      const { events, emitter } = recordingEmitter();
      tracesDir = mkdtempSync(join(tmpdir(), "autobroker-traces-"));
      const url = "data:text/html,<html><body><h1>hello dealer</h1></body></html>";
      const profileDirsBefore = tempProfileDirCount();

      let pageRef: Page | null = null;
      const result = await withBrowserContext(
        "smoke-run-a",
        { headless: true, emitter, tracesDir },
        async (session) => {
          const page = await session.newPage();
          pageRef = page;
          const nav = await session.navigate(page, url);
          expect(nav.blocked).toBeNull();
          expect(nav.robotsDisallowed).toBe(false); // data: URL → no host → no robots
          const text = await session.snapshot(page);
          const shot = await session.screenshot(page);
          return { text, shotLength: shot.length };
        },
      );

      expect(result.text).toContain("hello dealer");
      expect(result.text.length).toBeLessThanOrEqual(120_000);
      expect(result.shotLength).toBeGreaterThan(0);

      // Emitter order: opened first (exactly once), navigate action after,
      // closed last.
      expect(events[0]).toBe(`opened:${url}`);
      expect(events).toContain(`action:navigate:${url}`);
      expect(events[events.length - 1]).toBe("closed");
      expect(events.filter((e) => e.startsWith("opened:"))).toHaveLength(1);

      // Context/browser are closed after the callback returns.
      expect(pageRef).not.toBeNull();
      expect(pageRef!.isClosed()).toBe(true);

      // Ephemeral engine never creates a temp profile dir.
      expect(tempProfileDirCount()).toBe(profileDirsBefore);
    },
    120_000,
  );

  it(
    "propagates fn errors, still emits closed, and leaks no temp profile dirs",
    async () => {
      const { events, emitter } = recordingEmitter();
      tracesDir = mkdtempSync(join(tmpdir(), "autobroker-traces-"));
      const profileDirsBefore = tempProfileDirCount();

      await expect(
        withBrowserContext(
          "smoke-run-b",
          { headless: true, emitter, tracesDir },
          async (session) => {
            const page = await session.newPage();
            await session.navigate(page, "data:text/html,<p>boom</p>");
            throw new Error("simulated step failure");
          },
        ),
      ).rejects.toThrow("simulated step failure");

      expect(events).toContain("error:simulated step failure");
      expect(events[events.length - 1]).toBe("closed");
      expect(tempProfileDirCount()).toBe(profileDirsBefore);
    },
    120_000,
  );
});
