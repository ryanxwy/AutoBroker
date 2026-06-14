/**
 * routes — the Fastify route table. All routes under /api, bound 127.0.0.1 by
 * the server. Request bodies validated with Zod (manual parse, NOT Fastify
 * JSON-schema — keeps zod v4 as the single validator and the error-envelope
 * shapes exact). The error envelope is centralized in the server's
 * setErrorHandler; handlers throw typed errors.
 *
 * Skill-run surface: start a run (per-skill RunDescriptor registry — unknown
 * skill → 400 unknown_skill), status, SSE stream, form-decision (three-phase
 * claim), profiles read, skills manifest, mode. The headless start uses POST
 * /api/skill-runs directly (rather than routing through the rail via POST
 * /sessions/{id}/turns).
 *
 * Sessions surface (sessions-as-thread projection): sessions CRUD (POST/GET/
 * GET:id/PATCH/DELETE), the PATCH pin null-vs-omitted semantic, list-by-pin
 * (?pinned_profile_id) for the 0/1/2+ counts, and the intake fork wired onto
 * POST /api/skill-runs (from_session_id forks a fresh unpinned session + carries
 * an IntakeScopeNotice when the source was pinned). Sessions are Mastra Memory
 * threads behind the SessionService → workflows RailSessionStore facade; this
 * route layer owns the wire-case projection only.
 *
 * WIRE CASE CONTRACT: request fields camelCase where the route table says so;
 * the headless start body is snake_case (input_mode, freeform_text, seed_fields)
 * matching the workflow input — kept verbatim. Response profile views are
 * snake_case (SearchProfileView mirrors the DB column case).
 *
 * Dependency wall: app layer. Imports core (schemas), tools (DB reads via getDb +
 * resolveDataDir + the resolver) — NEVER @mastra, NEVER drizzle/better-sqlite3
 * directly (getDb is the tools closure). Profile reads go through the tools
 * read views; profile CREATION stays inside the workflow's persist step. The
 * route-level writes are PATCH /api/profiles/:id (preference update — identity
 * fields rejected there), DELETE /api/profiles/:id (soft-delete via the tools
 * close(): audited status→'closed', frees the active slot, in-flight guard), and
 * POST /api/profiles/:id/restore (audited status→'active', the active (account,
 * brand) slot must be free).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  getDb,
  resolveDataDir,
  readProfileRow,
  listProfileRows,
  listProfileDealerRows,
  update as updateProfile,
  close as closeProfile,
  restore as restoreProfile,
  getKeyPresence,
  setKey,
  clearKey,
  testKey,
  SECRET_KEY_IDS,
  getEnvConfig,
  setEnvConfig,
  InvalidEnvValueError,
  NonEditableEnvVarError,
  UnknownEnvVarError,
  IdentityLockedError,
  ActiveSlotConflict,
  type Db,
} from "@autobroker/tools";
import type { SearchProfile } from "@autobroker/core";

import { IMPLEMENTED_SKILLS } from "@autobroker/skills";

import {
  SkillRunService,
  FormDecisionBodySchema,
  FormDecisionError,
  UnknownRunError,
} from "./skillRuns.js";
import type { RunPubSub } from "./runPubSub.js";
import {
  STREAM_V2_DONE,
  STREAM_V2_HEADERS,
  UiStreamTranslator,
  chunkFrame,
} from "./streamV2.js";
import { DuplicateRunIdError } from "@autobroker/workflows";
import type { SessionService, IntakeScopeNotice } from "./sessions.js";

/** The headless start ENVELOPE: the skill id + the session linkage. The
 *  per-skill input fields (e.g. intake's input_mode/freeform_text/seed_fields)
 *  ride the same body and are validated by the skill's RunDescriptor.buildInput.
 *  An optional `session_id` links the run to a rail session (thread). When the
 *  run is started from a PINNED session, the caller passes the SOURCE session id
 *  as `from_session_id` so the route forks a fresh unpinned session and the run
 *  links to the FORK, not the source. */
