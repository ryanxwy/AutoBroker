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

import { buildServer, type BuiltServer } from "./server.js";
import { BackgroundScheduler } from "./scheduler.js";
import type { SkillRunService } from "./skillRuns.js";

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

/** Boot + listen. Returns the built server (so a caller could close it). */
export async function main(): Promise<BuiltServer> {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const built = await buildServer();
  await built.app.listen({ host: HOST, port });
  // Long-running-background machinery: croner + the catch-up watermark live in
  // THIS process (the durable backend), not the Electron main launcher.
  startScheduler(built.skillRuns);
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
