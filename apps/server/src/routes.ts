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
  listProfileDealerRowsWithVerdicts,
  listProfileThreadRowsWithStatus,
  listProfileDealerNegotiations,
  readDealerNegotiationDetail,
  buildDigestView,
  profileHealth,
  listActiveProfileIds,
  listProfileQuoteRows,
  listProfileIncentiveRows,
  readQuoteSourceDoc,
  rankInventoryForProfile,
  rankQuotesForProfile,
  update as updateProfile,
  close as closeProfile,
  restore as restoreProfile,
  purge as purgeProfile,
  resolveMode,
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
import { parseAgentSelection } from "@autobroker/core";
import type { SearchProfile } from "@autobroker/core";

import { IMPLEMENTED_SKILLS, INTAKE_SKILL_ID, SKILLS } from "@autobroker/skills";

import {
  SkillRunService,
  FormDecisionBodySchema,
  FormDecisionError,
  ProfileRunConflictError,
  UnknownRunError,
} from "./skillRuns.js";
import type { ApprovalInbox } from "./portfolio/approvalInbox.js";
import type { RunPubSub } from "./runPubSub.js";
import {
  STREAM_V2_DONE,
  STREAM_V2_HEADERS,
  UiStreamTranslator,
  chunkFrame,
} from "./streamV2.js";
import {
  DuplicateRunIdError,
  classifySkillFromText,
  clearRunSelection,
  envDefaultSelection,
  getOrGenerateDealerNegotiationSummary,
  setRunSelection,
  suggestNextSkills,
  type RouteDecision,
  type RouterContext,
  type SuggestContext,
  type SkillSuggestion,
} from "@autobroker/workflows";
import type { SessionService, IntakeScopeNotice } from "./sessions.js";

/** Skill ids whose `profilePin` posture is "pin_required": they must run against
 *  an explicitly pinned search and the workflow STOPs "pin_required" when the
 *  input carries no search_profile_id. The NL router and a normal slash launch
 *  carry none, so without help they STOP even when the session IS pinned (only
 *  the STOP-picker, which passes search_profile_id, worked). */
const PIN_REQUIRED_SKILL_IDS: ReadonlySet<string> = new Set(
  SKILLS.filter((s) => s.profilePin === "pin_required").map((s) => s.id),
);

/** Honor an EXPLICIT session pin at launch: thread the pinned search into a
 *  pin_required skill's start body so it runs on that search instead of STOPping.
 *  An explicit search_profile_id already on the body (the STOP-picker's pick)
 *  always wins; infer_ok/exempt skills are untouched, so the profile-ASK
 *  inference path is unchanged. Threading the user's own pin is NOT inference. */
export function withSessionPin(
  body: Record<string, unknown>,
  skillId: string,
  pinnedProfileId: string | null,
): Record<string, unknown> {
  if (pinnedProfileId === null) return body;
  if (!PIN_REQUIRED_SKILL_IDS.has(skillId)) return body;
  if (body["search_profile_id"] != null) return body;
  return { ...body, search_profile_id: pinnedProfileId };
}

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
  /** The UI's raw provider-selection payload (validated by parseAgentSelection,
   *  which tolerates absent/garbage → null). Kept `unknown` here so the envelope
   *  schema never rejects it; the core parser is the single authority. */
  agent: z.unknown().optional(),
});

/** POST /api/route body — the NL skill-router request. `nl_input` is the user's
 *  free-form chat message; the optional session linkage mirrors the start body
 *  (a launch links the run to `session_id`, and intake forks from
 *  `from_session_id`). */
const RouteBodySchema = z.object({
  nl_input: z.string().min(1),
  session_id: z.string().nullable().optional(),
  from_session_id: z.string().nullable().optional(),
  /** The UI's raw provider-selection payload — see StartBodySchema.agent. */
  agent: z.unknown().optional(),
});

/** POST /api/suggest-next-skills body — the Hybrid skills-popover re-rank
 *  request. The CLIENT sends the DETERMINISTIC candidate ids it already computed
 *  (so the server never re-derives the window — no drift) plus a short recent
 *  conversation summary. The server validates the ids against the registry,
 *  re-ranks within them (the LLM can never widen the set), and returns reasons. */
