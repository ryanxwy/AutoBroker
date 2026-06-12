/**
 * client — the typed fetch client for every route the dashboard calls. Each
 * method hits a real apps/server route (cited file:line), decodes the JSON
 * response with the wire Zod schema (so a server contract drift surfaces as a
 * loud decode error, never a silent any), and on a non-2xx decodes the unified
 * error envelope into a typed ApiError.
 *
 * Routes covered (apps/server/src/routes.ts):
 *   POST /api/skill-runs                     :144  startRun
 *   GET  /api/skill-runs/:id                 :166  runStatus
 *   POST /api/skill-runs/:id/form-decision   :237  formDecision
 *   GET  /api/profiles                       :262  listProfiles
 *   GET  /api/profiles/:id                   :268  getProfile
 *   GET  /api/skills                         :278  listSkills
 *   GET  /api/mode                           :283  getMode
 * The SSE stream (GET /api/skill-runs/:id/stream, :176) is NOT fetched here —
 * it is owned by the single EventSource hook (useRunStream.ts).
 *
 * `/api/sessions` is in the design but the server exposes
 * NO sessions route yet (routes.ts has none) — a sessions client lands with the
 * chat-rail server slice. No stub call here: a
 * method that 404s would lie about the contract.
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
  SkillListSchema,
  SkillRunSummarySchema,
  StartAckSchema,
  type DealerList,
  type FormDecisionAck,
  type FormDecisionBody,
  type Mode,
  type ProfileList,
  type ProfileRow,
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

/** Decode a response body with `schema`, throwing a typed ApiError on a non-2xx
 *  (envelope-decoded) or a DecodeError on a 2xx that fails the schema. */
async function decode<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  const text = await res.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const parsed = ErrorEnvelopeSchema.safeParse(json);
    if (parsed.success) {
      const e = parsed.data.error;
      throw new ApiError(res.status, e.code, e.message, {
        ...(e.field !== undefined ? { field: e.field } : {}),
        envelope: e,
      });
    }
    // Not our envelope (gateway error, empty body) → synthetic code.
    throw new ApiError(res.status, `http_${res.status}`, `request failed (${res.status})`, {
      envelope: null,
    });
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
}

/** The shared app-wide client (same-origin; the Vite dev proxy forwards /api). */
export const apiClient = new ApiClient();
