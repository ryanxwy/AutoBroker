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
 *      re-attach suspended runs and surface stale 'running' rows.
 *   5. Age policy over the stale rows: a run whose storage row went quiet
 *      RECENTLY is restarted from its last completed step (fire-and-forget —
 *      restart() blocks until the run settles, and boot must not); anything
 *      older, or with no usable timestamp, is canceled. Either way no stale
 *      'running' row is left undisposed. Mutating side effects stay safe under
 *      a restart: they are only reachable through the L2 gate, which has no
 *      approver at boot and therefore fails closed.
 *
 * Returns { mastra, recovery } for the server to wire routes against
 * (recovery.other — waiting/pending/paused — remains report-only).
 */

import {
  cancelStaleRun,
  createMastraInstance,
  recoverOnBoot,
  REGISTERED_WORKFLOWS,
  REGISTERED_WORKFLOW_IDS,
  restartStaleRun,
  type BootRecoveryReport,
} from "@autobroker/workflows";
import {
  loadDotEnvKeys,
  loadSecretsIntoEnv,
  loadEnvConfigIntoEnv,
  getDb,
  seedDemoData,
} from "@autobroker/tools";

/** The Mastra instance type, inferred from createMastraInstance (no @mastra
 *  import — the dependency wall forbids it in the app layer). */
type MastraInstance = ReturnType<typeof createMastraInstance>;

/** A stale run younger than this is restarted from its last completed step;
 *  older (or unknown-age) runs are canceled — the user re-runs the skill. */
export const STALE_RESTART_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * The restart-vs-cancel decision for one stale 'running' row, pure for tests.
 * Unknown age cancels: auto-re-executing work of unknown staleness is the
 * riskier default, and a cancel is always recoverable by re-running the skill.
 */
export function staleDisposition(
  updatedAtMs: number | undefined,
  nowMs: number,
): "restart" | "cancel" {
  if (updatedAtMs === undefined) return "cancel";
  return nowMs - updatedAtMs <= STALE_RESTART_MAX_AGE_MS ? "restart" : "cancel";
}

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

  // (1b) Seed the user-supplied API keys into process.env BEFORE the registry /
  // Mastra is constructed, so the first provider call and the first geocode see
  // the stored keys (the providers + geocoder resolve their key from the env at
  // call time). Precedence: ambient env wins; loadDotEnvKeys fills any gap from a
  // data-dir-independent repo `.env` (NO-CLOBBER); loadSecretsIntoEnv runs LAST so
  // the canonical keys.json wins over `.env`. Either missing file = no-op.
  loadDotEnvKeys();
  loadSecretsIntoEnv();

  // (1b') Seed the persisted operational env-config overrides (the editable
  // GMAIL_BACKEND / CHROME_HEADLESS toggles) into process.env from the env file
  // BEFORE the registry / Mastra / gmail factory is constructed, mirroring the
  // secrets loader. A launch-supplied env var with no file override is left
  // untouched; missing file = no-op.
  loadEnvConfigIntoEnv();

  // (1c) Demo mode (zero-config sample world): write the renderable demo data
  // into the (already-isolated) demo DB before the first request, so the
  // dashboard populates with no key/Gmail/network. Idempotent (seeds only an
  // empty DB) and tools-owned (boot delegates the write down into the tools
  // layer, never opening the product DB directly for a write — the shared
  // long-lived getDb handle is handed straight to the tools seed, so the
  // server reuses one connection rather than leaking an unclosed one). Off
  // entirely unless the launcher armed AUTOBROKER_DEMO_SEED=1 against the
  // isolated demo data dir.
  if (process.env.AUTOBROKER_DEMO_SEED === "1") {
    seedDemoData(getDb());
  }

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
  // other in-flight rows.
  const recovery = await recoverOnBoot(mastra, { workflowIds: REGISTERED_WORKFLOW_IDS });

  // (5) Dispose every stale 'running' row per the age policy. Restarts are
  // fire-and-forget (restart() blocks until the run settles); cancels are
  // awaited (cheap status flip). Failures are logged, never fatal to boot.
  const now = Date.now();
  const restarted: string[] = [];
  const canceled: string[] = [];
  for (const run of recovery.stale) {
    if (staleDisposition(run.updatedAtMs, now) === "restart") {
      restarted.push(run.runId);
      void restartStaleRun(mastra, run).catch((err: unknown) => {
        if (!opts.quiet) {
          console.warn(
            JSON.stringify({
              boot: "stale_restart_failed",
              runId: run.runId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      });
    } else {
      canceled.push(run.runId);
      try {
        await cancelStaleRun(mastra, run);
      } catch (err) {
        if (!opts.quiet) {
          console.warn(
            JSON.stringify({
              boot: "stale_cancel_failed",
              runId: run.runId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
    }
  }

  if (!opts.quiet) {
    console.info(
      JSON.stringify({
        boot: "recovery",
        suspended: recovery.suspended.length,
        stale: recovery.stale.length,
        restarted,
        canceled,
        other: recovery.other.length,
      }),
    );
  }

  return { mastra, recovery };
}
