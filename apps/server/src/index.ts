/**
 * @autobroker/server — Layer 5 backend HTTP + SSE entrypoint.
 *
 * Boots the embedded library-mode host (telemetry kill → Mastra instance →
 * storage init → boot recovery) and listens on 127.0.0.1:8100 (configurable via
 * PORT). The trust boundary: 127.0.0.1 only — no externally reachable port but
 * this one.
 *
 * The listen side-effect fires only when this module is the program entrypoint
 * (`node dist/index.js`), never on import — so tests import buildServer() and
 * drive inject()/an ephemeral listen() without this binding 8100.
 */

import { pathToFileURL } from "node:url";

import {
  getDb,
  profileHealth,
  recordActivation,
  clearActivationByRunId,
  lookupRunIdForProfile,
  lookupProfileIdForRunId,
  listActiveProfileIds,
} from "@autobroker/tools";

import { buildServer, type BuiltServer } from "./server.js";
import { BackgroundScheduler } from "./scheduler.js";
import {
  PortfolioScheduler,
  type ProfileHealthProvider,
} from "./portfolio/portfolioScheduler.js";
import type { ActivationRegistry } from "./portfolio/activationRegistry.js";
import { ProfileRunConflictError, type SkillRunService } from "./skillRuns.js";

export { buildServer, type BuiltServer } from "./server.js";
export { boot, type BootResult } from "./boot.js";
export { RunPubSub, type SseEvent, type EventKind, EVENT_KINDS } from "./runPubSub.js";
export { projectStatus, MASTRA_RUN_STATUSES, type MastraRunStatus } from "./statusProjection.js";
export { SkillRunService, RUN_DESCRIPTORS, type RunDescriptor } from "./skillRuns.js";
export {
  SessionService,
  toSessionResponse,
  type SessionResponse,
  type IntakeScopeNotice,
  type IntakeForkResult,
} from "./sessions.js";
export {
  BackgroundScheduler,
  SCHEDULED_JOBS,
  type JobSpec,
  type JobTrigger,
  type ScheduledJobHandler,
  type SchedulerOptions,
  type SchedulerTrace,
} from "./scheduler.js";
export { catchUpDecision, mostRecentScheduledFire, type CatchUpDecision } from "./schedulerCatchup.js";
// TEST-ONLY seam (refused outside a vitest/NODE_ENV=test runner, see routes.ts):
// the functional-lane host injects a deterministic NL-route classifier so freeform
// (chat_freeform) func cases exercise the POST /api/route → intake wiring WITHOUT a
// live router LLM call. Keyless (as CI is) that call returns empty tool_calls and
// trips the fail-closed abort before the gate renders, hanging the case.
export { __setRouteClassifierForTests } from "./routes.js";

/** Default bind: 127.0.0.1:8100 (the trust-boundary host). */
const HOST = "127.0.0.1";
const DEFAULT_PORT = 8100;

/**
 * Wire the background scheduler into the long-lived server process. When the
 * server runs as the Electron utilityProcess child, Electron's powerMonitor
 * (which lives in the main process only) forwards resume/suspend down over the
 * message channel as { scheduler: "power", kind }; relay those into the
 * scheduler so a wake re-runs the catch-up pass. When the server runs
 * standalone (dev / harness) there is no parentPort and the heartbeat + boot
 * pass alone drive catch-up.
 */
function startScheduler(skillRuns: SkillRunService): BackgroundScheduler {
  const parentPort = (
    process as unknown as {
      parentPort?: {
        on: (ev: string, fn: (m: unknown) => void) => void;
        postMessage: (m: unknown) => void;
      };
    }
  ).parentPort;

  // Run-scoped power-save blocker: the blocker itself is an Electron API that
  // only the main process can call, so the child asks main to acquire/release
  // it around a single job over the message channel. No parentPort (standalone
  // dev/harness) → no blocker, which is correct (nothing to keep awake there).
  const powerGuard =
    parentPort !== undefined
      ? {
          acquire: () => parentPort.postMessage({ scheduler: "power_blocker", action: "acquire" }),
          release: () => parentPort.postMessage({ scheduler: "power_blocker", action: "release" }),
        }
      : undefined;

  const scheduler = new BackgroundScheduler(powerGuard !== undefined ? { powerGuard } : {});

  // Wire the daily_digest JOB seam: a fired job drives a headless daily_digest
  // run over ALL active profiles (search_profile_id:null → the workflow's
  // resolveScope enumerates them; zero-active → a graceful skip). The run's
  // notify step output carries { headline, deepLink:"/digest" } for the U-G
  // ladder, and the deterministic aggregation pulses data.changed{kinds:["digest"]}
  // so any open /digest page refetches. The scheduler owns its own
  // scheduler.last_success.daily_digest watermark (advanced on a clean handler
  // return; a throw leaves it catch-up-due) — the PRODUCT digest.last_at
  // watermark is the one the workflow itself advances per summarized profile.
  scheduler.registerHandler("daily_digest", async () => {
    await skillRuns.start({
      skill: "daily_digest",
      input: { search_profile_id: null, since_hours: null },
    });
  });

  scheduler.start();

  // utilityProcess child: relay forwarded power events from the Electron main.
  // On the parentPort side a message arrives as a MessageEvent whose .data holds
  // the payload main posted (distinct from the parent UtilityProcess side, which
  // receives the payload directly).
  parentPort?.on("message", (event: unknown) => {
    const msg = (event as { data?: unknown }).data;
    if (
      typeof msg === "object" &&
      msg !== null &&
      (msg as { scheduler?: unknown }).scheduler === "power"
    ) {
      const kind = (msg as { kind?: unknown }).kind;
      if (kind === "resume" || kind === "suspend") scheduler.onPower(kind);
    }
  });
  return scheduler;
}