const StartBodySchema = z.object({
  skill: z.string().min(1),
  /** Link the run directly to an existing session (run↔session association). */
  session_id: z.string().nullable().optional(),
  /** The session intake was TRIGGERED from (slash/freeform). When pinned, the
   *  route forks a fresh unpinned session and carries an IntakeScopeNotice. */
  from_session_id: z.string().nullable().optional(),
});

/** POST /api/sessions body (camelCase). */
const CreateSessionBodySchema = z
  .object({
    title: z.string().nullable().optional(),
    pinnedProfileId: z.string().nullable().optional(),
  })
  .strict();

/** PATCH /api/sessions/:id body (camelCase). The null-vs-omitted semantic is
 *  preserved by reading the parsed object's OWN-key presence below — Zod
 *  `.optional()` keeps an omitted key absent vs an explicit null. */
const PatchSessionBodySchema = z
  .object({
    title: z.string().nullable().optional(),
    pinnedProfileId: z.string().nullable().optional(),
  })
  .strict();

/** PATCH /api/profiles/:id body (camelCase core field names, mirroring the
 *  tools update() patch shape). Only the PREFERENCE fields are writable; the
 *  radius carries its own 1–500 mile bound HERE because update() is a bare
 *  column write with no schema of its own. The five identity fields are
 *  accepted by the schema so they reach update(), which rejects them with the
 *  typed identity_locked error (confirm freezes identity → 409, not 400). */
const PatchProfileBodySchema = z
  .object({
    budgetMax: z.number().nullable().optional(),
    searchRadiusMiles: z.number().int().min(1).max(500).nullable().optional(),
    followUpEmail: z.string().nullable().optional(),
    followUpPhone: z.string().nullable().optional(),
    financingPreference: z.string().nullable().optional(),
    tradeInDescription: z.string().nullable().optional(),
    preferredExteriorColorsJson: z.string().nullable().optional(),
    preferredInteriorColorsJson: z.string().nullable().optional(),
    acceptableTrimsJson: z.string().nullable().optional(),
    featurePreferencesJson: z.string().nullable().optional(),
    // Identity fields — pass through so the service rejects them as 409.
    year: z.unknown().optional(),
    make: z.unknown().optional(),
    model: z.unknown().optional(),
    trim: z.unknown().optional(),
    location: z.unknown().optional(),
  })
  .strict();

/** A typed route error mapped to the error envelope by the server's handler. */
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

/** POST /api/settings/keys — store a key. `id` must be one of the four; `value`
 *  is the secret (never echoed back). */
const SaveKeyBodySchema = z.object({
  id: z.enum(SECRET_KEY_IDS as unknown as [string, ...string[]]),
  value: z.string().min(1),
});

/** POST /api/settings/keys/:id/test — body carries the CANDIDATE value to probe
 *  (the id rides the path). */
const TestKeyBodySchema = z.object({
  value: z.string().min(1),
});

/** PUT /api/settings/env — set ONE editable operational env var. The id enum IS
 *  the route-layer allow-list: only the two editable ids are accepted, so the
 *  read-only fuse / paths / demo-status ids fail the schema with a 400 before the
 *  store is ever called (the L1 fuse var is structurally unreachable here). The
 *  store re-checks editable + allowedValues as defense-in-depth. */
const SetEnvBodySchema = z.object({
  id: z.enum(["gmail_backend", "chrome_headless"]),
  value: z.string().min(1),
});

/** Dependencies the route module needs (the server wires these). */
export interface RouteDeps {
  skillRuns: SkillRunService;
  pubsub: RunPubSub;
  sessions: SessionService;
}

/** Map a service-layer FormDecisionError onto the route error envelope. */
function fromFormDecisionError(err: FormDecisionError): RouteError {
  return new RouteError(err.code, err.status, err.message, {
    ...(err.field !== undefined ? { field: err.field } : {}),
    ...(err.extra !== undefined ? { extra: err.extra } : {}),
  });
}

/** The skill manifest list — projected from the implemented registry entries.
 *  name/summary/inputs/outputs come from @autobroker/skills; sensitive means
 *  external/destructive mutation (irreversible | destructive) — local product-row
 *  writes behind their own confirmation (intake, the scan skills) are NOT
 *  sensitive; version/retries are this API's manifest metadata. The wire shape
 *  is unchanged. */
