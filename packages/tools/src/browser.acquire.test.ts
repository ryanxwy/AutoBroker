/**
 * Browser-acquire unit tests — install the Playwright browser ON DEMAND, with NO
 * real download and NO real filesystem touch. The presence check and the
 * installer are injected via __setBrowserAcquireDepsForTests, so these cases
 * pin the two branches deterministically:
 *   - binary present  → fast no-op (installer is NEVER invoked, no progress);
 *   - binary absent   → install path runs and streams browser.acquire-style
 *     progress through the emitter's optional acquireProgress hook;
 *   - install failure → ensureBrowserAcquired rejects (the caller surfaces it
 *     rather than launching into a missing binary).
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureBrowserAcquired,
  __setBrowserAcquireDepsForTests,
  __resetBrowserAcquireDepsForTests,
  type AcquireProgress,
  type BrowserEmitter,
} from "./browser.js";

afterEach(() => {
  __resetBrowserAcquireDepsForTests();
});

/** A BrowserEmitter that records every acquireProgress call (message + pct). */
function recordingEmitter(): {
  progress: { message: string; pct: number | undefined }[];
  emitter: BrowserEmitter;
} {
  const progress: { message: string; pct: number | undefined }[] = [];
  return {
    progress,
    emitter: {
      opened: () => undefined,
      action: () => undefined,
      error: () => undefined,
      closed: () => undefined,
      acquireProgress: (message: string, pct?: number) => {
        progress.push({ message, pct });
      },
    },
  };
}

describe("ensureBrowserAcquired — present binary is a no-op fast path", () => {
  it("does NOT invoke the installer and emits no progress when present", async () => {
    let installCalls = 0;
    __setBrowserAcquireDepsForTests({
      isPresent: () => true,
      install: async () => {
        installCalls += 1;
      },
    });
    const { progress, emitter } = recordingEmitter();

    await ensureBrowserAcquired(emitter);

    expect(installCalls).toBe(0);
    expect(progress).toEqual([]);
  });
});

describe("ensureBrowserAcquired — absent binary triggers install + progress", () => {
  it("invokes the installer and forwards progress to the emitter", async () => {
    let installCalls = 0;
    __setBrowserAcquireDepsForTests({
      isPresent: () => false,
      install: async (onProgress: AcquireProgress) => {
        installCalls += 1;
        onProgress("Downloading browser…");
        onProgress("|  42% of 150 MiB", 0.42);
        onProgress("Browser ready.", 1);
      },
    });
    const { progress, emitter } = recordingEmitter();

    await ensureBrowserAcquired(emitter);

    expect(installCalls).toBe(1);
    // At least one progress event reached the emitter (the UI's install bar).
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(progress[0]?.message).toBe("Downloading browser…");
    // The fractional progress is forwarded when the installer reports it.
    expect(progress.map((p) => p.pct)).toContain(0.42);
    expect(progress.at(-1)).toEqual({ message: "Browser ready.", pct: 1 });
  });

  it("tolerates an emitter without acquireProgress (optional hook)", async () => {
    __setBrowserAcquireDepsForTests({
      isPresent: () => false,
      install: async (onProgress: AcquireProgress) => {
        onProgress("Downloading browser…");
      },
    });
    // The NULL-style emitter here omits acquireProgress entirely; the acquire
    // path must call it via optional-chaining and not throw.
    const bareEmitter: BrowserEmitter = {
      opened: () => undefined,
      action: () => undefined,
      error: () => undefined,
      closed: () => undefined,
    };
    await expect(ensureBrowserAcquired(bareEmitter)).resolves.toBeUndefined();
  });

  it("uses the default NULL emitter when none is passed (no throw)", async () => {
    let installCalls = 0;
    __setBrowserAcquireDepsForTests({
      isPresent: () => false,
      install: async (onProgress: AcquireProgress) => {
        installCalls += 1;
        onProgress("Downloading browser…");
      },
    });
    await expect(ensureBrowserAcquired()).resolves.toBeUndefined();
    expect(installCalls).toBe(1);
  });
});

describe("ensureBrowserAcquired — install failure rejects", () => {
  it("propagates the install error so launch is not attempted into a missing binary", async () => {
    __setBrowserAcquireDepsForTests({
      isPresent: () => false,
      install: async () => {
        throw new Error("browser install exited with code 1");
      },
    });
    const { emitter } = recordingEmitter();
    await expect(ensureBrowserAcquired(emitter)).rejects.toThrow(/exited with code 1/);
  });
});

describe("ensureBrowserAcquired — explicit deps override the injected seam", () => {
  it("a deps argument is used directly (present → no-op)", async () => {
    let installCalls = 0;
    const { progress, emitter } = recordingEmitter();
    await ensureBrowserAcquired(emitter, {
      isPresent: () => true,
      install: async () => {
        installCalls += 1;
      },
    });
    expect(installCalls).toBe(0);
    expect(progress).toEqual([]);
  });
});
