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
 *   DELETE /api/profiles/:id                 closeProfile (soft-delete → 'closed')
 *   POST /api/profiles/:id/restore           restoreProfile ('closed' → 'active')
 *   GET  /api/skills                         listSkills
 *   GET  /api/mode                           getMode
 *   GET  /api/digest[?profile_id]            getDigest
 *   POST /api/sessions                       createSession
 *   GET  /api/sessions[?pinned_profile_id]   listSessions
 *   GET  /api/sessions/:id                   getSession (pin + scope_notice in ONE fetch)
 *   PATCH /api/sessions/:id                  patchSession (pin null-vs-omitted)
 *   GET  /api/settings/env                  getEnvConfig ({ vars: EnvVarState[] })
 *   PUT  /api/settings/env {id,value}        setEnvConfig (set ONE editable var)
 *
 * Dependency wall: app/ui layer. Imports the wire schemas + zod only.
 */

import { z } from "zod";

import {
  ApprovalListSchema,
  DealerListSchema,
  DigestViewSchema,
  EnvConfigResponseSchema,
  ErrorEnvelopeSchema,
  FormDecisionAckSchema,
  KeyPresenceResponseSchema,
  KeyProbeResultSchema,
  InventoryCompareResultSchema,
  QuoteCompareResultSchema,
  QuoteListSchema,
  IncentiveListSchema,
  ModeSchema,
  PortfolioViewSchema,
  ProfileListSchema,
  ProfileRowSchema,
  PurgeProfileAckSchema,
  RouteAckSchema,
  SaveKeyAckSchema,
  SessionListSchema,
  SessionResponseSchema,
  SetEnvAckSchema,
  SkillListSchema,
  SkillRunSummarySchema,
  StartAckSchema,
  ThreadListSchema,
  type ApprovalList,
  type CreateSessionBody,
  type DealerList,
  type DigestView,
  type PortfolioView,
  type ThreadList,
  type EnvConfigResponse,
  type EnvEditableId,
  type FormDecisionAck,
  type FormDecisionBody,
  type InventoryCompareResult,
  type QuoteCompareResult,
  type QuoteList,
  type IncentiveList,
  type KeyPresenceResponse,
  type KeyProbeResult,
  type Mode,
  type PatchProfileBody,
  type PatchSessionBody,
  type ProfileList,
  type ProfileRow,
  type PurgeProfileAck,
  type RouteAck,
  type RouteRequestBody,
  type SecretKeyId,
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

  /** POST /api/route → the NL skill-router verdict (routes.ts). The LLM reads the
   *  free-form chat message and either LAUNCHES a skill (201, run_id + routing
   *  launch — the EXACT existing start path; every gate stays downstream) or
   *  returns a CLARIFY (200, routing only, NO run). The App dispatches on
   *  `routing.kind`: launch → bindAck+streamRun (today's path); clarify → a local
   *  assistant clarify turn. */
  async route(body: RouteRequestBody): Promise<RouteAck> {
    const res = await this.fetchImpl(this.url("/api/route"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return decode(res, RouteAckSchema);
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

  /** GET /api/profiles?status=… → snake_case rows, newest-first (routes.ts:262).
   *  "active" = status='active' OR NULL; "closed" = the soft-deleted set the
   *  Closed-searches group restores from; "all" = every row. */
  async listProfiles(status?: "active" | "closed" | "all"): Promise<ProfileList> {
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

  /** DELETE /api/profiles/:id → 204 (soft-delete; status→'closed', the active
   *  slot frees). A missing profile → 404 not_found. Resolves void on success. */
  async closeProfile(id: string): Promise<void> {
    const res = await this.fetchImpl(this.url(`/api/profiles/${encodeURIComponent(id)}`), {
      method: "DELETE",
    });
    if (!res.ok) {
      throw apiErrorFrom(res.status, parseJson(await res.text()));
    }
  }

  /** POST /api/profiles/:id/restore → the now-active snake_case row. A taken
   *  active (account, brand) slot → 409 active_slot_conflict (envelope carries
   *  the conflicting brand); a missing profile → 404 not_found. */
  async restoreProfile(id: string): Promise<ProfileRow> {
    const res = await this.fetchImpl(
      this.url(`/api/profiles/${encodeURIComponent(id)}/restore`),
      { method: "POST" },
    );
    return decode(res, ProfileRowSchema);
  }

  /** POST /api/profiles/:id/purge → { ok, counts } — the IRREVERSIBLE hard-delete
   *  (erases every local row scoped to the profile; not restorable, unlike
   *  closeProfile). A missing profile → 404 not_found. The dashboard guards this
   *  behind an explicit confirm modal. */
  async purgeProfile(id: string): Promise<PurgeProfileAck> {
    const res = await this.fetchImpl(
      this.url(`/api/profiles/${encodeURIComponent(id)}/purge`),
      { method: "POST" },
    );
    return decode(res, PurgeProfileAckSchema);
  }

  /** GET /api/profiles/:id/dealers → the dealer rows bound to one profile,
   *  nearest-first (read-only projection; 404 for a missing profile). */
  async listProfileDealers(id: string): Promise<DealerList> {
    const res = await this.fetchImpl(
      this.url(`/api/profiles/${encodeURIComponent(id)}/dealers`),
    );
    return decode(res, DealerListSchema);
  }

  /** GET /api/profiles/:id/threads → the dealer-reply thread rows bound to one
   *  profile, newest-touched first (read-only projection; 404 for a missing
   *  profile). The Threads canvas section renders these. */
  async listProfileThreads(id: string): Promise<ThreadList> {
    const res = await this.fetchImpl(
      this.url(`/api/profiles/${encodeURIComponent(id)}/threads`),
    );
    return decode(res, ThreadListSchema);
  }

  /** GET /api/profiles/:id/inventory-compare → the deterministic ranker payload
   *  (candidates + header tallies) for one profile (read-only; 404 for a missing
   *  profile). The Inventory candidates canvas section renders these — public
   *  inventory listings ranked against the profile, NEVER negotiated quotes. */
  async listProfileInventoryCompare(id: string): Promise<InventoryCompareResult> {
    const res = await this.fetchImpl(
      this.url(`/api/profiles/${encodeURIComponent(id)}/inventory-compare`),
    );
    return decode(res, InventoryCompareResultSchema);
  }

  /** GET /api/profiles/:id/quote-compare → the deterministic compare-ranker
   *  payload (finance + lease buckets, gated by the profile's financing
   *  preference) for one profile (read-only; 404 for a missing profile). The
   *  Quote compare canvas section renders these — negotiated dealer quotes
   *  ranked by OTD, never a budget number. */
  async listProfileQuoteCompare(id: string): Promise<QuoteCompareResult> {
    const res = await this.fetchImpl(
      this.url(`/api/profiles/${encodeURIComponent(id)}/quote-compare`),
    );
    return decode(res, QuoteCompareResultSchema);
  }

  /** GET /api/profiles/:id/quotes → the RAW extracted dealer-quote rows bound to
   *  one profile, newest-received first (read-only projection; 404 for a missing
   *  profile). The Extracted quotes canvas section renders these — every
   *  financing mode (incl. cash), with provenance, never a budget. */
  async listProfileQuotes(id: string): Promise<QuoteList> {
    const res = await this.fetchImpl(
      this.url(`/api/profiles/${encodeURIComponent(id)}/quotes`),
    );
    return decode(res, QuoteListSchema);
  }

  /** GET /api/profiles/:id/incentives → the manufacturer cash-incentive rows
   *  scraped for the profile's vehicle (make/model/zip slice), freshest first
   *  (read-only projection; 404 for a missing profile). The Incentives canvas
   *  section renders these — program type, cash amount, eligibility, expiry and
   *  source provenance, never a budget. */
  async listProfileIncentives(id: string): Promise<IncentiveList> {
    const res = await this.fetchImpl(
      this.url(`/api/profiles/${encodeURIComponent(id)}/incentives`),
    );
    return decode(res, IncentiveListSchema);
  }

  /** URL for GET /api/profiles/:id/quotes/:quoteId/source — the dealer's original
   *  source document bytes (image/* or application/pdf) a quote was read from, or
   *  404. NOT a fetch wrapper: returns the URL so a presentational component can
   *  set it as an <img>/<embed> src or an <a href> (same-origin, works under the
   *  app's serving origin in both browser + Electron via the same base helper). */
  quoteSourceUrl(profileId: string, quoteId: string): string {
    return this.url(
      `/api/profiles/${encodeURIComponent(profileId)}/quotes/${encodeURIComponent(quoteId)}/source`,
    );
  }

  /** GET /api/skills → the registered skill manifest list (routes.ts:278). */
  async listSkills(): Promise<SkillList> {
    const res = await this.fetchImpl(this.url("/api/skills"));
    return decode(res, SkillListSchema);
  }

  /** GET /api/mode → { active_db, data_dir, demo, mode } harness preflight +
   *  the AUTOBROKER_MODE posture the TopBar toggle reflects (routes.ts:943). */
  async getMode(): Promise<Mode> {
    const res = await this.fetchImpl(this.url("/api/mode"));
    return decode(res, ModeSchema);
  }

  /** GET /api/digest[?profile_id=…] → the DigestView projection. A profile id
   *  scopes the digest to a single pinned search (path-param /digest/:id maps to
   *  this query at the router); null/absent yields the all-active digest. The
   *  view is server-computed (OTD-ascending quotes, freshness, best row) — the
   *  page renders it verbatim. */
  async getDigest(profileId?: string | null): Promise<DigestView> {
    const q =
      profileId !== undefined && profileId !== null && profileId !== ""
        ? `?profile_id=${encodeURIComponent(profileId)}`
        : "";
    const res = await this.fetchImpl(this.url(`/api/digest${q}`));
    return decode(res, DigestViewSchema);
  }

  /** GET /api/portfolio → the PortfolioView board projection (one card per
   *  active search, newest-first, with derived stage + hot/warm/cold health).
   *  Seeded from the same digest aggregation + profileHealth; budget never on the
   *  wire. The board groups by segment + computes header counts client-side. */
  async getPortfolio(): Promise<PortfolioView> {
    const res = await this.fetchImpl(this.url("/api/portfolio"));
    return decode(res, PortfolioViewSchema);
  }

  /** GET /api/approvals → every PARKED gate + retraction task across all
   *  pipelines (the global "Needs you" queue, keyed by profileId/runId/
   *  decisionId, ranked action-required first). The widget routes to each item's
   *  run; it never approves inline. */
  async approvalInbox(): Promise<ApprovalList> {
    const res = await this.fetchImpl(this.url("/api/approvals"));
    return decode(res, ApprovalListSchema);
  }

  // ---- settings / keys (the four managed API keys; presence-only reads) -----

  /** GET /api/settings/keys → presence-only map + the Gmail slot (routes.ts:599).
   *  A key VALUE is never returned — only whether each id is configured. */
  async getKeyPresence(): Promise<KeyPresenceResponse> {
    const res = await this.fetchImpl(this.url("/api/settings/keys"));
    return decode(res, KeyPresenceResponseSchema);
  }

  /** POST /api/settings/keys → { ok:true } (routes.ts:606). Stores the key + sets
   *  the live env var so the NEXT model/geocode call sees it (no restart). */
  async saveKey(id: SecretKeyId, value: string): Promise<void> {
    const res = await this.fetchImpl(this.url("/api/settings/keys"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, value }),
    });
    await decode(res, SaveKeyAckSchema);
  }

  /** DELETE /api/settings/keys/:id → 204 (routes.ts:613). Resolves void on
   *  success; an unknown id → 400 unknown_key. */
  async clearKey(id: SecretKeyId): Promise<void> {
    const res = await this.fetchImpl(this.url(`/api/settings/keys/${encodeURIComponent(id)}`), {
      method: "DELETE",
    });
    if (!res.ok) {
      throw apiErrorFrom(res.status, parseJson(await res.text()));
    }
  }

  /** POST /api/settings/keys/:id/test → the probe verdict (routes.ts:624). The
   *  body carries the CANDIDATE value so a key can be tested BEFORE Save. A
   *  failed probe is a normal 200 { ok:false, detail } — not an HTTP error. */
  async testKey(id: SecretKeyId, value: string): Promise<KeyProbeResult> {
    const res = await this.fetchImpl(
      this.url(`/api/settings/keys/${encodeURIComponent(id)}/test`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      },
    );
    return decode(res, KeyProbeResultSchema);
  }

  // ---- settings / environment (curated env vars; read-write the 2 editable) --

  /** GET /api/settings/env → the whole curated set { vars: EnvVarState[] } (the
   *  editable values + the read-only status/path rows). */
  async getEnvConfig(): Promise<EnvConfigResponse> {
    const res = await this.fetchImpl(this.url("/api/settings/env"));
    return decode(res, EnvConfigResponseSchema);
  }

  /** PUT /api/settings/env → { ok:true, vars } on a stored value. Sets ONE
   *  editable var + the live env so the next run sees it (no restart), mirroring
   *  saveKey. The read-only ids (block_external_mutations / paths) are rejected.
   *  The refreshed `vars` echo is decoded (and discarded) — callers refetch. */
  async setEnvConfig(id: EnvEditableId, value: string): Promise<void> {
    const res = await this.fetchImpl(this.url("/api/settings/env"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, value }),
    });
    await decode(res, SetEnvAckSchema);
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