const SKILL_MANIFEST = IMPLEMENTED_SKILLS.map((s) => ({
  name: s.id,
  version: "m1-v1",
  summary: s.summary,
  inputs: s.inputs,
  outputs: s.outputs,
  sensitive: s.riskClass === "irreversible" || s.riskClass === "destructive",
  retries: 0,
}));

/** Parse a body with a Zod schema, throwing a 400 content_invalid RouteError with
 *  a JSON-pointer field on failure (the unified error-envelope shape). */
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

/** Run fn against the SHARED tools DB connection (getDb — one cached handle
 *  per resolved data dir, not a fresh connection per request). Reads plus the
 *  one delegated write (the tools-layer preference update) — profile CREATION
 *  stays inside the workflow persist step. */
function withDb<T>(fn: (db: Db) => T): T {
  return fn(getDb());
}

/**
 * Belt-and-suspenders for the legacy /stream writer: the legacy route never
 * carries a screenshot. Screenshot frames are fan-out-only (never logged), but
 * the live queue feeds this route too — FILTER the field rather than assume
 * the upstream discipline holds. Pure + exported so the filter is pinned by a
 * unit test.
 */
export function stripScreenshotField(ev: { ts: string; kind: string; payload: unknown }): {
  ts: string;
  kind: string;
  payload: unknown;
} {
  if (
    ev.payload !== null &&
    typeof ev.payload === "object" &&
    "screenshot_b64" in (ev.payload as Record<string, unknown>)
  ) {
    const { screenshot_b64: _omit, ...rest } = ev.payload as Record<string, unknown>;
    return { ...ev, payload: rest };
  }
  return ev;
}