/**
 * Mount the PortfolioScheduler — the bounded hot-set fan-out that makes N
 * independent profile pipelines actually run. It is GATED OFF by default
 * (AUTOBROKER_PORTFOLIO_SCHEDULER !== "1") so the single-profile / pinned path stays
 * byte-identical: when off, nothing is constructed and no profile run is ever
 * auto-started; the ApprovalInbox (wired in buildServer) still works. When on (the
 * multi-profile lane), it ticks on an interval, scheduling each
 * HOT profile as its own quote_pipeline run (the explicit-pin N=1 case) under the
 * MAX_CONCURRENT_ACTIVE_PROFILES cap, and tracks slots via the run-lifecycle stream.
 *
 * CROSS-PROCESS BOUNDARY: SkillRunService atomically claims the profile in
 * SQLite before Mastra creates a run, for HTTP and scheduler starts alike. A
 * scheduler that loses the claim receives null and continues to the next
 * profile without creating an orphan run.
 */
export function startPortfolioScheduler(skillRuns: SkillRunService): PortfolioScheduler | undefined {
  if (process.env.AUTOBROKER_PORTFOLIO_SCHEDULER !== "1") return undefined;
  // The durable ProfileId->runId registry, adapted to the scheduler's read/lifecycle
  // seam. SkillRunService owns the pre-start atomic claim; this adapter's register
  // call is an idempotent assertion of the same pair.
  const activationRegistry: ActivationRegistry = {
    liveRunFor: (profileId) => lookupRunIdForProfile(profileId, getDb()) ?? undefined,
    profileForRun: (runId) => lookupProfileIdForRunId(runId, getDb()) ?? undefined,
    register: (profileId, runId) => recordActivation({ profileId, runId, db: getDb() }),
    releaseRun: (runId) => {
      clearActivationByRunId({ runId, db: getDb() });
    },
    liveProfileIds: () => new Set(listActiveProfileIds(getDb())),
  };
  // The real derived hot/warm/cold projection (it enumerates the active set + derives
  // lock-blocked/dormancy from the DB itself, given the live-run set).
  const healthProvider: ProfileHealthProvider = {
    snapshot: (liveRunProfileIds) => profileHealth(getDb(), liveRunProfileIds),
  };
  const descriptor = skillRuns.descriptorFor("quote_pipeline");
  const scheduler = new PortfolioScheduler({
    healthProvider,
    activationRegistry,
    cap: Number(process.env.MAX_CONCURRENT_ACTIVE_PROFILES ?? 4),
    startProfileRun: async (profileId) => {
      const input =
        descriptor?.buildInput({ search_profile_id: profileId }) ?? { search_profile_id: profileId };
      try {
        return await skillRuns.start({ skill: "quote_pipeline", input });
      } catch (err) {
        if (err instanceof ProfileRunConflictError) return null;
        throw err;
      }
    },
  });
  // The scheduler manages slots off the run-lifecycle stream.
  skillRuns.addLifecycleListener(scheduler);
  scheduler.start(Number(process.env.AUTOBROKER_PORTFOLIO_TICK_MS ?? 15_000));
  return scheduler;
}

/** Boot + listen. Returns the built server (so a caller could close it). */
export async function main(): Promise<BuiltServer> {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const built = await buildServer();
  await built.app.listen({ host: HOST, port });
  // Long-running-background machinery: croner + the catch-up watermark live in
  // THIS process (the durable backend), not the Electron main launcher.
  startScheduler(built.skillRuns);
  // The portfolio fan-out (off by default — byte-identical single-profile path).
  startPortfolioScheduler(built.skillRuns);
  // Report the ACTUAL bound port (PORT=0 → ephemeral), not the configured one.
  console.info(JSON.stringify({ server: "listening", host: HOST, port: (built.app.server.address() as { port: number }).port }));
  return built;
}

// Entry guard: only listen when run directly (not on import).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
