/**
 * client — the typed fetch client for every route the dashboard calls. Each
 * method hits a real apps/server route (cited file:line), decodes the JSON
 * response with the wire Zod schema (so a server contract drift surfaces as a
 * loud decode error, never a silent any), and on a non-2xx decodes the unified
 * error envelope into a typed ApiError.
 *
 * Routes covered (apps/server/src/routes.ts):
 *   POST /api/skill-runs                     startRun
 *   GET  /api/skill-runs/:id                 runStatus
 *   GET  /api/skill-runs/:id/stream-v2       streamRun (raw SSE Response — the
 *                                            chat transport decodes the chunks)
 *   POST /api/skill-runs/:id/form-decision   formDecision
 *   GET  /api/profiles                       listProfiles
 *   GET  /api/profiles/:id                   getProfile
 *   PATCH /api/profiles/:id                  patchProfile (preference write-through)
 *   GET  /api/skills                         listSkills
 *   GET  /api/mode                           getMode
 *   POST /api/sessions                       createSession
 *   GET  /api/sessions[?pinned_profile_id]   listSessions
 *   GET  /api/sessions/:id                   getSession (pin + scope_notice in ONE fetch)
 *   PATCH /api/sessions/:id                  patchSession (pin null-vs-omitted)
 *
 * Dependency wall: app/ui layer. Imports the wire schemas + zod only.
 */

import { z } from "zod";

import {
  DealerListSchema,
  ErrorEnvelopeSchema,
  FormDecisionAckSchema,
  ModeSchema,
  ProfileListSchema,
  ProfileRowSchema,
  SessionListSchema,
  SessionResponseSchema,
  SkillListSchema,
  SkillRunSummarySchema,
  StartAckSchema,
  type CreateSessionBody,
  type DealerList,
  type FormDecisionAck,
  type FormDecisionBody,
  type Mode,
  type PatchProfileBody,
  type PatchSessionBody,
  type ProfileList,
  type ProfileRow,
  type SessionList,
  type SessionResponse,
  type SkillList,
  type SkillRunSummary,
  type StartAck,
  type StartRunBody,
} from "./wire.js";

/** A typed error carrying the decoded error envelope (server.ts:38-52). When the
 *  body is NOT a valid envelope (e.g. a proxy 502 HTML page), `code` falls back
 *  to `http_<status>` and `envelope` is null. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;
  readonly envelope: Record<string, unknown> | null;
  constructor(
    status: number,
    code: string,
    message: string,
    opts: { field?: string; envelope?: Record<string, unknown> | null } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.field = opts.field;
    this.envelope = opts.envelope ?? null;
  }
}

/** Parse a body as JSON (null on empty/malformed) and build the typed ApiError
 *  for a non-2xx response (envelope-decoded, synthetic code otherwise). */
function apiErrorFrom(status: number, json: unknown): ApiError {
  const parsed = ErrorEnvelopeSchema.safeParse(json);
  if (parsed.success) {
    const e = parsed.data.error;
    return new ApiError(status, e.code, e.message, {
      ...(e.field !== undefined ? { field: e.field } : {}),
      envelope: e,
    });
  }
  // Not our envelope (gateway error, empty body) → synthetic code.
  return new ApiError(status, `http_${status}`, `request failed (${status})`, {
    envelope: null,
  });
}

