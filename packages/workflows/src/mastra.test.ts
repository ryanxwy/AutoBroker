/**
 * Acceptance — Mastra library mode + mastra.db on disk.
 *
 * Freezes the library-mode dual-DB contract:
 *   (a) constructing the instance and initializing storage lands a real
 *       `mastra.db` file in the active data dir (AUTOBROKER_DATA_DIR);
 *   (b) dual-DB never-co-write: nothing here touches the product
 *       `autobroker.db` — it must not even exist after the run (so mastra_*
 *       tables provably cannot have co-landed in it);
 *   (c) the telemetry env belt is armed after construction.
 *
 * Fully isolated: a fresh os.tmpdir() subdir per case; AUTOBROKER_DATA_DIR and
 * MASTRA_TELEMETRY_DISABLED are saved and restored; never writes ~/.autobroker
 * or ~/.autobroker-ts. The singleton is reset between cases so re-pointing the
 * data dir takes effect.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMastraInstance, resetMastraForTests } from "./mastra.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const TELEMETRY = "MASTRA_TELEMETRY_DISABLED";

let tmpDir: string;
let originalDataDir: string | undefined;
let originalTelemetry: string | undefined;

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalTelemetry = process.env[TELEMETRY];
  // Force a clean telemetry-env baseline so the ??= belt assertion is meaningful.
  delete process.env[TELEMETRY];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-spike5-"));
  process.env[DATA_DIR] = tmpDir;
  resetMastraForTests();
});

afterEach(() => {
  resetMastraForTests();
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalTelemetry === undefined) delete process.env[TELEMETRY];
  else process.env[TELEMETRY] = originalTelemetry;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("createMastraInstance — library mode, mastra.db on disk", () => {
  it("lands mastra.db in the data dir after storage init", async () => {
    const mastra = createMastraInstance();

    // The public way to force table creation in @mastra/libsql: init() on the
    // composite store. Auto-init would also fire on first read/write, but an
    // explicit init() is the deterministic trigger.
    const storage = mastra.getStorage();
    expect(storage).toBeDefined();
    await storage!.init();

    const mastraDb = join(tmpDir, "mastra.db");
    expect(existsSync(mastraDb)).toBe(true);
    // A real DB file, not an empty placeholder.
    expect(statSync(mastraDb).size).toBeGreaterThan(0);
  });

  it("never-co-write: product autobroker.db is never created here", async () => {
    const mastra = createMastraInstance();
    const storage = mastra.getStorage();
    await storage!.init();

    // Nothing here opens the product DB; the file must not exist, so
    // mastra_* tables provably cannot have co-landed in it.
    expect(existsSync(join(tmpDir, "autobroker.db"))).toBe(false);
  });

  it("arms the MASTRA_TELEMETRY_DISABLED belt on construction", () => {
    createMastraInstance();
    expect(process.env[TELEMETRY]).toBe("1");
  });
});
