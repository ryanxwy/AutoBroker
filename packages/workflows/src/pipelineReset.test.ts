/**
 * In-stack tests — the pipeline_reset flat typed-YES-gate workflow (DESTRUCTIVE).
 *
 * These drive the REAL flat Mastra createWorkflow → REAL createRun/start/resume
 * chain (in-process against a tmp mastra.db) → REAL step closures, with the
 * destructive collaborators (validateResetToken, backupProductDb, pipelineReset,
 * verifySchema) INJECTED as fakes via the deps seam — so the real suspend/resume
 * mechanics run WITHOUT a real wipe. NO LLM, no network.
 *
 * THE KEYSTONE — NO CONFIRMATION → ZERO DESTRUCTION. Acceptance:
 *   1. approve + verbatim YES → reset called once, verifySchema passes, outcome
 *      "reset" with databaseReset:true.
 *   2. decline at the gate → outcome "declined"; backup + reset NEVER called.
 *   3. confirm with a NON-YES token → treated as a decline (server-side
 *      re-validation); backup + reset NEVER called.
 *   4. the gate suspend renders the 5 plain-speech consequence_lines (no table
 *      names) incl. the in-flight-runs-cleared line.
 *
 * NOTE: this test resolves the workflow against the built @autobroker/tools dist;
 * run it only after the tools barrel exports land + dist is rebuilt.
 *
 * ISOLATION: a fresh os.tmpdir() subdir is AUTOBROKER_DATA_DIR; mastra.db lives
 * there; the wipe collaborators are faked so no autobroker.db is touched.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMastraInstance } from "./mastra.js";
import {
  pipelineResetWorkflow,
  PIPELINE_RESET_WORKFLOW_ID,
  __resetPipelineResetDepsForTests,
  __setPipelineResetDepsForTests,
} from "./pipelineReset.js";
import { PIPELINE_RESET_CONSEQUENCE_LINES } from "./pipelineResetContracts.js";

const DATA_DIR = "AUTOBROKER_DATA_DIR";
const DB_OVERRIDE = "AUTOBROKER_DB";

let tmpDir: string;
let originalDataDir: string | undefined;
let originalDbOverride: string | undefined;

beforeEach(() => {
  originalDataDir = process.env[DATA_DIR];
  originalDbOverride = process.env[DB_OVERRIDE];
  tmpDir = mkdtempSync(join(tmpdir(), "autobroker-reset-wf-"));
  process.env[DATA_DIR] = tmpDir;
  delete process.env[DB_OVERRIDE];
});

afterEach(() => {
  __resetPipelineResetDepsForTests();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env[DATA_DIR];
  else process.env[DATA_DIR] = originalDataDir;
  if (originalDbOverride === undefined) delete process.env[DB_OVERRIDE];
  else process.env[DB_OVERRIDE] = originalDbOverride;
});

/** Fresh Mastra instance with ONLY the reset workflow registered. */
function makeWorkflow() {
  const mastra = createMastraInstance({
    workflows: { [PIPELINE_RESET_WORKFLOW_ID]: pipelineResetWorkflow as never },
  });
  return mastra.getWorkflow(PIPELINE_RESET_WORKFLOW_ID);
}

/** Build a fakes set with spies. The wipe is a no-op fake; verify always ok. */
function fakeDeps() {
  const validateResetToken = vi.fn((s: unknown) =>
    typeof s === "string" && s.trim().toLowerCase() === "yes",
  );
  const backupProductDb = vi.fn(() => "/tmp/fake/backups/autobroker-1.db");
  const pipelineReset = vi.fn(
    (_args: { dataDir: string; skipBackup?: boolean; nowMs?: number }) => ({
      tablesCreated: 31,
      backupPath: "",
    }),
  );
  const verifySchema = vi.fn(() => ({ ok: true, tablesCreated: 31, issues: [] }));
  const resolveDataDir = vi.fn(() => tmpDir);
  const getDb = vi.fn(() => ({}) as never);
  return { validateResetToken, backupProductDb, pipelineReset, verifySchema, resolveDataDir, getDb };
}

function suspendedStep(result: unknown): string | null {
  const steps = (result as { steps?: Record<string, { status?: string }> }).steps;
  if (steps === undefined) return null;
  for (const [id, s] of Object.entries(steps)) {
    if (s.status === "suspended") return id;
  }
  return null;
}