/**
 * Register all routes on the Fastify instance under /api.
 */
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { skillRuns, pubsub, sessions } = deps;

  // ---- POST /api/skill-runs — start a skill run (headless or rail-linked) ---
  app.post("/api/skill-runs", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(StartBodySchema, req.body);

    // Per-skill registry lookup: an unknown skill id is a typed 400.
    const descriptor = skillRuns.descriptorFor(body.skill);
    if (descriptor === undefined) {
      throw new RouteError("unknown_skill", 400, `unknown skill '${body.skill}'`);
    }

    // Validate + shape the per-skill input BEFORE the session fork below, so a
    // bad body leaves no stray forked session behind.
    let input: unknown;
    try {
      input = descriptor.buildInput(req.body as Record<string, unknown>);
    } catch (err) {
      if (err instanceof FormDecisionError) throw fromFormDecisionError(err);
      throw err;
    }

    // INTAKE FORK (intake-from-pinned fork rule): intake never inherits/sets a
    // pin. When the caller passes a `from_session_id` (the session intake was
    // triggered from), fork a FRESH UNPINNED session; if the source was pinned,
    // carry a non-skippable IntakeScopeNotice. The run links to the FORK. When the
    // caller passes an explicit `session_id` (already-unpinned rail) we link to it
    // directly (no fork). Headless (neither) → no session link.
    let sessionId: string | null = body.session_id ?? null;
    let scopeNotice: IntakeScopeNotice | null = null;
    if (body.from_session_id !== undefined) {
      const fork = await sessions.forkForIntake(body.from_session_id);
      sessionId = fork.sessionId;
      scopeNotice = fork.scopeNotice;
    }

    try {
      const { runId } = await skillRuns.start({ skill: body.skill, input, sessionId });
      // Durable run↔session link (thread metadata): the Searches popover's
      // per-session terminal pill and post-restart re-entry both read it. The
      // run IS already started — a failed metadata write is voiced, never a
      // failed ack (the client would otherwise retry into a duplicate run).
      if (sessionId !== null) {
        try {
          await sessions.recordRun(sessionId, runId);
        } catch (err) {
          console.warn(
            `routes: failed to record run ${runId} on session ${sessionId}: ${String(err)}`,
          );
        }
      }
      reply.code(201);
      // The IntakeScopeNotice rides the start response so the rail can render it
      // as the forked session's first system part (non-skippable). null when the
      // fork came from an unpinned/absent source (nothing to confuse).
      return { run_id: runId, session_id: sessionId, scope_notice: scopeNotice };
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
    const summary = await skillRuns.statusSummary(id);
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
      // 404 when the run is unknown to the pubsub (not live).
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
      // SSE frame: data: <compact-json>\n\n — NO event: named line. The
      // screenshot filter keeps the legacy route base64-free (see
      // stripScreenshotField).
      raw.write(`data: ${JSON.stringify(stripScreenshotField(ev))}\n\n`);
    };

    // Replay the ordered backlog, then live frames from the queue.
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

  // ---- GET /api/skill-runs/:id/stream-v2 — AI SDK UI-message-stream --------
  // The dashboard rail's stream: the SAME pubsub channel as the legacy /stream
  // above (which remains live for the harness/API-lane readers), translated
  // onto the UI-message-stream protocol (UiStreamTranslator owns the
  // frame→chunk mapping).
  app.get(
    "/api/skill-runs/:id/stream-v2",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const sub = pubsub.subscribe(id);
      if (sub === null) {
        throw new RouteError("no_skill_run", 404, `no skill run ${id}`);
      }

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, STREAM_V2_HEADERS);

      const translator = new UiStreamTranslator();
      const writeChunks = (frames: ReturnType<UiStreamTranslator["translate"]>): void => {
        for (const chunk of frames) raw.write(chunkFrame(chunk));
      };

      // start{messageId: runId} first, then the replayed backlog.
      writeChunks(translator.start(id));
      for (const ev of sub.snapshot) writeChunks(translator.translate(ev));

      if (sub.isTerminal || sub.queue === null) {
        raw.write(`data: ${STREAM_V2_DONE}\n\n`);
        raw.end();
        return;
      }

      // Heartbeat comment every ~15s (consumers ignore comment frames).
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
          writeChunks(translator.translate(ev));
        }
      } finally {
        cleanup();
        // The terminator is part of the protocol — only a TERMINAL close gets
        // it (a client disconnect mid-run just drops the socket).
        if (pubsub.isTerminal(id)) raw.write(`data: ${STREAM_V2_DONE}\n\n`);
        raw.end();
      }
    },
  );

  // ---- POST /api/skill-runs/:id/form-decision — three-phase claim ----------
  app.post(
    "/api/skill-runs/:id/form-decision",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const body = parseBody(FormDecisionBodySchema, req.body);
      try {
        const ack = await skillRuns.formDecision(id, body);
        reply.code(200);
        return ack;
      } catch (err) {
        if (err instanceof UnknownRunError) {
          throw new RouteError("no_skill_run", 404, err.message);
        }
        if (err instanceof FormDecisionError) {
          throw fromFormDecisionError(err);
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

  // ---- GET /api/profiles/:id/dealers — read-only dealer projection ---------
  app.get("/api/profiles/:id/dealers", async (req: FastifyRequest, _reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const profile = withDb((db) => readProfileRow(db, id));
    if (profile === null) {
      throw new RouteError("not_found", 404, `profile ${id} not found`);
    }
    return withDb((db) => listProfileDealerRows(db, id));
  });

  // ---- PATCH /api/profiles/:id — preference write-through ------------------
  // Delegates to the tools-layer update(); identity fields are frozen at
  // confirm, so an identity key in the patch maps to 409 identity_locked.
  app.patch("/api/profiles/:id", async (req: FastifyRequest, _reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(PatchProfileBodySchema, req.body);
    const existing = withDb((db) => readProfileRow(db, id));
    if (existing === null) {
      throw new RouteError("not_found", 404, `profile ${id} not found`);
    }
    try {
      withDb((db) => updateProfile(db, body as Partial<SearchProfile>, { profileId: id }));
    } catch (err) {
      if (err instanceof IdentityLockedError) {
        throw new RouteError(err.code, 409, err.message, {
          extra: { locked_fields: err.lockedFields },
        });
      }
      throw err;
    }
    // Respond with the snake_case row view, same shape as GET /api/profiles/:id.
    return withDb((db) => readProfileRow(db, id));
  });

  // ---- DELETE /api/profiles/:id — SOFT-DELETE (status → 'closed') ----------
  // Delegates to the tools-layer close(), which writes the audited status flip
  // (action 'profile_close') and frees the active (account, brand) slot. The
  // data is KEPT — restore brings it back.
  app.delete("/api/profiles/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const closed = withDb((db) => closeProfile(db, id, { actor: "dashboard" }));
    if (!closed) {
      throw new RouteError("not_found", 404, `profile ${id} not found`);
    }
    reply.code(204);
    return null;
  });

  // ---- POST /api/profiles/:id/restore — bring a closed profile back active --
  // Delegates to the tools-layer restore() (audited, action 'profile_restore').
  // The active (account, brand) slot must be free; a taken slot maps to 409
  // active_slot_conflict carrying the conflicting brand/account so the UI can
  // say "you already have an active <brand> search".
  app.post("/api/profiles/:id/restore", async (req: FastifyRequest, _reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const existing = withDb((db) => readProfileRow(db, id));
    if (existing === null) {
      throw new RouteError("not_found", 404, `profile ${id} not found`);
    }
    try {
      withDb((db) => restoreProfile(db, id, { actor: "dashboard" }));
    } catch (err) {
      if (err instanceof ActiveSlotConflict) {
        throw new RouteError(err.code, 409, err.message, {
          extra: { brand: err.brand, account: err.account, existing_profile_id: err.existingProfileId },
        });
      }
      throw err;
    }
    // Respond with the now-active snake_case row view.
    return withDb((db) => readProfileRow(db, id));
  });

  // ---- GET /api/skills — manifest of implemented skills --------------------
  app.get("/api/skills", async () => {
    return SKILL_MANIFEST;
  });

  // ---- GET /api/mode — harness preflight {active_db, data_dir, demo} -------
  app.get("/api/mode", async () => {
    // The active product DB path = AUTOBROKER_DB override or <dataDir>/autobroker.db.
    const dataDir = resolveDataDir();
    const activeDb = process.env.AUTOBROKER_DB ?? `${dataDir}/autobroker.db`;
    // demo = the zero-config sample-world mode. True when the launcher armed the
    // demo seed, OR the resolved data dir is an isolated demo path (a belt for a
    // demo dir entered any other way). The UI renders the persistent demo banner
    // off this flag.
    const demo =
      process.env.AUTOBROKER_DEMO_SEED === "1" || /(^|\/)demo\/?$/.test(dataDir);
    return { active_db: activeDb, data_dir: dataDir, demo };
  });

  // ========================================================================
  // settings/keys — the four user-supplied API keys. The route layer NEVER
  // reads/writes the keys file or holds a secret; it delegates to the tools
  // secretsStore/probe. A key VALUE is never returned on any of these.
  // ========================================================================

  // ---- GET /api/settings/keys — presence only (never a value) --------------
  app.get("/api/settings/keys", async () => {
    // gmail is a placeholder (the OAuth connect wiring lands separately); report
    // it not-connected so the UI can render the slot without a real signal yet.
    return { ...getKeyPresence(), gmail: { connected: false } };
  });

  // ---- POST /api/settings/keys — store a key (live env mutation in tools) --
  app.post("/api/settings/keys", async (req: FastifyRequest, _reply: FastifyReply) => {
    const body = parseBody(SaveKeyBodySchema, req.body);
    setKey(body.id, body.value);
    return { ok: true };
  });

  // ---- DELETE /api/settings/keys/:id — clear a key -------------------------
  app.delete("/api/settings/keys/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (!(SECRET_KEY_IDS as readonly string[]).includes(id)) {
      throw new RouteError("unknown_key", 400, `unknown secret key id '${id}'`);
    }
    clearKey(id);
    reply.code(204);
    return null;
  });

  // ---- POST /api/settings/keys/:id/test — probe a candidate before saving --
  app.post("/api/settings/keys/:id/test", async (req: FastifyRequest, _reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (!(SECRET_KEY_IDS as readonly string[]).includes(id)) {
      throw new RouteError("unknown_key", 400, `unknown secret key id '${id}'`);
    }
    const body = parseBody(TestKeyBodySchema, req.body);
    // A failed probe is still a 200 carrying the result {ok:false, detail} — the
    // probe RESULT is not an HTTP error; non-2xx is reserved for a malformed
    // request (unknown id / missing value, handled above + by the schema).
    return testKey(id, body.value);
  });

  // ========================================================================
  // settings/env — the curated NON-SECRET operational env vars. The route layer
  // NEVER reads/writes the env file; it delegates to the tools envConfigStore.
  // The L1 safety fuse (AUTOBROKER_BLOCK_EXTERNAL_MUTATIONS) appears here ONLY as
  // a read-only status row — no route, method, or body can write it (the PUT id
  // enum rejects its id, and the store refuses any non-editable id).
  // ========================================================================

  // ---- GET /api/settings/env — curated vars with live values ---------------
  app.get("/api/settings/env", async () => {
    return { vars: getEnvConfig() };
  });

  // ---- PUT /api/settings/env — set one editable var (live env mutation) -----
  app.put("/api/settings/env", async (req: FastifyRequest, _reply: FastifyReply) => {
    const body = parseBody(SetEnvBodySchema, req.body);
    try {
      setEnvConfig(body.id, body.value);
    } catch (err) {
      if (err instanceof InvalidEnvValueError) {
        throw new RouteError("invalid_value", 400, err.message, { field: "/value" });
      }
      if (err instanceof NonEditableEnvVarError || err instanceof UnknownEnvVarError) {
        throw new RouteError("unknown_env_var", 400, err.message, { field: "/id" });
      }
      throw err;
    }
    // Echo fresh state so the UI re-renders without a second GET.
    return { ok: true, vars: getEnvConfig() };
  });

  // ========================================================================
  // sessions (chat-rail = Mastra Memory threads).
  // Request bodies camelCase; response bodies snake_case (SessionResponse).
  // ========================================================================

  // ---- POST /api/sessions — create a thread (optional pin) -----------------
  app.post("/api/sessions", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(CreateSessionBodySchema, req.body);
    const created = await sessions.create({
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.pinnedProfileId !== undefined ? { pinnedProfileId: body.pinnedProfileId } : {}),
    });
    reply.code(201);
    return created;
  });

  // ---- GET /api/sessions — list (newest-first; ?pinned_profile_id filter) --
  app.get("/api/sessions", async (req: FastifyRequest, _reply: FastifyReply) => {
    const { pinned_profile_id } = (req.query ?? {}) as { pinned_profile_id?: string };
    return sessions.list(
      pinned_profile_id !== undefined ? { pinnedProfileId: pinned_profile_id } : undefined,
    );
  });

  // ---- GET /api/sessions/:id — read one ------------------------------------
  app.get("/api/sessions/:id", async (req: FastifyRequest, _reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const session = await sessions.get(id);
    if (session === null) {
      throw new RouteError("not_found", 404, `session ${id} not found`);
    }
    return session;
  });

  // ---- PATCH /api/sessions/:id — pin/title (null-vs-omitted) ---------------
  app.patch("/api/sessions/:id", async (req: FastifyRequest, _reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const body = parseBody(PatchSessionBodySchema, req.body);
    // null-vs-omitted: read OWN-key presence on the parsed object. Zod
    // `.optional()` keeps an omitted key ABSENT (not present-undefined), so
    // `"pinnedProfileId" in body` distinguishes "field sent (maybe null → clear)"
    // from "field omitted (leave as-is)". A present null/"" clears the pin.
    const changes: { title?: { value: string | null }; pin?: { value: string | null } } = {};
    if ("title" in body) changes.title = { value: body.title ?? null };
    if ("pinnedProfileId" in body) changes.pin = { value: body.pinnedProfileId ?? null };
    const updated = await sessions.patch(id, changes);
    if (updated === null) {
      throw new RouteError("not_found", 404, `session ${id} not found`);
    }
    return updated;
  });

  // ---- DELETE /api/sessions/:id — remove the thread ------------------------
  app.delete("/api/sessions/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const existing = await sessions.get(id);
    if (existing === null) {
      throw new RouteError("not_found", 404, `session ${id} not found`);
    }
    await sessions.delete(id);
    reply.code(204);
    return null;
  });
}