function parseJson(text: string): unknown {
  try {
    return text.length > 0 ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** Decode a response body with `schema`, throwing a typed ApiError on a non-2xx
 *  (envelope-decoded) or a DecodeError on a 2xx that fails the schema. */
async function decode<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  const text = await res.text();
  const json = parseJson(text);

  if (!res.ok) {
    throw apiErrorFrom(res.status, json);
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(res.status, "decode_error", "response did not match the wire schema", {
      envelope: { issues: parsed.error.issues },
    });
  }
  return parsed.data;
}

/** Options for constructing a client (baseUrl + an injectable fetch for tests). */
export interface ApiClientOptions {
  /** Prefix for every path; default "" (same-origin, the Vite proxy handles /api). */
  baseUrl?: string;
  /** Injectable fetch (tests pass a mock; default = global fetch). */
  fetchImpl?: typeof fetch;
}

/** The typed API client. One instance is shared app-wide. */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ApiClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "";
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /** POST /api/skill-runs → 201 { run_id } (routes.ts:144). Starts an intake run
   *  headlessly; the SSE stream + form-decision drive it from there. */
  async startRun(body: StartRunBody): Promise<StartAck> {
    const res = await this.fetchImpl(this.url("/api/skill-runs"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return decode(res, StartAckSchema);
  }

  /** GET /api/skill-runs/:id → status summary (routes.ts:166 / intakeRuns.ts:547). */
  async runStatus(runId: string): Promise<SkillRunSummary> {
    const res = await this.fetchImpl(this.url(`/api/skill-runs/${encodeURIComponent(runId)}`));
    return decode(res, SkillRunSummarySchema);
  }

  /** GET /api/skill-runs/:id/stream-v2 — the AI SDK UI-message-stream SSE.
   *  Returns the RAW streaming Response (the chat transport decodes it chunk by
   *  chunk); a non-2xx decodes the error envelope into a typed ApiError. */
  async streamRun(runId: string, signal?: AbortSignal): Promise<Response> {
    const res = await this.fetchImpl(
      this.url(`/api/skill-runs/${encodeURIComponent(runId)}/stream-v2`),
      {
        headers: { accept: "text/event-stream" },
        ...(signal !== undefined ? { signal } : {}),
      },
    );
    if (!res.ok) {
      throw apiErrorFrom(res.status, parseJson(await res.text()));
    }
    return res;
  }

  /** POST /api/skill-runs/:id/form-decision → 200 ack (routes.ts:237). The
   *  three-phase idempotent claim is server-side; a same-body retry replays the
   *  same ack (intakeRuns.ts:276-281). */
  async formDecision(runId: string, body: FormDecisionBody): Promise<FormDecisionAck> {
    const res = await this.fetchImpl(
      this.url(`/api/skill-runs/${encodeURIComponent(runId)}/form-decision`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return decode(res, FormDecisionAckSchema);
  }

  /** GET /api/profiles?status=… → snake_case rows, newest-first (routes.ts:262). */
  async listProfiles(status?: "active" | "deleted" | "all"): Promise<ProfileList> {
    const q = status !== undefined ? `?status=${encodeURIComponent(status)}` : "";
    const res = await this.fetchImpl(this.url(`/api/profiles${q}`));
    return decode(res, ProfileListSchema);
  }

  /** GET /api/profiles/:id → one snake_case row, or ApiError 404 (routes.ts:268). */
  async getProfile(id: string): Promise<ProfileRow> {
    const res = await this.fetchImpl(this.url(`/api/profiles/${encodeURIComponent(id)}`));
    return decode(res, ProfileRowSchema);
  }

  /** PATCH /api/profiles/:id → the updated snake_case row (routes.ts:484). Only
   *  the PREFERENCE fields are writable; an identity field maps to 409
   *  identity_locked, a bad value (e.g. radius outside 1–500) to 400
   *  content_invalid with a JSON-pointer `field`. The four color/trim/feature
   *  columns are JSON-encoded STRINGS — the caller serializes string[]→JSON. */
  async patchProfile(id: string, body: PatchProfileBody): Promise<ProfileRow> {
    const res = await this.fetchImpl(this.url(`/api/profiles/${encodeURIComponent(id)}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return decode(res, ProfileRowSchema);
  }

  /** GET /api/profiles/:id/dealers → the dealer rows bound to one profile,
   *  nearest-first (read-only projection; 404 for a missing profile). */
  async listProfileDealers(id: string): Promise<DealerList> {
    const res = await this.fetchImpl(
      this.url(`/api/profiles/${encodeURIComponent(id)}/dealers`),
    );
    return decode(res, DealerListSchema);
  }

  /** GET /api/skills → the registered skill manifest list (routes.ts:278). */
  async listSkills(): Promise<SkillList> {
    const res = await this.fetchImpl(this.url("/api/skills"));
    return decode(res, SkillListSchema);
  }

  /** GET /api/mode → { active_db, data_dir } harness preflight (routes.ts:283). */
  async getMode(): Promise<Mode> {
    const res = await this.fetchImpl(this.url("/api/mode"));
    return decode(res, ModeSchema);
  }

  // ---- sessions (chat-rail = Mastra Memory threads) -------------------------

  /** POST /api/sessions → 201 SessionResponse (camelCase req, snake_case resp). */
  async createSession(body: CreateSessionBody): Promise<SessionResponse> {
    const res = await this.fetchImpl(this.url("/api/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return decode(res, SessionResponseSchema);
  }

  /** GET /api/sessions/:id → SessionResponse. The ONE fetch the rail hydrates
   *  BOTH the pin and the persisted scope notice from. */
  async getSession(id: string): Promise<SessionResponse> {
    const res = await this.fetchImpl(this.url(`/api/sessions/${encodeURIComponent(id)}`));
    return decode(res, SessionResponseSchema);
  }

  /** GET /api/sessions[?pinned_profile_id=…] → newest-first list. */
  async listSessions(pinnedProfileId?: string): Promise<SessionList> {
    const q =
      pinnedProfileId !== undefined
        ? `?pinned_profile_id=${encodeURIComponent(pinnedProfileId)}`
        : "";
    const res = await this.fetchImpl(this.url(`/api/sessions${q}`));
    return decode(res, SessionListSchema);
  }

  /** PATCH /api/sessions/:id → updated SessionResponse. null-vs-omitted is
   *  load-bearing: an omitted pin leaves it as-is; a present null clears it. */
  async patchSession(id: string, body: PatchSessionBody): Promise<SessionResponse> {
    const res = await this.fetchImpl(this.url(`/api/sessions/${encodeURIComponent(id)}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return decode(res, SessionResponseSchema);
  }
}

/** The shared app-wide client (same-origin; the Vite dev proxy forwards /api). */
export const apiClient = new ApiClient();
