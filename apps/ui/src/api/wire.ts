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
  retries: z.number(),
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export const SkillListSchema = z.array(SkillManifestSchema);
export type SkillList = z.infer<typeof SkillListSchema>;

// ---------------------------------------------------------------------------
// Mode — GET /api/mode. routes.ts:283-288 → { active_db, data_dir }.
// ---------------------------------------------------------------------------

export const ModeSchema = z.object({
  active_db: z.string(),
  data_dir: z.string(),
});
export type Mode = z.infer<typeof ModeSchema>;