describe("pipeline_reset workflow (DESTRUCTIVE)", () => {
  it("approve + verbatim YES → reset called once, verifySchema passes, outcome reset", async () => {
    const fakes = fakeDeps();
    __setPipelineResetDepsForTests(fakes);
    const wf = makeWorkflow();

    const run = await wf.createRun({ runId: "reset-ok" });
    const start = (await run.start({ inputData: { search_profile_id: null } })) as {
      status: string;
    };
    expect(start.status).toBe("suspended");
    expect(suspendedStep(start)).toBe("confirmGate");

    const final = (await run.resume({
      step: "confirmGate",
      resumeData: { action: "confirm", confirm_token: "YES" },
    })) as { status: string; result?: { outcome?: string; databaseReset?: boolean; tablesCreated?: number } };

    expect(final.status).toBe("success");
    expect(final.result?.outcome).toBe("reset");
    expect(final.result?.databaseReset).toBe(true);
    expect(final.result?.tablesCreated).toBe(31);
    expect(fakes.backupProductDb).toHaveBeenCalledTimes(1);
    expect(fakes.pipelineReset).toHaveBeenCalledTimes(1);
    expect(fakes.pipelineReset.mock.calls[0]![0]).toMatchObject({ skipBackup: true });
    expect(fakes.verifySchema).toHaveBeenCalledTimes(1);
  });

  it("decline at the gate → declined; backup + reset NEVER called (Δ=0 destruction)", async () => {
    const fakes = fakeDeps();
    __setPipelineResetDepsForTests(fakes);
    const wf = makeWorkflow();

    const run = await wf.createRun({ runId: "reset-decline" });
    await run.start({ inputData: { search_profile_id: null } });
    const final = (await run.resume({
      step: "confirmGate",
      resumeData: { action: "decline" },
    })) as { status: string; result?: { outcome?: string } };

    expect(final.status).toBe("success");
    expect(final.result?.outcome).toBe("declined");
    expect(fakes.backupProductDb).not.toHaveBeenCalled();
    expect(fakes.pipelineReset).not.toHaveBeenCalled();
    expect(fakes.verifySchema).not.toHaveBeenCalled();
  });

  it("confirm with a NON-YES token → treated as decline; backup + reset NEVER called", async () => {
    const fakes = fakeDeps();
    __setPipelineResetDepsForTests(fakes);
    const wf = makeWorkflow();

    const run = await wf.createRun({ runId: "reset-bad-token" });
    await run.start({ inputData: { search_profile_id: null } });
    const final = (await run.resume({
      step: "confirmGate",
      resumeData: { action: "confirm", confirm_token: "yeah" },
    })) as { status: string; result?: { outcome?: string } };

    expect(final.status).toBe("success");
    expect(final.result?.outcome).toBe("declined");
    expect(fakes.validateResetToken).toHaveBeenCalledWith("yeah");
    expect(fakes.backupProductDb).not.toHaveBeenCalled();
    expect(fakes.pipelineReset).not.toHaveBeenCalled();
  });

  it("the gate suspend renders the 5 plain-speech consequence_lines (no table names)", async () => {
    const fakes = fakeDeps();
    __setPipelineResetDepsForTests(fakes);
    const wf = makeWorkflow();

    const run = await wf.createRun({ runId: "reset-card" });
    const start = (await run.start({ inputData: { search_profile_id: null } })) as {
      status: string;
      steps?: Record<string, { status?: string; suspendPayload?: unknown }>;
    };
    const payload = start.steps?.["confirmGate"]?.suspendPayload as {
      kind?: string;
      destructive?: boolean;
      confirm_token?: string;
      consequence_lines?: string[];
    };
    expect(payload?.kind).toBe("confirmation_gate");
    expect(payload?.destructive).toBe(true);
    expect(payload?.confirm_token).toBe("YES");
    expect(payload?.consequence_lines).toHaveLength(5);
    expect(payload?.consequence_lines).toEqual([...PIPELINE_RESET_CONSEQUENCE_LINES]);
    // The in-flight-runs-cleared promise is present (the mastra.db reset voiced).
    const joined = (payload?.consequence_lines ?? []).join(" ").toLowerCase();
    expect(joined).toContain("in progress");
    expect(joined).toContain("waiting on your approval");
    // Plain speech — never names a DB table.
    for (const banned of ["accounts", "dealer_quotes", "pipeline_state", "sqlite", "mastra_"]) {
      expect(joined).not.toContain(banned);
    }
  });
});
