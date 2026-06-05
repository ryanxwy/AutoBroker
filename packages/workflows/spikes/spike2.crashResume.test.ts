/**
 * SPIKE-2 (crash-and-resume + boot recovery + dup-runId guard) & SPIKE-7 (deny
 * path). PHASE_0 spikes 2 & 7; M0 exit criterion "crash-and-resume 回环".
 *
 * WHAT THIS PROVES, and HOW the proof is honest:
 *   The whole point is durability ACROSS A PROCESS BOUNDARY. So the run that
 *   suspends/blocks is created in a SEPARATE OS process (spike2.child.mjs), that
 *   process exits or is SIGKILLed, and a DIFFERENT fresh process does the
 *   recovery. The recovery process re-imports the fixture (rebuilding step
 *   closures — deterministic tool re-registration, NOT persisted closures) and
 *   the REAL built runtime glue (@autobroker/workflows), then drives recovery
 *   purely from the on-disk mastra.db snapshot. This parent (vitest) only
 *   ORCHESTRATES the children and ASSERTS on storage status + side-effect files.
 *   No part of the durable handoff happens inside this single process.
 *
 * Cases:
 *   (a) crash-while-SUSPENDED → recover + resume {approve:true} → success, the
 *       guarded side-effect marker file is present, stepB ran, stepA ran ONCE.
 *   (b) deny path (spike-7) → resume {approve:false} → side-effect marker ABSENT
 *       (ZERO side effects); terminal status reported faithfully (1.41: 'success'
 *       — the step returned normally without firing the side effect; the
 *       invariant is the side effect never ran, not a particular status name).
 *   (c) killed mid-RUNNING (SIGKILL) → fresh recoverOnBoot SEES the stale
 *       'running' row → restartStaleRun resumes from snapshot to 'success' and
 *       stepA does NOT re-execute (count stays 1); a parallel sub-case shows
 *       cancelStaleRun flips an un-restartable stale run to 'canceled'.
 *   (d) dup-runId → startRunGuarded twice with the same id → second throws
 *       DuplicateRunIdError; storage shows ONE run; first run's state intact.
 *
 * mastra.db file size is recorded after (a)+(b)+(c) (#17284 snapshot-bloat
 * observation — bytes only, non-gating).
 *
 * CI-ABILITY: fully offline (no LLM, no network), deterministic, and well under
 * 60s on a laptop (each child boots a library-mode Mastra + libsql file DB). It
 * therefore runs in CI WITHOUT a live gate. The one timing-sensitive case (c)
 * waits on a stdout "SLOW_RUNNING" marker (not a wall-clock sleep) before the
 * SIGKILL, so it is not flaky. Isolation: a fresh os.tmpdir() dir per case,
 * removed in finally; NEVER ~/.autobroker or ~/.autobroker-ts.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/workflows/spikes
const PKG_ROOT = resolve(HERE, ".."); // packages/workflows
const CHILD = join(HERE, "spike2.child.mjs");

/** Recorded mastra.db sizes (bytes) across cases for the #17284 observation. */
const dbSizes: Record<string, number> = {};

