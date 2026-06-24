/**
 * Fresh, migrated, throwaway product DB around every test in the caller's file.
 *
 * SkillRunService.start() registers a profile's live run in the durable
 * activation registry, and its terminal teardown clears it — both write the
 * product DB's `pipeline_state` table. Descriptor / skill-run unit tests drive a
 * run through start→terminal with a fake Mastra; they used to be DB-free, so they
 * never set up a schema. Now they need one. A developer machine hides the gap
 * (its real ~/.autobroker-ts is already migrated), so the miss only surfaces on a
 * fresh CI checkout — give every such test its own isolated, migrated DB instead.
 *
 * Isolation: a per-test tmp AUTOBROKER_DATA_DIR (saved/restored), never the real
 * data dir. Mirrors the inline pattern in routes.portfolio.test.ts.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach } from "vitest";

import { closeDb, ensureProductSchema } from "@autobroker/tools";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";

/**
 * Register beforeEach/afterEach on the calling test file so each case runs
 * against a fresh, migrated product DB in its own throwaway directory.
 */
export function useFreshProductDb(): void {
  let tmpDir: string;
  let originalDataDir: string | undefined;
  let originalDbOverride: string | undefined;

  beforeEach(() => {
    originalDataDir = process.env[DATA_DIR];
    originalDbOverride = process.env[DB_OVERRIDE];
    tmpDir = mkdtempSync(join(tmpdir(), "autobroker-skillrun-"));
    process.env[DATA_DIR] = tmpDir;
    delete process.env[DB_OVERRIDE];
    closeDb(); // drop any handle cached for a prior path
    ensureProductSchema(); // migrate the full product schema into the fresh dir
  });

  afterEach(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env[DATA_DIR];
    else process.env[DATA_DIR] = originalDataDir;
    if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
    else process.env[DB_OVERRIDE] = originalDbOverride;
  });
}
