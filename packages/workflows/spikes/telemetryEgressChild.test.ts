/**
 * SPIKE-6 child workload (run by the parent test as a separate vitest process).
 *
 * This file is intentionally placed under `spikes/` (NOT `src/`) so the
 * workflows `tsconfig.json` (`include: ["src/**\/*.ts"]`) never sweeps it and
 * the normal CI test glob never auto-runs it. The parent invokes it explicitly:
 *
 *   NODE_OPTIONS=--require <egressRecorderPreload.cjs>
 *   EGRESS_LOG=<file> AUTOBROKER_DATA_DIR=<tmp> MASTRA_TELEMETRY_DISABLED=1
 *   pnpm exec vitest run spikes/telemetryEgressChild.test.ts
 *
 * vitest runs TS directly (esbuild) — no tsx needed. The preload is inherited
 * by the vitest worker via NODE_OPTIONS, so it arms BEFORE this module (and
 * @mastra/*) loads. We then construct the library-mode Mastra instance, init
 * storage, and exercise REAL storage ops (saveThread + getThreadById) so any
 * telemetry/flush path that core 1.41 might run gets a chance to fire. Finally
 * we wait ~2s for async telemetry flushers before the process exits.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, it, expect } from "vitest";

import { createMastraInstance, resetMastraForTests } from "../src/mastra.js";

// This file is matched by the default vitest glob, but it is ONLY meaningful
// when launched by the parent (src/telemetryEgress.test.ts) with the recorder
// preload + AUTOBROKER_DATA_DIR set. A bare `vitest run` (CI) must NOT run the
// real workload — so we skip unless the parent's sentinel is present.
const RUN = process.env.SPIKE6_CHILD === "1";

describe.skipIf(!RUN)("spike-6 telemetry egress child workload", () => {
  it("boots library-mode Mastra and exercises storage", async () => {
    // The data dir is provided by the parent and MUST already be set; we assert
    // rather than fabricate, so a misconfigured parent fails loudly instead of
    // silently writing somewhere unexpected.
    const dataDir = process.env.AUTOBROKER_DATA_DIR;
    expect(dataDir, "AUTOBROKER_DATA_DIR must be set by parent").toBeTruthy();
    // It must be a tmp dir, never a real autobroker data dir.
    expect(dataDir!.includes(".autobroker-ts")).toBe(false);
    expect(dataDir!.includes(join("/", ".autobroker"))).toBe(false);

    resetMastraForTests();
    const mastra = createMastraInstance();

    const storage = mastra.getStorage();
    expect(storage, "library-mode storage must exist").toBeTruthy();

    // Land the mastra_* tables in mastra.db.
    await storage!.init();

    // Exercise a REAL storage round-trip via the memory domain so any
    // telemetry/flush code path that observes storage activity can run.
    const memory = await storage!.getStore("memory");
    expect(memory, "memory domain store must exist").toBeTruthy();

    const now = new Date();
    const thread = {
      id: `spike6-thread-${Date.now()}`,
      title: "spike6 telemetry egress probe",
      resourceId: "spike6-resource",
      createdAt: now,
      updatedAt: now,
      metadata: { spike: 6 } as Record<string, unknown>,
    };

    const saved = await memory!.saveThread({ thread });
    expect(saved.id).toBe(thread.id);

    const fetched = await memory!.getThreadById({ threadId: thread.id });
    expect(fetched?.id).toBe(thread.id);

    // Give any async telemetry flusher (PostHog batches on a timer) room to
    // attempt egress, so the recorder would catch it.
    await delay(2000);

    resetMastraForTests();
  });
});
