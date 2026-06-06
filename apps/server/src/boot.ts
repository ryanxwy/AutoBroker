/**
 * boot — the embedded-host boot sequence (the runtimeGlue header's "boot
 * recovery" contract). This is the app-layer caller that owns the registry map
 * and drives the workflows-layer glue; it never imports @mastra directly (the
 * Mastra instance type flows in via the createMastraInstance return — inference
 * only, no @mastra import statement) and never opens the product DB.
 *
 * SEQUENCE:
 *   1. MASTRA_TELEMETRY_DISABLED ??= '1' — defensive belt BEFORE construction
 *      (createMastraInstance also sets it with ??=, but we set it here too so the
 *      env is silent even if the app is booted by a path that constructs Mastra
 *      lazily later; ??= respects an explicit operator override).
 *   2. createMastraInstance({ workflows: REGISTERED_WORKFLOWS }) — library mode,
 *      storage = mastra.db on the resolved data dir; the module import of the
 *      registry is what re-registers the deterministic step closures (runtimeGlue
 *      header) so a run suspended in a prior process is re-attachable here.
 *   3. await storage init — force the mastra_* tables to exist before
 *      recoverOnBoot reads them (a fresh data dir has no mastra.db yet; reading
 *      run lists before init would surface a missing-table error).
 *   4. recoverOnBoot(mastra, { workflowIds: REGISTERED_WORKFLOW_IDS }) —
 *      re-attach suspended runs (current policy is report + leave; the
 *      restart/cancel wiring exists in glue for stale 'running' rows but boot only
 *      REPORTS — it does not auto-restart/cancel).
 *
 * Returns { mastra, recovery } for the server to wire routes against. The caller
 * decides what to do with recovery.stale / recovery.other (currently: log them).
 */

import {
  createMastraInstance,
  recoverOnBoot,
  REGISTERED_WORKFLOWS,
  REGISTERED_WORKFLOW_IDS,
  type BootRecoveryReport,
} from "@autobroker/workflows";

/** The Mastra instance type, inferred from createMastraInstance (no @mastra
 *  import — the dependency wall forbids it in the app layer). */
type MastraInstance = ReturnType<typeof createMastraInstance>;

/** What boot() returns: the live instance + the recovery report. */
export interface BootResult {
  mastra: MastraInstance;
  recovery: BootRecoveryReport;
}

/**
 * Run the boot sequence. `quiet` suppresses the recovery log line (tests).
 */
export async function boot(opts: { quiet?: boolean } = {}): Promise<BootResult> {
  // (1) Telemetry kill — belt before construction (honored since core 1.37.0).
  process.env.MASTRA_TELEMETRY_DISABLED ??= "1";

  // (2) Library-mode instance with the skill workflows registered. The registry
  // module import re-registers the step closures deterministically (runtimeGlue).
  const mastra = createMastraInstance({ workflows: REGISTERED_WORKFLOWS });

  // (3) Force storage init so the mastra_* tables exist before recoverOnBoot
  // reads run lists (a fresh data dir starts with no mastra.db tables). The
  // storage handle is on the instance; init() is idempotent.
  const storage = (mastra as { getStorage?: () => { init?: () => Promise<void> } | undefined })
    .getStorage?.();
  if (storage?.init !== undefined) {
    await storage.init();
  }

  // (4) Boot recovery — report suspended (re-attachable) + stale 'running' +
  // other in-flight rows. Current policy: REPORT + LEAVE (no auto-restart/cancel).
  const recovery = await recoverOnBoot(mastra, { workflowIds: REGISTERED_WORKFLOW_IDS });

  if (!opts.quiet) {
    console.info(
      JSON.stringify({
        boot: "recovery",
        suspended: recovery.suspended.length,
        stale: recovery.stale.length,
        other: recovery.other.length,
      }),
    );
  }

  return { mastra, recovery };
}