const SuggestBodySchema = z.object({
  session_id: z.string().nullable().optional(),
  candidate_ids: z.array(z.string()).max(8),
  conversation: z.string().default(""),
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
 *  the route-layer allow-list: only the four editable ids are accepted, so the
 *  read-only path / demo-status ids fail the schema with a 400 before the
 *  store is ever called (a non-editable id is structurally unreachable here). The
 *  store re-checks editable + allowedValues as defense-in-depth. */
const SetEnvBodySchema = z.object({
  id: z.enum(["app_mode", "gmail_account", "chrome_headless", "per_dealer_record_cap"]),
  value: z.string().min(1).max(254),
});

/** Dependencies the route module needs (the server wires these). */
export interface RouteDeps {
  skillRuns: SkillRunService;
  pubsub: RunPubSub;
  sessions: SessionService;
  approvals: ApprovalInbox;
}

/** The NL-router classifier signature the route calls. The default is the real
 *  workflows classifier (a live model call via harness.generate); the test seam
 *  below swaps in a deterministic stub so the route wiring is proven offline. */
type RouteClassifier = (nl: string, ctx: RouterContext) => Promise<RouteDecision>;

/** The classifier the POST /api/route handler invokes — the real workflows
 *  classifier by default. NEVER reassigned outside a test runner. */
let routeClassifier: RouteClassifier = (nl, ctx) => classifySkillFromText(nl, ctx);

/** TEST-ONLY seam: inject a deterministic classifier so the /api/route wiring
 *  (buildInput → start → recordRun / intake fork) is exercised without a live
 *  model. Refused outside a vitest/test runner. */
export function __setRouteClassifierForTests(fn: RouteClassifier): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error("__setRouteClassifierForTests is a test-only seam");
  }
  routeClassifier = fn;
}

/** TEST-ONLY: restore the real classifier. */
export function __resetRouteClassifierForTests(): void {
  routeClassifier = (nl, ctx) => classifySkillFromText(nl, ctx);
}

/** The suggest-next provider the popover endpoint invokes — the real workflows
 *  re-ranker by default. Returns null on ANY fail-closed outcome so the handler
 *  degrades to an empty suggestion list (the UI then keeps its deterministic
 *  order). NEVER reassigned outside a test runner. */
type SuggestFn = (ctx: SuggestContext) => Promise<SkillSuggestion[] | null>;

/** Whether the conversation-aware re-rank should NOT make a real model call.
 *  TRUE in the deterministic UI lane — the functional lane (AUTOBROKER_HARNESS
 *  / fixture, set by serverHost, booted with an obviously-fake DeepSeek key) —
 *  so it makes ZERO provider calls. FALSE in serve-live and buyer (a real key,
 *  no harness sentinel), where the model fires. NOTE we do NOT key off NODE_ENV:
 *  serve-live sets NODE_ENV=test yet IS the live lane. */
function suggestionsDisabled(): boolean {
  if (process.env["AUTOBROKER_HARNESS"] === "1" || process.env["AUTOBROKER_HARNESS_FIXTURE"] === "1") {
    return true;
  }
  const key = (process.env["DEEPSEEK_API_KEY"] ?? "").trim();
  // The deterministic functional lane uses an obviously-fake key
  // (DEEPSEEK_API_KEY="functional-dummy-not-used", carrying "dummy"). A real
  // DeepSeek key (sk-… hex) never matches, so this is a safe secondary gate
  // behind the AUTOBROKER_HARNESS sentinel above.
  return key === "" || /dummy|not[-_]?used/i.test(key);
}

/** The DEFAULT re-ranker: a real model call in a real (buyer / serve-live)
 *  context, but a no-op (null → deterministic order) in the deterministic UI
 *  lanes. The gate lives here (not in the handler) so a unit test that injects
 *  its own deterministic re-ranker via the seam is NOT short-circuited. */
function defaultSuggestNext(ctx: SuggestContext): Promise<SkillSuggestion[] | null> {
  if (suggestionsDisabled()) return Promise.resolve(null);
  return suggestNextSkills(ctx);
}
let suggestNext: SuggestFn = defaultSuggestNext;

/** TEST-ONLY seam: inject a deterministic re-ranker so the suggest endpoint
 *  wiring is exercised without a live model. Refused outside a test runner. */
export function __setSuggestNextForTests(fn: SuggestFn): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error("__setSuggestNextForTests is a test-only seam");
  }
  suggestNext = fn;
}

/** TEST-ONLY: restore the real re-ranker AND clear the suggest cache (the cache
 *  is module-level, so it would otherwise leak across test cases). */
export function __resetSuggestNextForTests(): void {
  suggestNext = defaultSuggestNext;
  SUGGEST_CACHE.clear();
}

