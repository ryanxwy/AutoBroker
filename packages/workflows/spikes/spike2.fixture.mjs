/**
 * SPIKE-2/7 shared workflow fixture (NOT a product workflow — never exported
 * from src/index.ts). Two flat, no-nesting workflows used by the crash-and-resume
 * spike. Defined as plain ESM so the child crash scripts can run under bare Node
 * (fast startup, clean SIGKILL) while importing the REAL built runtime glue from
 * the package — that is what proves deterministic tool re-registration across a
 * FRESH process (closures are re-created by THIS module import, never persisted).
 *
 * Mastra/libsql/zod are imported directly here. This file lives under spikes/ so
 * the workflows tsconfig (`include: ["src/**\/*.ts"]`) never sweeps it; it is a
 * test fixture, not shipped code.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Mastra } from "@mastra/core";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { LibSQLStore } from "@mastra/libsql";
import { z } from "zod";

export const CRASH_WORKFLOW_ID = "spike_crash_resume";
export const SLOW_WORKFLOW_ID = "spike_slow_crash_resume";

/** Path to the guarded side-effect marker FILE inside a run's data dir. */
export function sideEffectMarkerPath(dataDir) {
  return join(dataDir, "side-effect.marker");
}

/** Path to the stepA execution-count log (one line appended per execution). */
export function stepARunLogPath(dataDir) {
  return join(dataDir, "stepA.runs.log");
}

/**
 * The release gate for the SLOW workflow's gate step. While ABSENT the slow step
 * blocks (polling); a recovery process writes this file so a restart()-driven
 * re-run of the in-flight step can complete deterministically (no 30s wait).
 */
export function releaseGatePath(dataDir) {
  return join(dataDir, "release.gate");
}

/**
 * Build the CRASH workflow: stepA (pure marker) -> stepGate (suspend; on
 * resume {approve:false} returns WITHOUT the side effect, on {approve:true}
 * writes the side-effect marker file) -> stepB (final marker). Flat, no nesting.
 */
function buildCrashWorkflow(dataDir) {
  const stepARunLog = stepARunLogPath(dataDir);
  const sideEffect = sideEffectMarkerPath(dataDir);

  const stepA = createStep({
    id: "stepA",
    inputSchema: z.object({}),
    outputSchema: z.object({ aRan: z.boolean() }),
    execute: async () => {
      // Append one line per execution so the spike can prove stepA ran exactly
      // once even across resume (a completed step is never re-executed).
      const { appendFileSync } = await import("node:fs");
      appendFileSync(stepARunLog, "A\n");
      return { aRan: true };
    },
  });

  const stepGate = createStep({
    id: "stepGate",
    inputSchema: z.object({ aRan: z.boolean() }),
    outputSchema: z.object({ approved: z.boolean() }),
    resumeSchema: z.object({ approve: z.boolean() }),
    suspendSchema: z.object({ ask: z.string() }),
    execute: async ({ resumeData, suspend }) => {
      if (!resumeData) {
        // First pass — pause for human approval. The side effect has NOT run.
        await suspend({ ask: "approve the guarded side effect?" });
        return { approved: false };
      }
      if (resumeData.approve === true) {
        // APPROVE — the single place the guarded side effect can physically
        // fire, and ONLY on this explicit branch (review F-glue-3: fire-on-
        // explicit-approve, never fire-unless-denied; the gate must stay
        // fail-closed even if framework resumeData validation were disabled).
        writeFileSync(sideEffect, "FIRED");
        return { approved: true };
      }
      // DENY / anything non-true (spike-7): zero side effects, fail closed.
      return { approved: false };
    },
  });

  const stepB = createStep({
    id: "stepB",
    inputSchema: z.object({ approved: z.boolean() }),
    outputSchema: z.object({ done: z.boolean(), approved: z.boolean() }),
    execute: async ({ inputData }) => ({ done: true, approved: inputData.approved }),
  });

  return createWorkflow({
    id: CRASH_WORKFLOW_ID,
    inputSchema: z.object({}),
    outputSchema: z.object({ done: z.boolean(), approved: z.boolean() }),
  })
    .then(stepA)
    .then(stepGate)
    .then(stepB)
    .commit();
}

/**
 * Build the SLOW workflow: stepA (pure marker, same log) -> stepSlow (blocks
 * until the release gate file appears OR aborts) -> stepB. Used for the
 * killed-mid-RUNNING case: a child starts it and is SIGKILLed while stepSlow
 * blocks, leaving a stale 'running' row. Recovery writes the release gate so a
 * restart() re-run of stepSlow completes fast.
 */
function buildSlowWorkflow(dataDir) {
  const stepARunLog = stepARunLogPath(dataDir);
  const releaseGate = releaseGatePath(dataDir);

  const stepA = createStep({
    id: "stepA",
    inputSchema: z.object({}),
    outputSchema: z.object({ aRan: z.boolean() }),
    execute: async () => {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(stepARunLog, "A\n");
      return { aRan: true };
    },
  });

  const stepSlow = createStep({
    id: "stepSlow",
    inputSchema: z.object({ aRan: z.boolean() }),
    outputSchema: z.object({ slowDone: z.boolean() }),
    execute: async ({ abortSignal }) => {
      // Poll for the release gate. Until present, block — this is the window the
      // parent SIGKILLs in. 30s cap so a forgotten gate never hangs CI forever.
      for (let i = 0; i < 300; i++) {
        if (existsSync(releaseGate)) return { slowDone: true };
        if (abortSignal?.aborted) throw new Error("aborted");
        await new Promise((r) => setTimeout(r, 100));
      }
      return { slowDone: true };
    },
  });

  const stepB = createStep({
    id: "stepB",
    inputSchema: z.object({ slowDone: z.boolean() }),
    outputSchema: z.object({ done: z.boolean() }),
    execute: async () => ({ done: true }),
  });

  return createWorkflow({
    id: SLOW_WORKFLOW_ID,
    inputSchema: z.object({}),
    outputSchema: z.object({ done: z.boolean() }),
  })
    .then(stepA)
    .then(stepSlow)
    .then(stepB)
    .commit();
}

/**
 * Construct a library-mode Mastra instance with BOTH spike fixtures registered,
 * storage at <dataDir>/mastra.db. Mirrors createMastraInstance but stays local
 * to the spike (we want the explicit two-workflow registry the recovery scan
 * iterates). MASTRA_TELEMETRY_DISABLED is set defensively before construction.
 */
export function buildSpikeMastra(dataDir) {
  process.env.MASTRA_TELEMETRY_DISABLED ??= "1";
  const storage = new LibSQLStore({
    id: "autobroker-mastra-spike2",
    url: `file:${join(dataDir, "mastra.db")}`,
  });
  return new Mastra({
    storage,
    workflows: {
      [CRASH_WORKFLOW_ID]: buildCrashWorkflow(dataDir),
      [SLOW_WORKFLOW_ID]: buildSlowWorkflow(dataDir),
    },
  });
}

export const SPIKE_WORKFLOW_IDS = [CRASH_WORKFLOW_ID, SLOW_WORKFLOW_ID];
