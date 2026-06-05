/**
 * @autobroker/server — Layer 5 backend HTTP + SSE entrypoint.
 *
 * Boots the embedded library-mode host (telemetry kill → Mastra instance →
 * storage init → boot recovery) and listens on 127.0.0.1:8100 (configurable via
 * PORT). The trust boundary (§11): 127.0.0.1 only — no externally reachable port
 * but this one.
 *
 * The listen side-effect fires only when this module is the program entrypoint
 * (`node dist/index.js`), never on import — so tests import buildServer() and
 * drive inject()/an ephemeral listen() without this binding 8100.
 */

import { pathToFileURL } from "node:url";

import { buildServer, type BuiltServer } from "./server.js";

export { buildServer, type BuiltServer } from "./server.js";
export { boot, type BootResult } from "./boot.js";
export { RunPubSub, type SseEvent, type EventKind, EVENT_KINDS } from "./runPubSub.js";
export { projectStatus, MASTRA_RUN_STATUSES, type MastraRunStatus } from "./statusProjection.js";
export { IntakeRunService } from "./intakeRuns.js";
export {
  SessionService,
  toSessionResponse,
  type SessionResponse,
  type IntakeScopeNotice,
  type IntakeForkResult,
} from "./sessions.js";

/** Default bind: 127.0.0.1:8100 (the trust-boundary host; §11 / BRIEF §4). */
const HOST = "127.0.0.1";
const DEFAULT_PORT = 8100;

/** Boot + listen. Returns the built server (so a caller could close it). */
export async function main(): Promise<BuiltServer> {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const built = await buildServer();
  await built.app.listen({ host: HOST, port });
  console.info(JSON.stringify({ server: "listening", host: HOST, port }));
  return built;
}

// Entry guard: only listen when run directly (not on import).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
