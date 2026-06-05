/**
 * SPIKE-2/7 child process driver. Each invocation is a SEPARATE OS process, so
 * every recovery action it performs proves the deterministic-tool-re-registration
 * property: the child re-imports the fixture module (rebuilding the step
 * closures) and the REAL built runtime glue (@autobroker/workflows), then acts on
 * a run that a DIFFERENT process created. Nothing is shared but the on-disk
 * mastra.db snapshot + the data dir.
 *
 * Usage:  node spike2.child.mjs <mode> <dataDir> <runId> [approve]
 *
 * Modes:
 *   start-suspend     start the CRASH run; exit 0 once storage shows 'suspended'.
 *   recover-resume    recoverOnBoot → resume the suspended run with {approve}.
 *   start-slow-hang   start the SLOW run; print "SLOW_RUNNING" once storage shows
 *                     'running', then block forever (parent SIGKILLs this).
 *   recover-restart   recoverOnBoot → restartStaleRun the stale 'running' run.
 *   recover-cancel    recoverOnBoot → cancelStaleRun the stale 'running' run.
 *   dup-guard         startRunGuarded twice with the same runId (second must throw).
 *
 * Output protocol: the child prints exactly one JSON line prefixed "RESULT " on
 * success so the parent can parse it; failures print "ERROR " + message and exit 1.
 */

import process from "node:process";

import {
  recoverOnBoot,
  restartStaleRun,
  cancelStaleRun,
  startRunGuarded,
  DuplicateRunIdError,
} from "@autobroker/workflows";

import {
  buildSpikeMastra,
  SPIKE_WORKFLOW_IDS,
  CRASH_WORKFLOW_ID,
  SLOW_WORKFLOW_ID,
} from "./spike2.fixture.mjs";

const [mode, dataDir, runId, approveArg] = process.argv.slice(2);

function emit(obj) {
  process.stdout.write("RESULT " + JSON.stringify(obj) + "\n");
}
function fail(message) {
  process.stdout.write("ERROR " + message + "\n");
  process.exit(1);
}

process.env.AUTOBROKER_DATA_DIR = dataDir;
process.env.MASTRA_TELEMETRY_DISABLED = "1";

async function pollStatus(workflow, id, want, capMs = 8000) {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    const st = await workflow.getWorkflowRunById(id);
    if (st?.status === want) return st;
    await new Promise((r) => setTimeout(r, 80));
  }
  return await workflow.getWorkflowRunById(id);
}

async function main() {
  const mastra = buildSpikeMastra(dataDir);
  await mastra.getStorage()?.init();

  switch (mode) {
    case "start-suspend": {
      const wf = mastra.getWorkflow(CRASH_WORKFLOW_ID);
      const run = await wf.createRun({ runId });
      // Fire-and-forget: start() resolves WITH status 'suspended' for a run that
      // hits suspend(), so we can await it here and verify via storage.
      const result = await run.start({ inputData: {} });
      const st = await pollStatus(wf, runId, "suspended");
      emit({ startStatus: result.status, storageStatus: st?.status ?? null });
      process.exit(0);
      break;
    }
    case "recover-resume": {
      const report = await recoverOnBoot(mastra, { workflowIds: SPIKE_WORKFLOW_IDS });
      const target = report.suspended.find((s) => s.runId === runId);
      if (!target) fail(`recoverOnBoot did not find suspended runId ${runId}`);
      const wf = mastra.getWorkflow(target.workflowId);
      // Re-attach a FRESH handle (this process never created the run) and resume.
      const handle = await wf.createRun({ runId });
      const approve = approveArg === "true";
      // Resume via the DISCOVERED suspended step path (review F-glue-6): proves
      // the path recoverOnBoot reports is USABLE, not merely reported.
      const discoveredStep = target.suspendedStepPath?.[0];
      if (!discoveredStep) fail(`no suspendedStepPath discovered for ${runId}`);
      const result = await handle.resume({
        step: discoveredStep,
        resumeData: { approve },
      });
      emit({
        foundSuspendedStepPath: target.suspendedStepPath ?? null,
        resumeStatus: result.status,
      });
      process.exit(0);
      break;
    }
    case "start-slow-hang": {
      const wf = mastra.getWorkflow(SLOW_WORKFLOW_ID);
      const run = await wf.createRun({ runId });
      // Fire WITHOUT awaiting — stepSlow blocks; we must stay 'running'.
      run.start({ inputData: {} }).catch(() => {});
      const st = await pollStatus(wf, runId, "running", 6000);
      if (st?.status !== "running") fail(`slow run never reached running (got ${st?.status})`);
      // Signal the parent we are genuinely mid-RUNNING, then block forever.
      process.stdout.write("SLOW_RUNNING\n");
      // Keep the event loop alive indefinitely; the parent SIGKILLs us.
      await new Promise(() => {});
      break;
    }
    case "recover-restart": {
      const report = await recoverOnBoot(mastra, { workflowIds: SPIKE_WORKFLOW_IDS });
      const target = report.stale.find((s) => s.runId === runId);
      if (!target) fail(`recoverOnBoot did not find stale running runId ${runId}`);
      const status = await restartStaleRun(mastra, target);
      emit({ staleFound: true, restartStatus: status });
      process.exit(0);
      break;
    }
    case "recover-cancel": {
      const report = await recoverOnBoot(mastra, { workflowIds: SPIKE_WORKFLOW_IDS });
      const target = report.stale.find((s) => s.runId === runId);
      if (!target) fail(`recoverOnBoot did not find stale running runId ${runId}`);
      const status = await cancelStaleRun(mastra, target);
      emit({ staleFound: true, cancelStatus: status });
      process.exit(0);
      break;
    }
    case "dup-guard": {
      const wf = mastra.getWorkflow(CRASH_WORKFLOW_ID);
      // First guarded start succeeds (suspends at the gate).
      const first = await startRunGuarded(wf, { runId, inputData: {} });
      let threw = false;
      let errName = null;
      try {
        await startRunGuarded(wf, { runId, inputData: {} });
      } catch (err) {
        threw = true;
        errName = err instanceof DuplicateRunIdError ? "DuplicateRunIdError" : err?.name ?? "unknown";
      }
      // Confirm storage still holds exactly one run for this id-space and the
      // first run's state was NOT clobbered.
      const all = await wf.listWorkflowRuns({});
      const idsForRun = all.runs.filter((r) => r.runId === runId);
      const firstStatus =
        first.result && typeof first.result === "object" && "status" in first.result
          ? first.result.status
          : null;
      emit({
        firstStartStatus: firstStatus,
        secondThrew: threw,
        secondErrName: errName,
        runCountForId: idsForRun.length,
      });
      process.exit(0);
      break;
    }
    default:
      fail(`unknown mode ${mode}`);
  }
}

main().catch((err) => fail(err?.stack ?? String(err)));
