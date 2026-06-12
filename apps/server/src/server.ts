/**
 * server — assemble the Fastify v5 app: boot recovery → pubsub + skill-run
 * service → routes → the unified error envelope + 404 handler. Exposes buildServer() for
 * in-process tests (fastify.inject / listen on an ephemeral port) and the listen
 * entrypoint in index.ts.
 *
 * ERROR ENVELOPE: every error response is { error: { field?, message, code } }. A
 * typed RouteError carries its own code/status/field; a ZodError that escapes a
 * handler → 400 content_invalid with a JSON-pointer field; a DuplicateRunIdError →
 * 409; an unknown route or run → 404. fail-LOUD: an un-typed error is a 500 with
 * code 'internal' (never a silent 200).
 *
 * BINDING: 127.0.0.1 only (the trust boundary — no externally reachable port but
 * 8100). The port is configurable for tests (ephemeral 0).
 *
 * Dependency wall: app layer. Imports fastify (an app-layer HTTP dependency),
 * core, tools, workflows (via boot + routes) — NEVER @mastra directly.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import { boot, type BootResult } from "./boot.js";
import { browserEmitterFor } from "./browserEvents.js";
import { RunPubSub } from "./runPubSub.js";
import { SkillRunService } from "./skillRuns.js";
import { SessionService } from "./sessions.js";
import {
  DuplicateRunIdError,
  RailSessionStore,
  createRailMemory,
  setGeosearchBrowserEmitterFactory,
  setInventoryScanBrowserEmitterFactory,
  setLinkScanBrowserEmitterFactory,
} from "@autobroker/workflows";
import { registerRoutes, RouteError } from "./routes.js";
import { resolveStaticServing, registerStaticPlugin, sendSpaFallback } from "./static.js";

/** The assembled server + the live collaborators tests poke at directly. */
export interface BuiltServer {
  app: FastifyInstance;
  pubsub: RunPubSub;
  skillRuns: SkillRunService;
  sessions: SessionService;
  recovery: BootResult["recovery"];
}

/** Shape the unified error envelope. */
function errorEnvelope(
  code: string,
  message: string,
  field?: string,
  extra?: Record<string, unknown>,
): { error: Record<string, unknown> } {
  return {
    error: {
      ...(field !== undefined ? { field } : {}),
      message,
      code,
      ...(extra !== undefined ? extra : {}),
    },
  };
}

/**
 * Build the Fastify app (boot recovery + routes + handlers). Does NOT listen —
 * the caller (index.ts or a test) decides listen vs inject. `quiet` suppresses
 * the boot recovery log.
 */
export async function buildServer(opts: { quiet?: boolean } = {}): Promise<BuiltServer> {
  const { mastra, recovery } = await boot({ quiet: opts.quiet ?? false });

  const pubsub = new RunPubSub();
  const skillRuns = new SkillRunService(mastra, pubsub);

  // Browser-skill voiced trace: hand the workflows layer the per-run SSE
  // adapter so a geosearch run's browser session streams browser.* frames onto
  // its own channel. Set once per built server (last build wins — one server
  // per process in the production topology; the adapter drops events for runs
  // with no channel rather than throwing mid-navigation).
  setGeosearchBrowserEmitterFactory((runId) => browserEmitterFor(pubsub, runId));
  setInventoryScanBrowserEmitterFactory((runId) => browserEmitterFor(pubsub, runId));
  setLinkScanBrowserEmitterFactory((runId) => browserEmitterFor(pubsub, runId));

  // sessions = Mastra Memory threads. The rail Memory is constructed in the
  // workflows layer (createRailMemory — the ONLY @mastra/memory construction; the
  // OM model is pinned to DeepSeek) so the app never imports @mastra. The store +
  // service own thread CRUD + the wire projection + the intake fork.
  const sessions = new SessionService(new RailSessionStore(createRailMemory()));

  // Crash-and-resume: re-attach every suspended run recoverOnBoot found, so a
  // form-decision can resume it in THIS fresh process. Policy for stale 'running'
  // rows is report+leave (boot logged them); only the cleanly suspended runs are
  // re-attached for resume.
  for (const run of recovery.suspended) {
    await skillRuns.reattach(run.runId, run.workflowId);
  }

  const app = Fastify({
    // We validate with Zod in handlers; Fastify's own JSON-schema validation is
    // unused. Keep the default JSON body parser (8000-char message etc. are
    // enforced by Zod, not by a body-limit here).
    logger: false,
  });

  registerRoutes(app, { skillRuns, pubsub, sessions });

  // Single-port prod serving: resolve apps/ui/dist serving info NOW (sync, no
  // registration) so the notFoundHandler below can close over it. The plugin
  // itself is registered LAST — an awaited register() BOOTS the instance and a
  // setErrorHandler/setNotFoundHandler installed after that is silently ignored
  // (2026-06-05 regression: API error envelopes degraded to Fastify defaults
  // whenever dist existed, i.e. exactly the production shape).
  const serving = resolveStaticServing();

  // Unified error envelope. Order: typed RouteError → ZodError →
  // DuplicateRunIdError → fallback 500.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof RouteError) {
      reply
        .code(err.status)
        .send(errorEnvelope(err.code, err.message, err.field, err.extra));
      return;
    }
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      reply.code(400).send(
        errorEnvelope(
          "content_invalid",
          "request body invalid",
          issue ? `/${issue.path.join("/")}` : undefined,
          { issues: err.issues },
        ),
      );
      return;
    }
    if (err instanceof DuplicateRunIdError) {
      reply
        .code(409)
        .send(errorEnvelope("duplicate_run_id", err.message, undefined, { run_id: err.runId }));
      return;
    }
    // A Fastify body-parse error (malformed JSON) carries statusCode 400.
    if (typeof (err as { statusCode?: number }).statusCode === "number") {
      const status = (err as { statusCode: number }).statusCode;
      reply.code(status).send(errorEnvelope("bad_request", "request could not be parsed"));
      return;
    }
    // fail-LOUD: an un-typed error is a 500 (never a silent success). The raw
    // message stays server-side (logged) — an internal driver/library string
    // must not leak verbatim to the client (wire-review minor, 2026-06-05).
    req.log.error(err);
    reply.code(500).send(errorEnvelope("internal", "internal error"));
  });

  // Unknown route → SPA fallback (a non-/api GET serves index.html so a
  // client-side route resolves) else the 404 envelope. /api/* and non-GET always
  // 404 as JSON (sendSpaFallback returns false for them).
  app.setNotFoundHandler((req, reply) => {
    if (sendSpaFallback(serving, req, reply)) return;
    reply
      .code(404)
      .send(errorEnvelope("not_found", `no route ${req.method} ${req.url}`));
  });

  // Register the static plugin LAST (boots the instance — see note above).
  if (serving !== null) await registerStaticPlugin(app, serving);

  return { app, pubsub, skillRuns, sessions, recovery };
}