/** Make an isolated tmp data dir; assert it is NOT a real autobroker dir. */
function freshDataDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ab-spike2-${tag}-`));
  // Belt: never operate inside a real data dir.
  if (dir.includes(".autobroker-ts") || dir.includes(join("/", ".autobroker"))) {
    throw new Error(`refusing to use a real autobroker data dir: ${dir}`);
  }
  return dir;
}

interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
  result: Record<string, unknown> | null;
}

/** Run a child mode to completion (synchronous) and parse its RESULT line. */
function runChild(mode: string, dataDir: string, runId: string, approve?: boolean): ChildResult {
  const args = [CHILD, mode, dataDir, runId];
  if (approve !== undefined) args.push(String(approve));
  const res = spawnSync("node", args, {
    cwd: PKG_ROOT,
    env: { ...process.env, AUTOBROKER_DATA_DIR: dataDir, MASTRA_TELEMETRY_DISABLED: "1" },
    encoding: "utf8",
    timeout: 30_000,
  });
  const stdout = res.stdout ?? "";
  const resultLine = stdout.split("\n").find((l) => l.startsWith("RESULT "));
  const result = resultLine ? (JSON.parse(resultLine.slice("RESULT ".length)) as Record<string, unknown>) : null;
  return { status: res.status, stdout, stderr: res.stderr ?? "", result };
}

/** stepA execution count for a data dir (lines in the run log), 0 if absent. */
function stepARunCount(dataDir: string): number {
  const log = join(dataDir, "stepA.runs.log");
  if (!existsSync(log)) return 0;
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length;
}

function sideEffectPresent(dataDir: string): boolean {
  return existsSync(join(dataDir, "side-effect.marker"));
}

function recordDbSize(tag: string, dataDir: string): void {
  const dbPath = join(dataDir, "mastra.db");
  dbSizes[tag] = existsSync(dbPath) ? statSync(dbPath).size : -1;
}

afterAll(() => {
  // eslint-disable-next-line no-console
  console.log("[spike-2] mastra.db sizes (bytes, #17284 observation): " + JSON.stringify(dbSizes));
});

describe("spike-2/7: crash-and-resume across a real process boundary", () => {
  it("(a) crash-while-SUSPENDED → fresh recoverOnBoot + resume{approve:true} → success + side effect fired", () => {
    const dir = freshDataDir("a");
    try {
      // Process A: start to suspension, then exit.
      const a = runChild("start-suspend", dir, "run-a");
      expect(a.status, `start-suspend failed:\n${a.stdout}\n${a.stderr}`).toBe(0);
      expect(a.result?.startStatus).toBe("suspended");
      expect(a.result?.storageStatus).toBe("suspended");
      // After suspension the guarded side effect has NOT run yet.
      expect(sideEffectPresent(dir)).toBe(false);

      // Process B (FRESH): recoverOnBoot finds the suspended run, resume approve.
      const b = runChild("recover-resume", dir, "run-a", true);
      expect(b.status, `recover-resume failed:\n${b.stdout}\n${b.stderr}`).toBe(0);
      // recoverOnBoot returned a re-attachable handle naming the suspended step.
      expect(b.result?.foundSuspendedStepPath).toEqual(["stepGate"]);
      expect(b.result?.resumeStatus).toBe("success");

      // Run completed: the guarded side-effect marker file is present (stepB
      // reached after the gate) and stepA executed exactly once across both
      // processes (a completed step is never re-run on resume).
      expect(sideEffectPresent(dir)).toBe(true);
      expect(stepARunCount(dir)).toBe(1);

      recordDbSize("a_suspend_resume", dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(b) deny path → resume{approve:false} → ZERO side effects; terminal status reported", () => {
    const dir = freshDataDir("b");
    try {
      const a = runChild("start-suspend", dir, "run-b");
      expect(a.status, `start-suspend failed:\n${a.stdout}\n${a.stderr}`).toBe(0);
      expect(a.result?.storageStatus).toBe("suspended");

      const b = runChild("recover-resume", dir, "run-b", false);
      expect(b.status, `recover-resume(deny) failed:\n${b.stdout}\n${b.stderr}`).toBe(0);

      // THE invariant: the guarded side effect NEVER ran on the deny branch.
      expect(sideEffectPresent(dir)).toBe(false);

      // Report the REAL terminal status 1.41 gives this shape: the gate step
      // returned normally (approved:false) without firing the side effect, so
      // the run reaches 'success'. We assert the run terminated (not still
      // suspended/running) AND the side effect is absent — that is the spike-7
      // guarantee, independent of the status label.
      expect(b.result?.resumeStatus).toBe("success");

      recordDbSize("b_deny", dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(c) killed mid-RUNNING (SIGKILL) → fresh recoverOnBoot sees the stale 'running' row → restartStaleRun resumes from snapshot (stepA NOT re-run)", async () => {
    const dir = freshDataDir("c");
    try {
      const status = await runSlowThenKill(dir, "run-c");
      expect(status, "slow child never reached RUNNING before kill").toBe("running");
      // The kill left stepA already executed once and stepSlow mid-flight.
      expect(stepARunCount(dir)).toBe(1);

      // Open the release gate so a restart()-driven re-run of the in-flight
      // stepSlow can complete deterministically, then recover in a FRESH process.
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "release.gate"), "go");

      const r = runChild("recover-restart", dir, "run-c");
      expect(r.status, `recover-restart failed:\n${r.stdout}\n${r.stderr}`).toBe(0);
      expect(r.result?.staleFound).toBe(true);
      // restart() resumed from snapshot to a terminal success.
      expect(r.result?.restartStatus).toBe("success");
      // The completed step (stepA) did NOT re-execute: count is still 1.
      expect(stepARunCount(dir)).toBe(1);

      recordDbSize("c_kill_restart", dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(c') killed mid-RUNNING → cancelStaleRun flips an un-restartable stale run to 'canceled'", async () => {
    const dir = freshDataDir("cprime");
    try {
      const status = await runSlowThenKill(dir, "run-cp");
      expect(status, "slow child never reached RUNNING before kill").toBe("running");

      // No release gate: we do NOT want to restart (the in-flight step would
      // re-block). cancelStaleRun must deterministically flip it to 'canceled'.
      const r = runChild("recover-cancel", dir, "run-cp");
      expect(r.status, `recover-cancel failed:\n${r.stdout}\n${r.stderr}`).toBe(0);
      expect(r.result?.staleFound).toBe(true);
      expect(r.result?.cancelStatus).toBe("canceled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(d) dup-runId → startRunGuarded twice → second throws DuplicateRunIdError; ONE run; first state intact", () => {
    const dir = freshDataDir("d");
    try {
      const r = runChild("dup-guard", dir, "run-d");
      expect(r.status, `dup-guard failed:\n${r.stdout}\n${r.stderr}`).toBe(0);
      // First guarded start suspended at the gate.
      expect(r.result?.firstStartStatus).toBe("suspended");
      // Second guarded start with the SAME id threw the typed error.
      expect(r.result?.secondThrew).toBe(true);
      expect(r.result?.secondErrName).toBe("DuplicateRunIdError");
      // Storage holds exactly ONE run for that id (no clobber duplicate row),
      // and the guard prevented the create+start that would have overwritten the
      // first run's stored state (#5549 defense-in-depth).
      expect(r.result?.runCountForId).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Spawn the slow-hang child, wait (on its stdout "SLOW_RUNNING" marker, NOT a
 * wall-clock sleep) until storage shows the run 'running', then SIGKILL it.
 * Returns the run status string the child observed just before it was killed.
 */
function runSlowThenKill(dataDir: string, runId: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("node", [CHILD, "start-slow-hang", dataDir, runId], {
      cwd: PKG_ROOT,
      env: { ...process.env, AUTOBROKER_DATA_DIR: dataDir, MASTRA_TELEMETRY_DISABLED: "1" },
    });

    let buf = "";
    let settled = false;
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      rejectPromise(new Error(`slow child did not signal RUNNING within 15s. stdout:\n${buf}`));
    }, 15_000);

    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      if (!settled && buf.includes("SLOW_RUNNING")) {
        settled = true;
        clearTimeout(guard);
        // Hard kill mid-RUNNING (simulate a process death; no graceful cancel).
        child.kill("SIGKILL");
      }
      if (!settled && buf.includes("ERROR ")) {
        settled = true;
        clearTimeout(guard);
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        rejectPromise(new Error(`slow child errored: ${buf}`));
      }
    });

    child.on("exit", () => {
      // The child was SIGKILLed by us; resolve with the storage status the child
      // confirmed (it only prints SLOW_RUNNING after storage shows 'running').
      if (buf.includes("SLOW_RUNNING")) resolvePromise("running");
      else if (!settled) {
        settled = true;
        clearTimeout(guard);
        rejectPromise(new Error(`slow child exited before RUNNING. stdout:\n${buf}`));
      }
    });
  });
}