/** A tiny bounded cache for the suggest endpoint so a duplicate request (same
 *  session + same candidates + same conversation) doesn't re-spend a model call.
 *  The client already gates calls to run-completion; this is belt-and-suspenders
 *  against rapid duplicate POSTs. Keyed by the request shape; FIFO-capped. */
const SUGGEST_CACHE = new Map<string, SkillSuggestion[]>();
const SUGGEST_CACHE_CAP = 100;
function suggestCacheKey(sessionId: string | null, candidateIds: string[], conversation: string): string {
  // Key on the SAME conversation window the model actually consumes (the prompt
  // slices to ~2000 chars) so two states sharing length + prefix but differing
  // later don't collide and get served a stale ranking.
  return `${sessionId ?? "anon"}|${candidateIds.join(",")}|${conversation.slice(0, 2000)}`;
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
 *  sensitive; profile_pin is the registry's pin posture driving the UI pre-launch
 *  gate; version/retries are this API's manifest metadata. The wire shape carries
 *  profile_pin in snake_case (the wire convention). */
const SKILL_MANIFEST = IMPLEMENTED_SKILLS.map((s) => ({
  name: s.id,
  version: "m1-v1",
  summary: s.summary,
  inputs: s.inputs,
  outputs: s.outputs,
  sensitive: s.riskClass === "irreversible" || s.riskClass === "destructive",
  profile_pin: s.profilePin,
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

/** Sanitize a filename for a Content-Disposition header: strip the double quote
 *  that delimits the value and any CR/LF (header-injection guard), neutralize the
 *  `;`/`=` parameter delimiters (defense-in-depth — no bogus disposition param can
 *  ride inside the quoted value), collapse the rest to a safe ASCII subset, and
 *  fall back to a generic name when empty. */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/["\r\n]/g, "")
    .replace(/[;=]/g, "_")
    .replace(/[^\x20-\x7e]/g, "_")
    .trim();
  return cleaned === "" ? "source" : cleaned;
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

/** The six portfolio pipeline stages (mirrors the wire `PortfolioStage`). */
type PortfolioStage =
  | "intake"
  | "scan"
  | "lead_submit"
  | "awaiting_replies"
  | "negotiation"
  | "closeout";

/** Derive a coarse, MONOTONIC lifecycle stage for a portfolio card from the
 *  digest's own per-profile tallies (no extra query). Quotes ⇒ negotiating;
 *  else replies ⇒ awaiting; else a bound dealer ⇒ lead submitted; else a found
 *  dealer ⇒ scanned; else nothing yet ⇒ intake. (Closeout closes the profile, so
 *  a closed-out search is no longer on the active board — `closeout` stays in the
 *  enum for the board legend / future surfacing.) */
function deriveStage(p: {
  dealerCount: number;
  boundDealerCount: number;
  threadCount: number;
  totalQuotes: number;
}): PortfolioStage {
  if (p.totalQuotes > 0) return "negotiation";
  if (p.threadCount > 0) return "awaiting_replies";
  if (p.boundDealerCount > 0) return "lead_submit";
  if (p.dealerCount > 0) return "scan";
  return "intake";
}

/** The card's location label: `City, ST` when present, else the raw
 *  location_query, else the ZIP, else "". Never a budget (#9). */
function cityOf(row: Record<string, unknown> | null): string {
  if (row === null) return "";
  const str = (k: string): string => (typeof row[k] === "string" ? (row[k] as string) : "");
  const city = str("city");
  if (city !== "") {
    const state = str("state");
    return state !== "" ? `${city}, ${state}` : city;
  }
  const lq = str("location_query");
  if (lq !== "") return lq;
  return str("postal_code");
}

/**
 * Register all routes on the Fastify instance under /api.
 */
export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { skillRuns, pubsub, sessions, approvals } = deps;

  // ---- POST /api/skill-runs — start a skill run (headless or rail-linked) ---
  app.post("/api/skill-runs", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(StartBodySchema, req.body);

    // Per-skill registry lookup: an unknown skill id is a typed 400.
    const descriptor = skillRuns.descriptorFor(body.skill);
    if (descriptor === undefined) {
      throw new RouteError("unknown_skill", 400, `unknown skill '${body.skill}'`);
    }

    // A pinned session threads its pin into a pin_required skill's input — the UI
    // sends no search_profile_id on a normal slash launch (only the STOP-picker
    // does). Mirrors POST /api/route so both launch paths honor an explicit pin.
    let slashPin: string | null = null;
    if (body.session_id != null && body.session_id.length > 0) {
      const session = await sessions.get(body.session_id);
      slashPin = session?.pinned_profile_id ?? null;
    }

    // Validate + shape the per-skill input BEFORE the session fork below, so a
    // bad body leaves no stray forked session behind.
    let input: unknown;
    try {
      input = descriptor.buildInput(
        withSessionPin(req.body as Record<string, unknown>, body.skill, slashPin),
      );
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

    // Per-run provider selection (parsed ONCE at the envelope; absent/garbage →
    // null → register nothing → the DeepSeek default is unchanged). It rides into
    // beginRunGuarded, which registers it run-scoped in lock-step with ownership.
    const agentSelection = parseAgentSelection(body.agent);

    try {
      const { runId } = await skillRuns.start({
        skill: body.skill,
        input,
        sessionId,
        ...(agentSelection !== null ? { agentSelection } : {}),
      });
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
      if (err instanceof ProfileRunConflictError) {
        throw new RouteError("profile_run_conflict", 409, err.message, {
          extra: {
            profile_id: err.profileId,
            live_run_id: err.liveRunId,
          },
        });
      }
      throw err;
    }
  });

  // ---- POST /api/route — the NL skill-router (the core product feature) ------
  // An LLM reads the free-form chat message and routes it to ONE skill / intake /
  // clarify. A LAUNCH goes through the EXACT same launch path as POST
  // /api/skill-runs (descriptor.buildInput → forkForIntake → skillRuns.start →
  // recordRun) — every gate stays downstream, button-only; the router NEVER
  // pre-approves. A CLARIFY returns 200 with NO run started. The model call lives
  // in the workflows classifier (via harness); this handler only orchestrates.
  app.post("/api/route", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(RouteBodySchema, req.body);

    // Session context: the pinned profile (read off thread metadata) is forwarded
    // to the classifier so it knows whether a search is in scope. The router NEVER
    // infers a profile — the skill's own resolveScope gate is load-bearing.
    let pinnedProfileId: string | null = null;
    if (body.session_id != null && body.session_id.length > 0) {
      const session = await sessions.get(body.session_id);
      pinnedProfileId = session?.pinned_profile_id ?? null;
    }

    const ctx: RouterContext = {
      pinnedProfileId,
      ledger: {
        runId: `route-${body.session_id ?? "anon"}-${Date.now()}`,
        skill: "chat_route",
        layer: "L2",
        promptVersion: null,
        schemaVersion: null,
      },
    };

    // Per-run provider selection (parsed ONCE at the envelope; absent/garbage →
    // null → register nothing). Register it against the SAME runId the router's
    // ledger uses so the classifier's harness.generate(chat_route) honors it, then
    // clear it in a finally — the selection lives only for the classify call.
    const agentSelection = parseAgentSelection(body.agent);
    if (agentSelection !== null) setRunSelection(ctx.ledger.runId, agentSelection);
    let decision: RouteDecision;
    try {
      decision = await routeClassifier(body.nl_input, ctx);
    } finally {
      if (agentSelection !== null) clearRunSelection(ctx.ledger.runId);
    }

    // CLARIFY — no run started; the rail renders a local assistant clarify turn.
    if (decision.kind === "clarify") {
      reply.code(200);
      return {
        routing: { kind: "clarify", reason: decision.reason, candidates: decision.candidates },
      };
    }

    // LAUNCH — the SAME path the start route runs. A defensive unknown skill (the
    // enum should prevent it) degrades to clarify, never a 400 dead-end.
    const descriptor = skillRuns.descriptorFor(decision.skillId);
    if (descriptor === undefined) {
      reply.code(200);
      return {
        routing: { kind: "clarify", reason: "I could not start that action.", candidates: [] },
      };
    }

    // Build the per-skill input the SAME way the start route does (the descriptor
    // owns validation). A throw → clarify (do NOT 400 the user into a dead end).
    let input: unknown;
    try {
      input = descriptor.buildInput(
        withSessionPin(
          { skill: decision.skillId, ...decision.inputData },
          decision.skillId,
          pinnedProfileId,
        ),
      );
    } catch {
      reply.code(200);
      return {
        routing: { kind: "clarify", reason: "I could not start that action.", candidates: [] },
      };
    }

    // INTAKE FORK — mirror the start route (307-310): intake never inherits a pin;
    // a from_session_id forks a fresh unpinned session and carries the scope notice.
    let sessionId: string | null = body.session_id ?? null;
    let scopeNotice: IntakeScopeNotice | null = null;
    if (decision.skillId === INTAKE_SKILL_ID && body.from_session_id !== undefined) {
      const fork = await sessions.forkForIntake(body.from_session_id);
      sessionId = fork.sessionId;
      scopeNotice = fork.scopeNotice;
    }

    try {
      // The launched skill carries the SAME selection the classifier honored, so
      // an NL command routed to a launch runs the downstream skill on the chosen
      // provider (registered run-scoped for THIS run's runId, distinct from the
      // chat_route synthetic runId cleared above). Absent → policy/env default.
      const { runId } = await skillRuns.start({
        skill: decision.skillId,
        input,
        sessionId,
        ...(agentSelection !== null ? { agentSelection } : {}),
      });
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
      return {
        run_id: runId,
        session_id: sessionId,
        scope_notice: scopeNotice,
        routing: {
          kind: "launch",
          skill_id: decision.skillId,
          confidence: decision.confidence,
          reason: decision.reason,
        },
      };
    } catch (err) {
      if (err instanceof DuplicateRunIdError) {
        throw new RouteError("duplicate_run_id", 409, err.message, {
          extra: { run_id: err.runId },
        });
      }
      if (err instanceof ProfileRunConflictError) {
        throw new RouteError("profile_run_conflict", 409, err.message, {
          extra: {
            profile_id: err.profileId,
            live_run_id: err.liveRunId,
          },
        });
      }
      throw err;
    }
  });

  // ---- POST /api/suggest-next-skills — the Hybrid skills-popover re-rank ------
  // Advisory ONLY: re-orders the client's DETERMINISTIC candidate ids by the live
  // conversation and writes a one-line reason for each. It NEVER launches, NEVER
  // widens the candidate set (the model's choices are constrained to the ids the
  // client sent, then re-filtered here), and degrades to an empty list on ANY
  // fail-closed model outcome — the UI then keeps its deterministic order +
  // curated reasons. No run is started; no gate is touched.
  app.post("/api/suggest-next-skills", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(SuggestBodySchema, req.body);
    // Keep ONLY real, registry-known skills (defense-in-depth — the server never
    // trusts arbitrary ids even though the UI sends its own deterministic set).
    const candidateIds = body.candidate_ids.filter(
      (id) => skillRuns.descriptorFor(id) !== undefined,
    );
    if (candidateIds.length === 0) {
      reply.code(200);
      return { suggestions: [] };
    }

    const sessionId = body.session_id ?? null;
    const cacheKey = suggestCacheKey(sessionId, candidateIds, body.conversation);
    const cached = SUGGEST_CACHE.get(cacheKey);
    if (cached !== undefined) {
      reply.code(200);
      return { suggestions: cached.map((s) => ({ skill_id: s.skillId, reason: s.reason })) };
    }

    const ctx: SuggestContext = {
      candidateIds,
      conversation: body.conversation,
      // Reserved for future grounding; the suggest prompt ignores it today, so we
      // skip the per-request session read (the re-ranker never infers/launches —
      // the skill's own resolveScope stays the floor).
      pinnedProfileId: null,
      ledger: {
        runId: `suggest-${sessionId ?? "anon"}-${Date.now()}`,
        skill: "chat_route",
        layer: "L2",
        promptVersion: null,
        schemaVersion: null,
      },
    };

    // null == fail-closed (emit-not-called/zod/transport) → empty list (the UI keeps
    // its deterministic order). Only a NON-null result is cached, so a transient
    // model hiccup never poisons the cache for that request shape.
    const raw = await suggestNext(ctx);
    const ranked = raw ?? [];
    if (raw !== null) {
      if (SUGGEST_CACHE.size >= SUGGEST_CACHE_CAP) {
        const oldest = SUGGEST_CACHE.keys().next().value;
        if (oldest !== undefined) SUGGEST_CACHE.delete(oldest);
      }
      SUGGEST_CACHE.set(cacheKey, ranked);
    }
    reply.code(200);
    return { suggestions: ranked.map((s) => ({ skill_id: s.skillId, reason: s.reason })) };
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

  // ---- GET /api/approvals — the consolidated "needs you" queue --------------
  // Aggregates EVERY parked gate (the 3 irreversible sends + dealer_inbox_check +
  // inventory_link_scan) across all concurrent profiles,
  // ranked action-required first, keyed (profileId, runId, decisionId), tagged by
  // reason + the budget-free summary. Read-only: each decision still goes through
  // POST /api/skill-runs/:id/form-decision (the idempotent three-phase claim).
  app.get("/api/approvals", async (_req: FastifyRequest, _reply: FastifyReply) => {
    return approvals.list();
  });

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
    // The dealer rows enriched with the derived-on-read give-up advisory (verdict /
    // verdict_reason / batna_gap_usd, merged by dealer_id) so the Dealers canvas can
    // render a "consider switching / gone quiet / paused" chip. Budget-free.
    return withDb((db) => listProfileDealerRowsWithVerdicts(db, id));
  });

  // ---- GET /api/profiles/:id/threads — read-only dealer-reply projection ---
  // The Threads canvas section reads this; delegates DOWN into the tools-layer
  // closure (routes never open the product DB directly — the SQLite invariant).
  app.get("/api/profiles/:id/threads", async (req: FastifyRequest, _reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const profile = withDb((db) => readProfileRow(db, id));
    if (profile === null) {
      throw new RouteError("not_found", 404, `profile ${id} not found`);
    }
    // The thread rows enriched with the derived negotiation_status (countered /
    // stalled / dormant / …) and re-ordered by the honest last_activity_at.
    return withDb((db) => listProfileThreadRowsWithStatus(db, id));
  });

  // ---- GET /api/profiles/:id/dealer-negotiations — per-dealer negotiation grid
  // The Negotiation cards canvas reads this. Delegates DOWN into the tools-layer
  // closure (routes never open the product DB directly — the SQLite invariant).
  // Budget-free (only $ dealer-quote figures + batna scalars; inv #9).
  app.get(
    "/api/profiles/:id/dealer-negotiations",
    async (req: FastifyRequest, _reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const profile = withDb((db) => readProfileRow(db, id));
      if (profile === null) {
        throw new RouteError("not_found", 404, `profile ${id} not found`);
      }
      return withDb((db) => listProfileDealerNegotiations(db, id));
    },
  );

  // ---- GET /api/profiles/:id/dealer-negotiations/:dealerId — one dealer detail
  // A foreign / unbound dealer projects null → 404. Read-only, delegates DOWN.
  app.get(
    "/api/profiles/:id/dealer-negotiations/:dealerId",
    async (req: FastifyRequest, _reply: FastifyReply) => {
      const { id, dealerId } = req.params as { id: string; dealerId: string };
      const profile = withDb((db) => readProfileRow(db, id));
      if (profile === null) {
        throw new RouteError("not_found", 404, `profile ${id} not found`);
      }
      const detail = withDb((db) =>
        readDealerNegotiationDetail(db, { profileId: id, dealerId }),
      );
      if (detail === null) {
        throw new RouteError("not_found", 404, `dealer ${dealerId} not found`);
      }
      return detail;
    },
  );

  // ---- GET /api/profiles/:id/dealer-negotiations/:dealerId/summary ----------
  // The LLM negotiation-state summary. Delegates DOWN to the workflows layer (the
  // ONLY caller that may invoke the LLM; tools never do). Returns {summary} and
  // NEVER 404s on generation failure — the workflow fn degrades to null
  // (emit-not-called / budget-belt / transport all resolve {summary:null}).
  app.get(
    "/api/profiles/:id/dealer-negotiations/:dealerId/summary",
    async (req: FastifyRequest, _reply: FastifyReply) => {
      const { id, dealerId } = req.params as { id: string; dealerId: string };
      const profile = withDb((db) => readProfileRow(db, id));
      if (profile === null) {
        throw new RouteError("not_found", 404, `profile ${id} not found`);
      }
      return withDb((db) =>
        getOrGenerateDealerNegotiationSummary(db, { profileId: id, dealerId }),
      );
    },
  );

  // ---- GET /api/digest — the daily-digest live projection ------------------
  // The /digest page reads this. Optional ?profile_id pins one profile; absent
  // → enumerate all active profiles. Re-aggregated live each call (the file
  // artifact is the archive; the page is a live view). Delegates DOWN into the
  // tools-layer reader — routes never open the product DB directly (the SQLite
  // invariant). Budget never appears in the projection (zero-LLM, code-redacted).
  app.get("/api/digest", async (req: FastifyRequest, _reply: FastifyReply) => {
    const { profile_id } = (req.query ?? {}) as { profile_id?: string };
    return withDb((db) =>
      buildDigestView(db, { profileId: profile_id ?? null, nowMs: Date.now() }),
    );
  });

  // ---- GET /api/portfolio — the Phase-3 portfolio board projection ----------
  // One card per ACTIVE search (newest-first), seeded from the SAME digest
  // aggregation PLUS a derived lifecycle `stage` and the hot/warm/cold `health`
  // dot (profileHealth). A pure server projection — every DB read delegates DOWN
  // into the tools layer (the SQLite invariant). The board groups by segment and
  // computes the header counts CLIENT-SIDE; budget never appears (#9).
  app.get("/api/portfolio", async (_req: FastifyRequest, _reply: FastifyReply) => {
    const nowMs = Date.now();
    // Per-profile last-activity clock from the rail sessions (the pinned-profile
    // timestamp); an unpinned active profile has no session → null clock.
    const allSessions = await sessions.list();
    const lastActivityByProfile = new Map<string, string>();
    for (const s of allSessions) {
      if (s.pinned_profile_id === null) continue;
      const prev = lastActivityByProfile.get(s.pinned_profile_id);
      if (prev === undefined || s.last_activity_at > prev) {
        lastActivityByProfile.set(s.pinned_profile_id, s.last_activity_at);
      }
    }
    return withDb((db) => {
      // HOT signal: the profiles with a live run, read from the activation
      // registry (the virtual-actor ProfileId→runId map the scheduler keeps).
      const liveRunProfileIds = listActiveProfileIds(db);
      const digest = buildDigestView(db, { profileId: null, nowMs });
      const health = new Map(profileHealth(db, liveRunProfileIds).map((h) => [h.profileId, h]));
      const cards = digest.profiles.map((p) => {
        const row = readProfileRow(db, p.searchProfileId);
        const h = health.get(p.searchProfileId);
        return {
          searchProfileId: p.searchProfileId,
          vehicle: p.vehicle,
          city: cityOf(row),
          dealerCount: p.dealerCount,
          bestOtd: p.bestOtd,
          lastActivityAt: lastActivityByProfile.get(p.searchProfileId) ?? null,
          stage: deriveStage(p),
          health: h?.health ?? "warm",
          reasons: h?.reasons ?? [],
        };
      });
      return { empty: cards.length === 0, generatedAt: digest.generatedAt, cards };
    });
  });

  // ---- GET /api/profiles/:id/quotes — read-only RAW extracted-quote projection
  // The "Extracted quotes" canvas section reads this; delegates DOWN into the
  // tools-layer closure (routes never open the product DB directly — the SQLite
  // invariant). Distinct from /quote-compare: this is the raw per-quote
  // extraction result across ALL financing modes (incl. cash), with provenance —
  // never a budget, never a raw id rendered.
  app.get("/api/profiles/:id/quotes", async (req: FastifyRequest, _reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const profile = withDb((db) => readProfileRow(db, id));
    if (profile === null) {
      throw new RouteError("not_found", 404, `profile ${id} not found`);
    }
    return withDb((db) => listProfileQuoteRows(db, id));
  });

  // ---- GET /api/profiles/:id/quotes/:quoteId/source — stream the source doc ---
  // "Show the document this quote came from": the tools reader re-fetches the
  // dealer-sent PDF/image ON DEMAND through the gmail adapter (nothing persisted)
  // and we stream the bytes back inline. Delegates DOWN into the tools-layer
  // closure (routes never open the product DB or call the adapter directly — the
  // SQLite invariant). The reader is read-only and NEVER throws: a missing quote /
  // attachment, an oversized blob, or a transient adapter failure → null → 404.
  app.get(
    "/api/profiles/:id/quotes/:quoteId/source",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id, quoteId } = req.params as { id: string; quoteId: string };
      const profile = withDb((db) => readProfileRow(db, id));
      if (profile === null) {
        throw new RouteError("not_found", 404, `profile ${id} not found`);
      }
      const doc = await withDb((db) => readQuoteSourceDoc(db, { profileId: id, quoteId }));
      if (doc === null) {
        throw new RouteError("not_found", 404, `no source document for quote ${quoteId}`);
      }
      reply.type(doc.mimeType);
      reply.header("content-disposition", `inline; filename="${sanitizeFilename(doc.filename)}"`);
      return reply.send(Buffer.from(doc.bytes));
    },
  );

  // ---- GET /api/profiles/:id/incentives — read-only mfr-incentive projection
  // The Incentives canvas section reads this; delegates DOWN into the tools-layer
  // closure (routes never open the product DB directly — the SQLite invariant).
  // The incentive_scrape skill writes manufacturer_incentives keyed on the
  // profile's (make, model, zip); the reader joins the profile's vehicle to that
  // slice. Cash incentives only — never a budget, never a raw id rendered.
  app.get("/api/profiles/:id/incentives", async (req: FastifyRequest, _reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const profile = withDb((db) => readProfileRow(db, id));
    if (profile === null) {
      throw new RouteError("not_found", 404, `profile ${id} not found`);
    }
    return withDb((db) => listProfileIncentiveRows(db, id));
  });

  // ---- GET /api/profiles/:id/inventory-compare — read-only ranked listings ---
  // The Inventory candidates canvas section reads this; delegates DOWN into the
  // tools-layer ranker closure (routes never open the product DB or run SQL —
  // the SQLite invariant). Listings ≠ quotes: the payload is public-website
  // inventory candidates, ranked against the profile, never negotiated quotes.
  app.get(
    "/api/profiles/:id/inventory-compare",
    async (req: FastifyRequest, _reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const profile = withDb((db) => readProfileRow(db, id));
      if (profile === null) {
        throw new RouteError("not_found", 404, `profile ${id} not found`);
      }
      return withDb((db) => rankInventoryForProfile(db, id));
    },
  );

  // ---- GET /api/profiles/:id/quote-compare — read-only ranked quotes -------
  // The Quote compare canvas section reads this; delegates DOWN into the
  // tools-layer compare ranker closure (routes never open the product DB or run
  // SQL — the SQLite invariant). The payload is the two mode buckets (finance +
  // lease, both always present) gated by the profile's financing preference,
  // each ranked by OTD, joined to the latest audit per quote. No budget anywhere.
  app.get(
    "/api/profiles/:id/quote-compare",
    async (req: FastifyRequest, _reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const profile = withDb((db) => readProfileRow(db, id));
      if (profile === null) {
        throw new RouteError("not_found", 404, `profile ${id} not found`);
      }
      const result = withDb((db) => rankQuotesForProfile(db, id));
      return {
        ...result,
        totalRanked: result.finance.length + result.lease.length + result.cash.length,
      };
    },
  );

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

  // ---- POST /api/profiles/:id/purge — HARD-DELETE (irreversible erase) ------
  // Delegates to the tools-layer purge(), which erases EVERY local row scoped to
  // the profile (deferred-FK cascade over the profile-scoped tables), unbinds any
  // pinned session, drops the profile row, and writes a 'profile_purge' tombstone
  // audit row. NOT recoverable (unlike the soft DELETE above → 'closed'/restore).
  // A missing profile → 404. Returns { ok, counts } (per-table delete tallies).
  app.post("/api/profiles/:id/purge", async (req: FastifyRequest, _reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const result = withDb((db) => purgeProfile(db, id, { actor: "dashboard" }));
    if (!result.deleted) {
      throw new RouteError("not_found", 404, `profile ${id} not found`);
    }
    return { ok: true, counts: result.counts };
  });

  // ---- GET /api/skills — manifest of implemented skills --------------------
  app.get("/api/skills", async () => {
    return SKILL_MANIFEST;
  });

  // ---- GET /api/mode — harness preflight {active_db, data_dir, demo, mode} --
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
    // mode = the single AUTOBROKER_MODE posture ("buyer" = real product, "test" =
    // internal/safe), read fresh. The TopBar mode toggle reflects + switches this.
    return { active_db: activeDb, data_dir: dataDir, demo, mode: resolveMode() };
  });

  // ========================================================================
  // settings/keys — the five user-supplied secrets (four API keys + the Claude
  // subscription OAuth token). The route layer NEVER
  // reads/writes the keys file or holds a secret; it delegates to the tools
  // secretsStore/probe. A key VALUE is never returned on any of these.
  // ========================================================================

  // ---- GET /api/settings/keys — presence only (never a value) --------------
  app.get("/api/settings/keys", async () => {
    // gmail is a placeholder (the OAuth connect wiring lands separately); report
    // it not-connected so the UI can render the slot without a real signal yet.
    // agentDefault = the server's effective default provider selection (from
    // AUTOBROKER_AGENT_PROVIDER); the AgentBar reflects it so its boxes show what
    // will actually run, not the hardcoded client default.
    return { ...getKeyPresence(), gmail: { connected: false }, agentDefault: envDefaultSelection() };
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
  // AUTOBROKER_MODE (the sole send-control var) is the editable "Mode" row; the
  // read-only paths/status rows can never be written (the PUT id enum rejects a
  // non-editable id, and the store refuses any non-editable id).
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
