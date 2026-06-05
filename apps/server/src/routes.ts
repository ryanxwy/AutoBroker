/**
 * routes — the M1 Fastify route table (BACKEND_SERVICES §3, §7, §13.2). All
 * routes under /api, bound 127.0.0.1 by the server. Request bodies validated
 * with Zod (manual parse, NOT Fastify JSON-schema — keeps zod v4 as the single
 * validator and the §13.2 envelope shapes exact). The error envelope is centralized
 * in the server's setErrorHandler; handlers throw typed errors.
 *
 * M1 SCOPE (the swimlane "headless intake GREEN"): start intake, status, SSE
 * stream, form-decision (three-phase claim), profiles read, skills manifest,
 * mode. The chat-rail session/turn plumbing is M2 — NOT built here (the swimlane
 * puts sessions-as-thread projection in M2). The task brief's headless start uses
 * POST /api/skill-runs directly (delta vs §3.2's POST /sessions/{id}/turns, which
 * routes intake through the rail) — recorded in api_findings.
 *
 * WIRE CASE CONTRACT (§3): request fields camelCase where the route table says so;
 * for the headless M1 start the task BUILD body is snake_case (input_mode,
 * freeform_text, seed_fields) matching the workflow input — kept verbatim. Response
 * profile views are snake_case (SearchProfileView mirrors the DB column case, §3.3).
 *
 * Dependency wall: app layer. Imports core (schemas), tools (DB reads via openDb +
 * resolveDataDir + the resolver) — NEVER @mastra, NEVER drizzle/better-sqlite3
 * directly (openDb is the tools closure). Profile READS go through the tools
 * resolver/openDb; the only WRITE path stays inside the workflow's persist step.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { openDb, resolveDataDir, type Db } from "@autobroker/tools";

import {
  IntakeRunService,
  FormDecisionBodySchema,
  FormDecisionError,
  UnknownRunError,
  INTAKE_SKILL,
  type IntakeStartInput,
} from "./intakeRuns.js";
import type { RunPubSub } from "./runPubSub.js";
import { DuplicateRunIdError } from "@autobroker/workflows";

/** The headless start body (task BUILD §5). skill is fixed to the one M1 skill. */
const StartBodySchema = z.object({
  skill: z.literal("search_profile_intake"),
  input_mode: z.enum(["slash", "freeform"]),
  freeform_text: z.string().nullable().optional(),
  seed_fields: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** A typed route error mapped to the §13.2 envelope by the server's handler. */
export class RouteError extends Error {
  readonly code: string;
  readonly status: number;
  readonly field?: string;
  readonly extra?: Record<string, unknown>;
  constructor(
    code: string,
    status: number,
    message: string,
    opts: { field?: string; extra?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "RouteError";
    this.code = code;
    this.status = status;
    if (opts.field !== undefined) this.field = opts.field;
    if (opts.extra !== undefined) this.extra = opts.extra;
  }
}

/** Dependencies the route module needs (the server wires these). */
export interface RouteDeps {
  intake: IntakeRunService;
  pubsub: RunPubSub;
}

/** The static skill manifest (§3.4) — projected from the one registered skill. */
const SKILL_MANIFEST = {
  name: INTAKE_SKILL,
  version: "m1-v1",
  summary: "Create a new-car search profile from a slash form or freeform prose.",
  inputs: ["input_mode", "freeform_text", "seed_fields"],
  outputs: "search_profile",
  sensitive: false,
  retries: 0,
} as const;

/** Parse a body with a Zod schema, throwing a 400 content_invalid RouteError with
 *  a JSON-pointer field on failure (the unified §13.2 shape). */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RouteError("content_invalid", 400, "request body invalid", {
      ...(issue ? { field: `/${issue.path.join("/")}` } : {}),
      extra: { issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

/** Open a tools DB handle, run fn, always close. Profile READS only (the only
 *  write path is the workflow persist step). */
function withDb<T>(fn: (db: Db) => T): T {
  const db = openDb();
  try {
    return fn(db);
  } finally {
    db.$client.close();
  }
}

/** Read one profile row by id as the snake_case SearchProfileView (§3.3). Returns
 *  null when absent. Goes through openDb (tools); raw better-sqlite3 select. */
function readProfileRow(db: Db, id: string): Record<string, unknown> | null {
  const row = db.$client
    .prepare("SELECT * FROM search_profiles WHERE search_profile_id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ?? null;
}

/** List profile rows (snake_case views), newest-first by ROWID (§3.3 / resolver
 *  ROWID DESC ruling). status filter: active|deleted|all (default excludes none at
 *  M1 — there is no soft-delete column yet; we return all and let the UI count). */
function listProfileRows(db: Db, status: string | undefined): Record<string, unknown>[] {
  // M1 has no `deleted` lifecycle column; the status query param is accepted for
  // forward-compat but only 'active' meaningfully filters (status='active' OR
  // NULL = v1-implicit-active, per the resolver). Default = all rows.
  let sql = "SELECT * FROM search_profiles";
  if (status === "active") {
    sql += " WHERE status = 'active' OR status IS NULL";
  }
  sql += " ORDER BY rowid DESC";
  return db.$client.prepare(sql).all() as Record<string, unknown>[];
}

/**
 * Register all M1 routes on the Fastify instance under /api.
 */
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { intake, pubsub } = deps;

  // ---- POST /api/skill-runs — start intake (headless) ----------------------
  app.post("/api/skill-runs", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(StartBodySchema, req.body);
    const input: IntakeStartInput = {
      input_mode: body.input_mode,
      freeform_text: body.freeform_text ?? null,
      seed_fields: body.seed_fields ?? null,
    };
    try {
      const { runId } = await intake.start({ input });
      reply.code(201);
      return { run_id: runId };
    } catch (err) {
      if (err instanceof DuplicateRunIdError) {
        throw new RouteError("duplicate_run_id", 409, err.message, {
          extra: { run_id: err.runId },
        });
      }
      throw err;
    }
  });

  // ---- GET /api/skill-runs/:id — status projection + pending suspend --------
  app.get("/api/skill-runs/:id", async (req: FastifyRequest, _reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const summary = await intake.statusSummary(id);
    if (summary === null) {
      throw new RouteError("no_skill_run", 404, `no skill run ${id}`);
    }
    return summary;
  });

  // ---- GET /api/skill-runs/:id/stream — SSE (replay + live) -----------------
  app.get("/api/skill-runs/:id/stream", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const sub = pubsub.subscribe(id);
    if (sub === null) {
      // 404 when the run is unknown to the pubsub (not live, §3.2).
      throw new RouteError("no_skill_run", 404, `no skill run ${id}`);
    }

    // Take over the socket: write SSE frames by hand (Fastify v5 requires
    // reply.hijack() before raw writes — reply.sent is forbidden).
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const writeFrame = (ev: { ts: string; kind: string; payload: unknown }): void => {
      // §4.1: data: <compact-json>\n\n — NO event: named line.
      raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    };

    // Replay the ordered backlog (§4.3), then live frames from the queue.
    for (const ev of sub.snapshot) writeFrame(ev);

    if (sub.isTerminal || sub.queue === null) {
      // Already terminal: snapshot included the terminal frame → close.
      raw.end();
      return;
    }

    // Heartbeat comment every ~15s (a `: ` comment line keeps proxies from idling
    // the connection; consumers ignore comment frames).
    const heartbeat = setInterval(() => {
      raw.write(": heartbeat\n\n");
    }, 15000);
    heartbeat.unref?.();

    const queue = sub.queue;
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      pubsub.unsubscribe(id, queue);
    };
    raw.on("close", cleanup);

    try {
      for await (const ev of queue) {
        writeFrame(ev);
      }
    } finally {
      cleanup();
      raw.end();
    }
  });

  // ---- POST /api/skill-runs/:id/form-decision — three-phase claim ----------
  app.post(
    "/api/skill-runs/:id/form-decision",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(FormDecisionBodySchema, req.body);
      try {
        const ack = await intake.formDecision(id, body);
        reply.code(200);
        return ack;
      } catch (err) {
        if (err instanceof UnknownRunError) {
          throw new RouteError("no_skill_run", 404, err.message);
        }
        if (err instanceof FormDecisionError) {
          throw new RouteError(err.code, err.status, err.message, {
            ...(err.field !== undefined ? { field: err.field } : {}),
            ...(err.extra !== undefined ? { extra: err.extra } : {}),
          });
        }
        throw err;
      }
    },
  );

  // ---- GET /api/profiles — list (intake target collection) -----------------
  app.get("/api/profiles", async (req: FastifyRequest, _reply: FastifyReply) => {
    const { status } = (req.query ?? {}) as { status?: string };
    return withDb((db) => listProfileRows(db, status));
  });

  // ---- GET /api/profiles/:id — read one (confirm read-back) ----------------
  app.get("/api/profiles/:id", async (req: FastifyRequest, _reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const row = withDb((db) => readProfileRow(db, id));
    if (row === null) {
      throw new RouteError("not_found", 404, `profile ${id} not found`);
    }
    return row;
  });

  // ---- GET /api/skills — static manifest (§3.4) ----------------------------
  app.get("/api/skills", async () => {
    return [SKILL_MANIFEST];
  });

  // ---- GET /api/mode — harness preflight {active_db, data_dir} -------------
  app.get("/api/mode", async () => {
    // The active product DB path = AUTOBROKER_DB override or <dataDir>/autobroker.db.
    const dataDir = resolveDataDir();
    const activeDb = process.env.AUTOBROKER_DB ?? `${dataDir}/autobroker.db`;
    return { active_db: activeDb, data_dir: dataDir };
  });
}
