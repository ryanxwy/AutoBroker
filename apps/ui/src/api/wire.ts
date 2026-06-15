/**
 * wire — Zod schemas + types that MIRROR the server envelope EXACTLY. Every
 * schema here is a client-side restatement of a shape the server emits; each is
 * annotated with the authoritative server file:line so the two stay in lockstep.
 * The client never invents a field the server does not send.
 *
 * Dependency wall: app/ui layer. Imports @autobroker/core (the shared status +
 * harness-driver enums) and zod only — never the server package, never any
 * framework below the app layer.
 */

import { SkillRunStatusSchema } from "@autobroker/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Error envelope — apps/server/src/server.ts:38-52 (errorEnvelope).
//   { error: { field?, message, code, ...extra } }
// `field` is an optional JSON pointer; `extra` (issues / run_id / retry_after_ms)
// rides alongside code/message at the SAME level — we capture it with passthrough.
// ---------------------------------------------------------------------------

export const ErrorEnvelopeSchema = z.object({
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      field: z.string().optional(),
    })
    .loose(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

// ---------------------------------------------------------------------------
// EVENT_KINDS — apps/server/src/runPubSub.ts:47-69 (verbatim). Kept as a local
// const so the SSE reducer can switch exhaustively without importing the server.
// If the server list changes, this must change in lockstep (the wire owns it).
// ---------------------------------------------------------------------------

export const EVENT_KINDS = [
  "init",
  "text",
  "tool_call",
  "tool_result",
  "awaiting_user",
  "awaiting_permission",
  "approval_required",
  "approval_response",
  "reasoning_full",
  "reasoning_summary",
  "refusal",
  "browser.opened",
  "browser.action",
  "browser.error",
  "browser.closed",
  // browser.acquire.progress — additive install-on-demand progress pulse emitted
  // while the browser engine is being acquired (the frame works regardless; this
  // keeps the kind mirror honest with the server's emitter).
  "browser.acquire.progress",
  // data.changed — the non-terminal "a write landed" pulse driving
  // fresh-by-default auto-refresh (payload {profile_id, kinds:string[]}).
  "data.changed",
  "done",
  "error",
  "aborted",
  "runs.list_changed",
  "runs.run_updated",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** The three terminal wire kinds — runPubSub.ts:72 (TERMINAL_EVENT_KINDS). A
 *  run's stream ends after exactly one. */
export const TERMINAL_EVENT_KINDS = ["done", "error", "aborted"] as const;
export type TerminalEventKind = (typeof TERMINAL_EVENT_KINDS)[number];

const EVENT_KIND_SET = new Set<string>(EVENT_KINDS);
const TERMINAL_SET = new Set<string>(TERMINAL_EVENT_KINDS);

export function isEventKind(k: string): k is EventKind {
  return EVENT_KIND_SET.has(k);
}
export function isTerminalKind(k: string): k is TerminalEventKind {
  return TERMINAL_SET.has(k);
}

// ---------------------------------------------------------------------------
// SSE frame — apps/server/src/runPubSub.ts:79-83 (SseEvent) and the route
// serializer routes.ts:195-198 (`data: <compact-json>\n\n`, NO `event:` line).
//   { ts: <ISO-8601 UTC>, kind: <EVENT_KIND>, payload: {...} }
// NOTE: the wire carries NO `seq`/`id` field (no Last-Event-ID) — replay is by
// full-snapshot re-send (runPubSub.ts:33-35). Dedupe is therefore by content,
// not by sequence number.
// ---------------------------------------------------------------------------

export const SseEventSchema = z.object({
  ts: z.string(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type SseEvent = z.infer<typeof SseEventSchema>;

// ---------------------------------------------------------------------------
// Status summary — GET /api/skill-runs/:id.
// apps/server/src/intakeRuns.ts:547-576 (statusSummary return):
//   { run_id, skill, status: SkillRunStatus, pending: {step, decision_id}|null,
//     events: SseEvent[] }
// `status` is the product 7-value projection (core SkillRunStatusSchema).
// ---------------------------------------------------------------------------

export const PendingSuspendSchema = z.object({
  step: z.string(),
  decision_id: z.string(),
});
export type PendingSuspend = z.infer<typeof PendingSuspendSchema>;

export const SkillRunSummarySchema = z.object({
  run_id: z.string(),
  skill: z.string(),
  status: SkillRunStatusSchema,
  pending: PendingSuspendSchema.nullable(),
  events: z.array(SseEventSchema),
});
export type SkillRunSummary = z.infer<typeof SkillRunSummarySchema>;

// ---------------------------------------------------------------------------
// IntakeScopeNotice — the non-skippable system notice carried on the start ack
// when intake was forked from a PINNED session (intake-from-pinned fork rule).
// MIRRORS the server type sessions.ts (IntakeScopeNotice) verbatim: kind discriminant +
// source/forked ids + the three fixed points. The UI renders it as the forked
// session's FIRST part under [data-intake-scope-notice]; null when the source
// was unpinned/absent (nothing to confuse).
// ---------------------------------------------------------------------------

export const IntakeScopeNoticeSchema = z.object({
  kind: z.literal("intake_scope_notice"),
  source_pinned_profile_id: z.string(),
  forked_session_id: z.string(),
  points: z.tuple([z.string(), z.string(), z.string()]),
});
export type IntakeScopeNotice = z.infer<typeof IntakeScopeNoticeSchema>;

// ---------------------------------------------------------------------------
// Sessions — /api/sessions CRUD (sessions.ts SessionResponse). snake_case
// responses; request bodies camelCase (CreateSessionBody/PatchSessionBody in
// routes.ts). scope_notice is the PERSISTED intake notice for a forked session
// — the rail hydrates pin + notice from the SAME GET /api/sessions/:id fetch.
// ---------------------------------------------------------------------------

export const SessionResponseSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  created_at: z.string(),
  last_activity_at: z.string(),
  pinned_profile_id: z.string().nullable(),
  scope_notice: IntakeScopeNoticeSchema.nullable(),
  /** The LAST run started from this session (durable thread metadata), or
   *  null. Drives the per-session terminal pill (the session's BOUND run, not
   *  a global latest-run guess) and post-restart session re-entry. */
  last_run_id: z.string().nullable(),
  archived: z.boolean(),
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const SessionListSchema = z.array(SessionResponseSchema);
export type SessionList = z.infer<typeof SessionListSchema>;

/** PATCH /api/sessions/:id body (camelCase; null-vs-omitted is load-bearing —
 *  an omitted pin leaves it as-is, a present null/"" clears it). */
export interface PatchSessionBody {
  title?: string | null;
  pinnedProfileId?: string | null;
}

/** POST /api/sessions body (camelCase). */
export interface CreateSessionBody {
  title?: string | null;
  pinnedProfileId?: string | null;
}

// ---------------------------------------------------------------------------
// Start ack — POST /api/skill-runs (201). routes.ts:204-208 returns
//   { run_id, session_id: string|null, scope_notice: IntakeScopeNotice|null }.
// (An earlier scaffold modelled only `run_id`; the server already emits
// session_id + scope_notice — this closes the latent gap so the rail can render
// the fork's first system notice.)
// ---------------------------------------------------------------------------

export const StartAckSchema = z.object({
  run_id: z.string(),
  session_id: z.string().nullable(),
  scope_notice: IntakeScopeNoticeSchema.nullable(),
});
export type StartAck = z.infer<typeof StartAckSchema>;

/** The headless start body — routes.ts:55-65 (StartBodySchema). snake_case is
 *  intentional (it matches the workflow input verbatim). `skill` is any
 *  registered RunDescriptor id (the server 400s unknown_skill otherwise); the
 *  per-skill fields (input_mode/freeform_text/seed_fields are intake's) ride the
 *  same body and are validated by the skill's buildInput. `from_session_id`
 *  forks a fresh unpinned session (and yields a scope_notice when the source was
 *  pinned); `session_id` links to an already-unpinned rail without a fork. */
export interface StartRunBody {
  skill: string;
  input_mode: "slash" | "freeform";
  freeform_text?: string | null;
  seed_fields?: Record<string, unknown> | null;
  session_id?: string | null;
  from_session_id?: string | null;
  /** Per-skill start fields ride the same body (the server's StartBodySchema is
   *  non-strict; the skill's RunDescriptor.buildInput validates its own slice —
   *  e.g. dealer_geosearch's `search_profile_id`, the slash-args carrier). */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Form-decision — POST /api/skill-runs/:id/form-decision.
// Body: apps/server/src/intakeRuns.ts:108-114 (FormDecisionBodySchema).
// Ack: intakeRuns.ts:402-403 (accept → {action, content}) /
//      :386-388 (decline|cancel → {action, content:null}).
// ---------------------------------------------------------------------------

export interface FormDecisionBody {
  decision_id: string;
  decision: {
    action: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
  };
}

export const FormDecisionAckSchema = z.object({
  action: z.enum(["accept", "decline", "cancel"]),
  content: z.record(z.string(), z.unknown()).nullable(),
});
export type FormDecisionAck = z.infer<typeof FormDecisionAckSchema>;

// ---------------------------------------------------------------------------
// Profiles — GET /api/profiles (list) / GET /api/profiles/:id (one).
// routes.ts:262-275: snake_case rows straight off the DB columns
// (SearchProfileView). The exact column set is the DB schema's, not a
// fixed contract here — keep rows as open records (passthrough) so a schema
// add does not break decode; the UI reads named columns it knows.
// ---------------------------------------------------------------------------

export const ProfileRowSchema = z.record(z.string(), z.unknown());
export type ProfileRow = z.infer<typeof ProfileRowSchema>;

export const ProfileListSchema = z.array(ProfileRowSchema);
export type ProfileList = z.infer<typeof ProfileListSchema>;

/** PATCH /api/profiles/:id body (camelCase; routes.ts PatchProfileBodySchema).
 *  ONLY the editable preference fields — identity is frozen at confirm and is
 *  never sent (the server 409s it). The four color/trim/feature columns are
 *  JSON-encoded STRINGS (string[] serialized to a JSON string by the caller). */
export interface PatchProfileBody {
  budgetMax?: number | null;
  searchRadiusMiles?: number | null;
  followUpEmail?: string | null;
  followUpPhone?: string | null;
  financingPreference?: string | null;
  tradeInDescription?: string | null;
  preferredExteriorColorsJson?: string | null;
  preferredInteriorColorsJson?: string | null;
  acceptableTrimsJson?: string | null;
  featurePreferencesJson?: string | null;
}

// ---------------------------------------------------------------------------
// Dealers — GET /api/profiles/:id/dealers: snake_case rows off the dealers
// table joined through profile_dealers (candidate_status/bound_at carry the
// per-profile binding state). Open records like the profile rows — the UI
// reads the named columns it knows.
// ---------------------------------------------------------------------------

export const DealerRowSchema = z.record(z.string(), z.unknown());
export type DealerRow = z.infer<typeof DealerRowSchema>;

export const DealerListSchema = z.array(DealerRowSchema);
export type DealerList = z.infer<typeof DealerListSchema>;

// ---------------------------------------------------------------------------
// Threads — GET /api/profiles/:id/threads: snake_case rows off the threads
// table joined to dealers for the display name, newest-touched first. The
// Threads canvas section reads the named columns it knows (dealer name, subject,
// state, updated_at); a passthrough record keeps extra server fields tolerated.
// ---------------------------------------------------------------------------

export const ThreadRowSchema = z
  .object({
    thread_id: z.string(),
    dealer_name: z.string().nullable(),
    subject: z.string().nullable(),
    state: z.string().nullable(),
    updated_at: z.string().nullable(),
  })
  .passthrough();
export type ThreadRow = z.infer<typeof ThreadRowSchema>;

export const ThreadListSchema = z.array(ThreadRowSchema);
export type ThreadList = z.infer<typeof ThreadListSchema>;

// ---------------------------------------------------------------------------
// Extracted quotes — GET /api/profiles/:id/quotes: snake_case rows off the
// dealer_quotes table joined to dealers for the display name, newest-received
// first. The RAW per-quote extraction projection the "Extracted quotes" canvas
// section renders — ALL financing modes (incl. cash), with provenance. Distinct
// from /quote-compare's ranked finance/lease buckets. quote_id is the React key
// only (never rendered); NO budget anywhere. A tolerant (passthrough) shape keeps
// extra server fields.
// ---------------------------------------------------------------------------

export const QuoteRowSchema = z
  .object({
    quote_id: z.string(),
    dealer_name: z.string().nullable(),
    financing_mode: z.string().nullable(),
    otd_total: z.number().nullable(),
    selling_price: z.number().nullable(),
    vin: z.string().nullable(),
    quote_format: z.string().nullable(),
    intent: z.string().nullable(),
    extractor_provider: z.string().nullable(),
    extraction_method: z.string().nullable(),
    quote_received_at: z.string().nullable(),
  })
  .passthrough();
export type QuoteRow = z.infer<typeof QuoteRowSchema>;

export const QuoteListSchema = z.array(QuoteRowSchema);
export type QuoteList = z.infer<typeof QuoteListSchema>;

// ---------------------------------------------------------------------------
// Inventory candidates — GET /api/profiles/:id/inventory-compare: the
// deterministic ranker payload (candidates + header tallies). Listings ≠
// quotes: these are public-website inventory candidates ranked against the
// profile, never negotiated out-the-door quotes. A passthrough candidate row
// keeps extra server fields tolerated; the panel reads the named columns it
// knows (full vin, stock_number, price, match_status chip, rank reasons).
// ---------------------------------------------------------------------------

export const InventoryCandidateRowSchema = z
  .object({
    listing_id: z.string(),
    vin: z.string().nullable(),
    stock_number: z.string().nullable(),
    year: z.number().nullable(),
    make: z.string().nullable(),
    model: z.string().nullable(),
    trim: z.string().nullable(),
    exterior_color: z.string().nullable(),
    listed_price: z.number().nullable(),
    msrp: z.number().nullable(),
    inventory_status: z.string(),
    dealer_id: z.string(),
    dealer_name: z.string().nullable(),
    distance_miles: z.number().nullable(),
    score: z.number(),
    reasons: z.array(z.string()),
    match_status: z.string(),
  })
  .passthrough();
export type InventoryCandidateRow = z.infer<typeof InventoryCandidateRowSchema>;

export const InventoryCompareResultSchema = z
  .object({
    candidates: z.array(InventoryCandidateRowSchema),
    scannedAtMax: z.string().nullable(),
    totalListings: z.number(),
    recommendedCount: z.number(),
  })
  .passthrough();
export type InventoryCompareResult = z.infer<typeof InventoryCompareResultSchema>;

// ---------------------------------------------------------------------------
// Quote compare — GET /api/profiles/:id/quote-compare: the deterministic compare
// ranker payload (finance + lease buckets, both always present, gated by the
// profile's financing preference). Each ranked row carries OTD + the
// preformatted APR/MF + down/DAS + monthly + the latest-audit flag codes; NO
// budget anywhere. A tolerant (passthrough) shape keeps extra server fields.
// ---------------------------------------------------------------------------

export const QuoteCompareRowSchema = z
  .object({
    rank: z.number(),
    dealer_id: z.string(),
    dealer_name: z.string(),
    otd_total: z.number().nullable(),
    apr_or_mf: z.string(),
    down_or_das: z.number().nullable(),
    monthly: z.number().nullable(),
    audit_flag_summary: z.array(z.string()),
    financing_mode: z.string(),
  })
  .passthrough();
export type QuoteCompareRow = z.infer<typeof QuoteCompareRowSchema>;

export const QuoteCompareResultSchema = z
  .object({
    financingPreference: z.string().nullable(),
    finance: z.array(QuoteCompareRowSchema),
    lease: z.array(QuoteCompareRowSchema),
    totalRanked: z.number(),
  })
  .passthrough();
export type QuoteCompareResult = z.infer<typeof QuoteCompareResultSchema>;

// ---------------------------------------------------------------------------
// Skills manifest — GET /api/skills. routes.ts:78-86 (SKILL_MANIFEST), returned
// as a single-element array (routes.ts:279).
// ---------------------------------------------------------------------------

export const SkillManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  summary: z.string(),
  inputs: z.array(z.string()),
  outputs: z.string(),
  sensitive: z.boolean(),
  // The registry's pin posture (snake_case on the wire) — drives the pre-launch
  // readiness gate: exempt (always launchable), pin_required (needs a true pin),
  // infer_ok (a pin OR an active profile suffices).
  profile_pin: z.enum(["exempt", "pin_required", "infer_ok"]),
  retries: z.number(),
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export const SkillListSchema = z.array(SkillManifestSchema);
export type SkillList = z.infer<typeof SkillListSchema>;

// ---------------------------------------------------------------------------
// Mode — GET /api/mode → { active_db, data_dir, demo }. `demo` is true in the
// zero-config sample-world mode (the isolated demo DB) and drives the
// persistent demo banner.
// ---------------------------------------------------------------------------

export const ModeSchema = z.object({
  active_db: z.string(),
  data_dir: z.string(),
  demo: z.boolean(),
});
export type Mode = z.infer<typeof ModeSchema>;

// ---------------------------------------------------------------------------
// Settings / keys — the four user-supplied API keys + the Gmail slot.
//   GET    /api/settings/keys              presence ONLY (never a value)
//   POST   /api/settings/keys {id,value}   store a key  → { ok: true }
//   DELETE /api/settings/keys/:id          clear a key  → 204
//   POST   /api/settings/keys/:id/test {value}          → { ok, detail }
// A failed probe is STILL a 200 carrying { ok:false, detail } — only a
// malformed request (unknown id / missing value) is a non-2xx.
// ---------------------------------------------------------------------------

/** The four managed key ids (the stable wire ids the routes accept). */
export const SECRET_KEY_IDS = ["deepseek", "anthropic", "openai", "google_places"] as const;
export type SecretKeyId = (typeof SECRET_KEY_IDS)[number];

/** GET /api/settings/keys — the per-id presence map + the Gmail connection slot.
 *  Presence is boolean: a configured key is `present:true`, the value never
 *  rides the wire. */
export const KeyPresenceResponseSchema = z.object({
  deepseek: z.object({ present: z.boolean() }),
  anthropic: z.object({ present: z.boolean() }),
  openai: z.object({ present: z.boolean() }),
  google_places: z.object({ present: z.boolean() }),
  gmail: z.object({ connected: z.boolean() }),
});
export type KeyPresenceResponse = z.infer<typeof KeyPresenceResponseSchema>;

/** POST /api/settings/keys → { ok:true } on a stored key. */
export const SaveKeyAckSchema = z.object({ ok: z.literal(true) });
export type SaveKeyAck = z.infer<typeof SaveKeyAckSchema>;

/** POST /api/settings/keys/:id/test → the probe verdict (ok + a readable
 *  detail; a failed probe is ok:false, never the key itself). */
export const KeyProbeResultSchema = z.object({
  ok: z.boolean(),
  detail: z.string(),
});
export type KeyProbeResult = z.infer<typeof KeyProbeResultSchema>;

// ---------------------------------------------------------------------------
// Settings / environment — the curated, UI-managed operational env vars + the
// read-only status/path rows.
//   GET /api/settings/env             → { vars: EnvVarState[] }  current values
//   PUT /api/settings/env {id,value}  → { ok:true, vars: EnvVarState[] }
// The server returns the WHOLE curated set as an array (one EnvVarState per
// curated id), and the PUT echoes the refreshed set after a write. Only the two
// editable ids are writable; the read-only rows are reported, never accepted on
// PUT (the server rejects an attempt to set them). EnvVarState mirrors the store
// descriptor + its effective `value` exactly — flat, all-required.
// ---------------------------------------------------------------------------

/** The editable env ids the route accepts on PUT. */
export const ENV_EDITABLE_IDS = ["gmail_backend", "gmail_account", "chrome_headless"] as const;
export type EnvEditableId = (typeof ENV_EDITABLE_IDS)[number];

/** One curated env-var row with its current effective value — mirrors the store
 *  EnvVarState (descriptor fields + the projected `value`). `allowedValues` is
 *  the enum/bool list or null (path / free status rows); `default` is the
 *  descriptor default or null. Flat + all-required per the wire convention. */
export const EnvVarStateSchema = z.object({
  id: z.string(),
  envVar: z.string(),
  classification: z.enum([
    "editable-enum",
    "editable-bool",
    "editable-text",
    "read-only-status",
    "read-only-path",
  ]),
  editable: z.boolean(),
  allowedValues: z.array(z.string()).nullable(),
  default: z.string().nullable(),
  label: z.string(),
  tooltip: z.string(),
  value: z.string(),
});
export type EnvVarState = z.infer<typeof EnvVarStateSchema>;

/** GET /api/settings/env → the whole curated set. */
export const EnvConfigResponseSchema = z.object({
  vars: z.array(EnvVarStateSchema),
});
export type EnvConfigResponse = z.infer<typeof EnvConfigResponseSchema>;

/** PUT /api/settings/env → { ok:true } + the refreshed curated set. */
export const SetEnvAckSchema = z.object({
  ok: z.literal(true),
  vars: z.array(EnvVarStateSchema),
});
export type SetEnvAck = z.infer<typeof SetEnvAckSchema>;

/** PUT body — one editable id + its new string value (the enum value, or "1"/"0"
 *  for the bool toggle; the server narrows + validates by id). */
export interface SetEnvBody {
  id: EnvEditableId;
  value: string;
}

// ---------------------------------------------------------------------------
// Digest — GET /api/digest[?profile_id=…] → DigestView. The daily-digest skill
// (deterministic, zero-LLM) writes the "digest" data family; the page is a PURE
// projection of these server-computed fields (no client-side sort/format/
// freshness classification). The server pre-sorts each profile's quotes
// OTD-ascending and marks exactly one row `isBest` when there are quotes.
//
// Budget red-line: the view carries NO budget field. OTD dollars (`otdTotal`)
// are the user's OWN collected offers — rendered; budget is never on the wire,
// and the page renders only the internal-only `budget-lock` chip.
// ---------------------------------------------------------------------------

/** One dealer's quote row in a profile's OTD-ascending list. `otdTotal` is a
 *  dollar figure (the user's own offer) or null when no OTD has landed; the
 *  server pre-classifies `freshness` and marks the single best row. */
export const DigestViewQuoteRowSchema = z.object({
  quoteId: z.string(),
  dealerId: z.string(),
  dealerName: z.string(),
  otdTotal: z.number().nullable(),
  financingMode: z.string(),
  freshness: z.enum(["fresh", "stale", "missing"]),
  isBest: z.boolean(),
});
export type DigestViewQuoteRow = z.infer<typeof DigestViewQuoteRowSchema>;

/** One active search's digest section — the dealer/thread tallies, the
 *  freshness mix, and the OTD-ascending quote rows. */
export const DigestViewProfileSchema = z.object({
  searchProfileId: z.string(),
  vehicle: z.string(),
  dealerCount: z.number(),
  boundDealerCount: z.number(),
  threadCount: z.number(),
  needsResponseCount: z.number(),
  unansweredQuestionCount: z.number(),
  totalQuotes: z.number(),
  bestOtd: z.number().nullable(),
  freshnessMix: z.object({
    fresh: z.number(),
    stale: z.number(),
    missing: z.number(),
  }),
  quotes: z.array(DigestViewQuoteRowSchema),
});
export type DigestViewProfile = z.infer<typeof DigestViewProfileSchema>;

/** One deterministic next-action prompt (no budget). */
export const DigestViewNextActionSchema = z.object({
  kind: z.string(),
  profileId: z.string(),
  vehicle: z.string(),
  count: z.number(),
  label: z.string(),
});
export type DigestViewNextAction = z.infer<typeof DigestViewNextActionSchema>;

/** GET /api/digest → the whole digest projection. `profiles: []` ⇒ empty state
 *  (state `_NO_ACTIVE_SEARCHES`). `generatedAt` is always populated (the
 *  stamp always renders). `headline` carries no budget. */
export const DigestViewSchema = z.object({
  empty: z.boolean(),
  state: z.enum(["_NO_ACTIVE_SEARCHES", "ok"]),
  generatedAt: z.string(),
  headline: z.string(),
  overallBestOtd: z.number().nullable(),
  nextActions: z.array(DigestViewNextActionSchema),
  profiles: z.array(DigestViewProfileSchema),
});
export type DigestView = z.infer<typeof DigestViewSchema>;
