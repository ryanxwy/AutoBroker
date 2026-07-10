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

import { AgentSelectionSchema, SkillRunStatusSchema, type AgentSelection } from "@autobroker/core";
import { z } from "zod";

/** The normalized, validated provider-selection payload (provider deepseek |
 *  anthropic). Re-exported from the wire boundary so the rail/App import the
 *  app-facing contract from one place; the server validates it with the SAME
 *  core `parseAgentSelection`. */
export type { AgentSelection } from "@autobroker/core";

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
// Status summary — GET /api/skill-runs/:id.
// apps/server/src/intakeRuns.ts (statusSummary return):
//   { run_id, skill, status: SkillRunStatus, pending: {step, decision_id}|null }.
// `status` is the product 7-value projection (core SkillRunStatusSchema). (The
// server also carries an `events` snapshot on this response; the AI-SDK uiStream
// path drives the rail, so the UI decodes only the status + pending it reads.)
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

// ---------------------------------------------------------------------------
// Route ack — POST /api/route (the NL skill-router). routes.ts returns a
// discriminated `routing` field: a LAUNCH (201, alongside run_id/session_id/
// scope_notice — the start-ack shape) or a CLARIFY (200, routing only, NO run).
// The client decodes the discriminant and the App dispatches: launch →
// bindAck+streamRun (today's path); clarify → a local assistant clarify turn.
// ---------------------------------------------------------------------------

/** The launch arm: the router chose a skill and the run is already started (the
 *  EXACT existing skillRuns.start path; every gate stays downstream). */
export const RouteLaunchSchema = z.object({
  kind: z.literal("launch"),
  skill_id: z.string(),
  confidence: z.number(),
  reason: z.string(),
});

/** The clarify arm: no run was started; the rail renders a local clarify turn
 *  with the reason + candidate skill hints. */
export const RouteClarifySchema = z.object({
  kind: z.literal("clarify"),
  reason: z.string(),
  candidates: z.array(z.object({ skillId: z.string(), why: z.string() })),
});

/** The full POST /api/route response. A launch additionally carries the
 *  start-ack fields (run_id/session_id/scope_notice); a clarify omits them. */
export const RouteAckSchema = z.object({
  run_id: z.string().optional(),
  session_id: z.string().nullable().optional(),
  scope_notice: IntakeScopeNoticeSchema.nullable().optional(),
  routing: z.discriminatedUnion("kind", [RouteLaunchSchema, RouteClarifySchema]),
});
export type RouteAck = z.infer<typeof RouteAckSchema>;

/** POST /api/route request body. `nl_input` is the user's free-form chat
 *  message; the optional session linkage mirrors the start body. */
export interface RouteRequestBody {
  nl_input: string;
  session_id?: string | null;
  from_session_id?: string | null;
  /** The UI's per-run provider selection (the AgentBar) — sent ONLY when dirty,
   *  honored by the router's classify call; omitted lets the default win. */
  agent?: AgentSelection;
}

/** POST /api/suggest-next-skills — the Hybrid skills-popover re-rank. The client
 *  sends the DETERMINISTIC candidate ids it already computed + a short recent
 *  conversation summary; the server re-orders WITHIN those ids and writes a
 *  reason each (advisory only — never launches, never widens the set). */
export interface SuggestRequestBody {
  session_id?: string | null;
  candidate_ids: string[];
  conversation: string;
}
export const SuggestNextAckSchema = z.object({
  suggestions: z.array(z.object({ skill_id: z.string(), reason: z.string() })),
});
export type SuggestNextAck = z.infer<typeof SuggestNextAckSchema>;

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
  /** The UI's per-run provider selection (the AgentBar). Sent ONLY when the user
   *  made an explicit selection (dirty); omitted otherwise so the server's
   *  env-default / policy default wins. The server validates it with
   *  `parseAgentSelection`. */
  agent?: AgentSelection;
  /** Per-skill start fields ride the same body (the server's StartBodySchema is
   *  non-strict; the skill's RunDescriptor.buildInput validates its own slice —
   *  e.g. dealer_geosearch's `search_profile_id`, the slash-args carrier). */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Chained-run announce — the run-stream metadata a completed /inventory_site_scan
// rides on its terminal channel to tell the client an /inventory_aggregator_scan
// sibling was auto-started for the same profile. It rides a `text` frame's
// payload as `chained_run` (apps/server SkillRunService.appendChainedRunAnnounce),
// so it needs no new wire kind; the client streams the sibling as its own turn.
// Tolerant of absence — an ordinary text frame carries no `chained_run`.
// ---------------------------------------------------------------------------

export const ChainedRunSchema = z.object({
  run_id: z.string(),
  skill: z.string(),
});
export type ChainedRun = z.infer<typeof ChainedRunSchema>;

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

/** POST /api/profiles/:id/purge ack — the irreversible hard-delete. `counts` is
 *  the per-table erase tally (only tables that had ≥1 row, plus
 *  `sessions_unpinned`). */
export const PurgeProfileAckSchema = z.object({
  ok: z.boolean(),
  counts: z.record(z.string(), z.number()),
});
export type PurgeProfileAck = z.infer<typeof PurgeProfileAckSchema>;

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
    quote_expires_at: z.string().nullable(),
    confidence: z.number().nullable(),
    inventory_status: z.string().nullable(),
    // Full price stack (money numerics; *_json carry the structured side-detail
    // as raw text — the detail modal renders the breakdown line items from these).
    msrp: z.number().nullable(),
    dealer_discount: z.number().nullable(),
    doc_fee: z.number().nullable(),
    dealer_fee: z.number().nullable(),
    sales_tax: z.number().nullable(),
    dmv_fees: z.number().nullable(),
    title_fee: z.number().nullable(),
    registration_fee: z.number().nullable(),
    license_fee: z.number().nullable(),
    other_fees_json: z.string().nullable(),
    rebates_json: z.string().nullable(),
    add_ons_json: z.string().nullable(),
    // Finance terms.
    finance_apr: z.number().nullable(),
    finance_term_months: z.number().nullable(),
    finance_down_payment: z.number().nullable(),
    finance_monthly_payment: z.number().nullable(),
    finance_amount_financed: z.number().nullable(),
    // Lease terms.
    lease_term_months: z.number().nullable(),
    lease_money_factor: z.number().nullable(),
    lease_residual_pct: z.number().nullable(),
    lease_residual_value: z.number().nullable(),
    lease_due_at_signing: z.number().nullable(),
    lease_monthly_payment: z.number().nullable(),
    lease_miles_per_year: z.number().nullable(),
    lease_acquisition_fee: z.number().nullable(),
    lease_disposition_fee: z.number().nullable(),
    lease_cap_cost_gross: z.number().nullable(),
    lease_cap_cost_adjusted: z.number().nullable(),
    lease_rent_charge: z.number().nullable(),
    // Source email (the quote's originating message; the message_id join key is
    // NOT projected — id red line). The detail modal shows the email it came from.
    source_subject: z.string().nullable(),
    source_body_text: z.string().nullable(),
    source_sender: z.string().nullable(),
    source_received_at: z.string().nullable(),
    // Latest audit's flag codes (raw; [] when unaudited). Lets the raw foldout
    // show pills for quotes the quote-compare buckets exclude (cash/unspecified).
    audit_flag_summary: z.array(z.string()).default([]),
  })
  .passthrough();
export type QuoteRow = z.infer<typeof QuoteRowSchema>;

export const QuoteListSchema = z.array(QuoteRowSchema);
export type QuoteList = z.infer<typeof QuoteListSchema>;

// ---------------------------------------------------------------------------
// Incentives — GET /api/profiles/:id/incentives: the manufacturer cash
// incentives scraped for the profile's vehicle (make/model/zip slice), freshest
// first. The Incentives canvas section renders these — the program type, the
// cash amount, the eligibility, the expiry, and a source-url provenance line.
// id is the React key only (never rendered); NO budget anywhere. A tolerant
// (passthrough) shape keeps extra server fields.
// ---------------------------------------------------------------------------

export const IncentiveRowSchema = z
  .object({
    id: z.number(),
    type: z.string().nullable(),
    amount: z.number().nullable(),
    expires: z.string().nullable(),
    eligibility: z.string().nullable(),
    scrape_source_url: z.string().nullable(),
    scraped_at: z.string().nullable(),
  })
  .passthrough();
export type IncentiveRow = z.infer<typeof IncentiveRowSchema>;

export const IncentiveListSchema = z.array(IncentiveRowSchema);
export type IncentiveList = z.infer<typeof IncentiveListSchema>;

// ---------------------------------------------------------------------------
// Inventory candidates — GET /api/profiles/:id/inventory-compare: the
// deterministic ranker payload (candidates + header tallies). Listings ≠
// quotes: these are public-website inventory candidates ranked against the
// profile, never negotiated out-the-door quotes. A passthrough candidate row
// keeps extra server fields tolerated; the panel reads the named columns it
// knows (full vin, stock_number, price, match_status chip, rank reasons,
// recommended flag).
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
    interior_color: z.string().nullable(),
    // The listing's public VDP href (or null) — the card's click-through target.
    listing_url: z.string().nullable(),
    listed_price: z.number().nullable(),
    msrp: z.number().nullable(),
    // The dealer's own LABELED market adjustment (markup) in dollars, or null.
    dealer_markup: z.number().nullable(),
    // Dealer add-on line items, parsed from pricing_breakdown_json; [] when none.
    add_ons: z.array(z.object({ label: z.string(), amount: z.number() })),
    // Sum of the add-on amounts in dollars, or null.
    addons_total: z.number().nullable(),
    // A LABELED dealer discount (off MSRP) in dollars, or null — folded LLM read.
    dealer_discount: z.number().nullable(),
    // A short verbatim manufacturer-incentive phrase, or null — folded LLM read.
    incentives_text: z.string().nullable(),
    // true when the price was hidden behind a "Get your price" CTA.
    price_gated: z.boolean(),
    // true ⇔ a price-stack region was actually read; false = "no breakdown captured".
    breakdown_parsed: z.boolean(),
    inventory_status: z.string(),
    dealer_id: z.string(),
    dealer_name: z.string().nullable(),
    distance_miles: z.number().nullable(),
    // Provenance from the source-row join: 'aggregator_srp' + the source host for
    // a shopping-site listing, both null for a dealer-site row. Drives the muted
    // "via {host}" line + the modal "Found on" row. Optional for older payloads.
    source_type: z.string().nullable().optional(),
    source_host: z.string().nullable().optional(),
    score: z.number(),
    reasons: z.array(z.string()),
    match_status: z.string(),
    /** true ⇔ match exact/near AND inventory in_stock/in_transit/unknown AND
     *  score >= 0.6. Set by the ranker as the SINGLE source; never re-derived on
     *  the client. An `unknown`-availability recommend carries a UI caveat. */
    recommended: z.boolean(),
  })
  .passthrough();
export type InventoryCandidateRow = z.infer<typeof InventoryCandidateRowSchema>;

/** One color-config cross-check advisory row — a loose preferred color the
 *  ranker's exact colorAxis won't match, plus the REAL stocked names to offer
 *  the buyer as a one-tap add (assist-not-autofill). compute.ts colorCrossCheck. */
export const InventoryColorCrossCheckItemSchema = z.object({
  requested: z.string(),
  suggestions: z.array(z.string()),
});
export type InventoryColorCrossCheckItem = z.infer<typeof InventoryColorCrossCheckItemSchema>;

export const InventoryCompareResultSchema = z
  .object({
    candidates: z.array(InventoryCandidateRowSchema),
    scannedAtMax: z.string().nullable(),
    totalListings: z.number(),
    recommendedCount: z.number(),
    // Scan provenance (optional for tolerance): dealer sites a site_scan reached
    // vs blocked. Drives the "scanned, found 0" vs "never scanned" empty-state.
    sourcesScanned: z.number().optional(),
    sourcesBlocked: z.number().optional(),
    // Shopping-site (Cars.com/visor.vin/Edmunds) scan provenance, counted separately from
    // dealer sites so the empty-state can name them plainly. Optional for tolerance.
    shoppingSourcesScanned: z.number().optional(),
    shoppingSourcesBlocked: z.number().optional(),
    // # of same-(profile,VIN) rows collapsed across dealers in the projection
    // (the aggregator/dealer duplicate belt). Optional for tolerance.
    sameVinCollapsed: z.number().optional(),
    // Color config cross-check advisory: per loose preferred color the ranker's
    // EXACT colorAxis won't match, the real stocked names to offer (one-tap add).
    // Optional for tolerance of older payloads.
    colorCrossCheck: z.array(InventoryColorCrossCheckItemSchema).optional(),
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
    // The underlying dealer_quotes row id — the detail-modal lookup key (matches
    // a QuoteRow.quote_id from /quotes); the React key, never rendered.
    quote_id: z.string(),
    dealer_id: z.string(),
    dealer_name: z.string(),
    otd_total: z.number().nullable(),
    apr_or_mf: z.string(),
    down_or_das: z.number().nullable(),
    monthly: z.number().nullable(),
    audit_flag_summary: z.array(z.string()),
    financing_mode: z.string(),
    // Cross-state correctness (Phase 5): tax re-computed at the buyer's home
    // state, the normalized OTD, and the OTD-delta attribution vs the bucket
    // best. Optional for tolerance of older payloads.
    normalized_tax: z.number().nullable().optional(),
    normalized_otd: z.number().nullable().optional(),
    attribution: z
      .object({
        baseline_quote_id: z.string(),
        otd_delta: z.number(),
        sale_price_delta: z.number(),
        doc_fee_delta: z.number(),
        tax_delta: z.number(),
        incentive_delta: z.number(),
        other_delta: z.number(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type QuoteCompareRow = z.infer<typeof QuoteCompareRowSchema>;

export const QuoteCompareResultSchema = z
  .object({
    financingPreference: z.string().nullable(),
    finance: z.array(QuoteCompareRowSchema),
    lease: z.array(QuoteCompareRowSchema),
    /** Cash quotes ranked by OTD (populated for a cash-preference buyer; empty
     *  otherwise). Optional for tolerance of older payloads. */
    cash: z.array(QuoteCompareRowSchema).optional(),
    totalRanked: z.number(),
    /** The buyer's home (registration) state — the rate every quote's tax is
     *  normalized to. Optional for tolerance of older payloads. */
    homeState: z.string().nullable().optional(),
    /** The home-state sales/use tax rate (fraction, e.g. 0.0725). Optional. */
    homeStateTaxRate: z.number().nullable().optional(),
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
// Mode — GET /api/mode → { active_db, data_dir, demo, mode }. `demo` is true in
// the zero-config sample-world mode (the isolated demo DB) and drives the
// persistent demo banner. `mode` is the single AUTOBROKER_MODE posture
// ("buyer" = real product / can send; "test" = internal/safe) the TopBar toggle
// reflects + switches.
// ---------------------------------------------------------------------------

/** The two app postures (mirrors @autobroker/tools AppMode). */
export const AppModeSchema = z.enum(["buyer", "test"]);
export type AppMode = z.infer<typeof AppModeSchema>;

export const ModeSchema = z.object({
  active_db: z.string(),
  data_dir: z.string(),
  demo: z.boolean(),
  mode: AppModeSchema,
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

/** The five managed key ids (the stable wire ids the routes accept). `claude_oauth`
 *  is the Claude subscription token (CLAUDE_CODE_OAUTH_TOKEN) — presence-only, no
 *  probe (the backend skips its test). */
export const SECRET_KEY_IDS = ["deepseek", "anthropic", "openai", "google_places", "claude_oauth"] as const;
export type SecretKeyId = (typeof SECRET_KEY_IDS)[number];

/** GET /api/settings/keys — the per-id presence map + the Gmail connection slot.
 *  Presence is boolean: a configured key is `present:true`, the value never
 *  rides the wire. */
export const KeyPresenceResponseSchema = z.object({
  deepseek: z.object({ present: z.boolean() }),
  anthropic: z.object({ present: z.boolean() }),
  openai: z.object({ present: z.boolean() }),
  google_places: z.object({ present: z.boolean() }),
  claude_oauth: z.object({ present: z.boolean() }),
  gmail: z.object({ connected: z.boolean() }),
  /** The server's EFFECTIVE default agent selection (from AUTOBROKER_AGENT_PROVIDER),
   *  or null when unset. The AgentBar reflects this so its boxes show what will
   *  actually run (e.g. Claude under `/e2e-loop --provider claude`) instead of the
   *  hardcoded client default. Display-only — never marks the bar dirty. */
  agentDefault: AgentSelectionSchema.nullable().default(null),
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
export const ENV_EDITABLE_IDS = ["app_mode", "gmail_account", "chrome_headless", "per_dealer_record_cap"] as const;
export type EnvEditableId = (typeof ENV_EDITABLE_IDS)[number];

/** One curated env-var row with its current effective value — mirrors the store
 *  EnvVarState (descriptor fields + the projected `value`). `allowedValues` is
 *  the enum/bool list or null (path / free status / numeric rows); `default` is
 *  the descriptor default or null. Flat + all-required per the wire convention. */
export const EnvVarStateSchema = z.object({
  id: z.string(),
  envVar: z.string(),
  classification: z.enum([
    "editable-enum",
    "editable-bool",
    "editable-text",
    "editable-numeric",
    "read-only-status",
    "read-only-path",
  ]),
  editable: z.boolean(),
  allowedValues: z.array(z.string()).nullable(),
  default: z.string().nullable(),
  numericMin: z.number().nullable(),
  numericMax: z.number().nullable(),
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

// ---------------------------------------------------------------------------
// Portfolio — GET /api/portfolio → PortfolioView. The Phase-3 board reads ONE
// card per active search, seeded from the (portfolio-aware) digest projection
// PLUS the derived pipeline `stage` and the hot/warm/cold `health` dot. It is a
// PURE server projection — newest-first, all-active. The board groups cards by
// segment CLIENT-SIDE (segmentOf), and computes the header counts CLIENT-SIDE
// from cards + the approval inbox (so this view never needs run-state).
//
// Budget red-line (#9): NO budget field. `bestOtd` is the user's own collected
// offer (rendered); `city` is the search location label. Budget is never wired.
// ---------------------------------------------------------------------------

/** The six human pipeline stages, in flow order (Intake → … → Closeout). */
export const PORTFOLIO_STAGES = [
  "intake",
  "scan",
  "lead_submit",
  "awaiting_replies",
  "negotiation",
  "closeout",
] as const;
export const PortfolioStageSchema = z.enum(PORTFOLIO_STAGES);
export type PortfolioStage = z.infer<typeof PortfolioStageSchema>;

/** The hot/warm/cold dot (mirrors tools ProfileHealthLevel). */
export const PortfolioHealthSchema = z.enum(["hot", "warm", "cold"]);
export type PortfolioHealth = z.infer<typeof PortfolioHealthSchema>;

/** One portfolio card — vehicle + city + best-OTD + dealer count + last-activity
 *  + derived stage + health dot. NO budget (#9). `lastActivityAt` is ISO-8601 or
 *  null (a freshly-minted, never-touched search). */
export const PortfolioCardSchema = z.object({
  searchProfileId: z.string(),
  vehicle: z.string(),
  city: z.string(),
  dealerCount: z.number(),
  bestOtd: z.number().nullable(),
  lastActivityAt: z.string().nullable(),
  stage: PortfolioStageSchema,
  health: PortfolioHealthSchema,
  reasons: z.array(z.string()),
});
export type PortfolioCard = z.infer<typeof PortfolioCardSchema>;

/** GET /api/portfolio → the board projection. `cards: []` ⇒ empty state.
 *  `generatedAt` always renders. */
export const PortfolioViewSchema = z.object({
  empty: z.boolean(),
  generatedAt: z.string(),
  cards: z.array(PortfolioCardSchema),
});
export type PortfolioView = z.infer<typeof PortfolioViewSchema>;

// ---------------------------------------------------------------------------
// ApprovalInbox — GET /api/approvals → ApprovalItem[] (apps/server/src/portfolio/
// approvalInbox.ts ApprovalInbox.list()). The Phase-3 global "Needs you" widget
// reads every PARKED gate across ALL pipelines, keyed by
// (profileId, runId, decisionId), so a gate that parked in profile C surfaces
// while the user is focused on B. The widget ROUTES to the run (navigate
// /runs/:runId) — the existing per-run GateBannerHost then renders the actual
// card; the inbox never approves inline, never batch-approves. Read-only
// auto-scans never park, so they never appear. Budget is never wired (#9).
// ---------------------------------------------------------------------------

/** A budget-free summary block (the BatchReviewCard heading + label/value lines)
 *  carried on a parked gate. */
export const ApprovalSummarySchema = z.object({
  heading: z.string(),
  lines: z.array(z.object({ label: z.string(), value: z.string() })),
});
export type ApprovalSummary = z.infer<typeof ApprovalSummarySchema>;

/** One queue entry: a parked gate (`kind:"gate"`) with a decisionId to route to.
 *  `actionRequired` ranks irreversible sends first. */
export const ApprovalItemSchema = z.object({
  kind: z.literal("gate"),
  profileId: z.string().nullable(),
  runId: z.string(),
  decisionId: z.string(),
  skill: z.string(),
  reason: z.string(),
  actionRequired: z.boolean(),
  summary: ApprovalSummarySchema.optional(),
});
export type ApprovalItem = z.infer<typeof ApprovalItemSchema>;

export const ApprovalListSchema = z.array(ApprovalItemSchema);
export type ApprovalList = z.infer<typeof ApprovalListSchema>;

// ---------------------------------------------------------------------------
// Dealer negotiations — GET /api/profiles/:id/dealer-negotiations: the per-dealer
// negotiation grid (tools listProfileDealerNegotiations). One card per bound
// dealer, derived each read. dealer_id is the React key only (never rendered);
// the competing dealer is never NAMED — only the batna scalars. NO budget. A
// tolerant (passthrough) shape keeps a server field add from breaking decode.
// ---------------------------------------------------------------------------

export const DealerNegotiationRowSchema = z
  .object({
    dealer_id: z.string(),
    name: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    candidate_status: z.string().nullable(),
    lead_submission_count: z.number(),
    email_count: z.number(),
    // COUNT of this dealer's inbound messages whose extraction failed (the grid
    // always returns it; the board lights the extract-failed badge when >0).
    extract_failed_count: z.number(),
    quote_sent: z.boolean(),
    best_otd: z.number().nullable(),
    best_discount: z.number().nullable(),
    // Derived negotiation status + give-up verdict + batna gap (all optional for
    // tolerance — the grid reads them when present).
    negotiation_status: z.string().nullable().optional(),
    verdict: z.string().optional(),
    verdict_reason: z.string().optional(),
    batna_gap_usd: z.number().nullable().optional(),
  })
  .passthrough();
export type DealerNegotiationRow = z.infer<typeof DealerNegotiationRowSchema>;

export const DealerNegotiationListSchema = z.array(DealerNegotiationRowSchema);
export type DealerNegotiationList = z.infer<typeof DealerNegotiationListSchema>;

// ---------------------------------------------------------------------------
// Dealer negotiation detail — GET /api/profiles/:id/dealer-negotiations/:dealerId
// (tools readDealerNegotiationDetail). The modal's contacts + substantive replies
// + competing-OTD scalars (NO competitor name) + composed status/strategy/next
// steps. message_id/contact_id are React keys only; budget-redacted excerpts; NO
// budget. received_at is an ISO string OR an epoch-ms number. Tolerant passthrough.
// ---------------------------------------------------------------------------

export const NegotiationContactRowSchema = z
  .object({
    contact_id: z.string(),
    display_name: z.string().nullable(),
    email: z.string().nullable(),
    role: z.string().nullable(),
    is_primary_reply_target: z.boolean(),
  })
  .passthrough();
export type NegotiationContactRow = z.infer<typeof NegotiationContactRowSchema>;

export const NegotiationReplyRowSchema = z
  .object({
    message_id: z.string(),
    sender_name: z.string().nullable(),
    sender_email: z.string().nullable(),
    subject: z.string().nullable(),
    body_excerpt: z.string().nullable(),
    received_at: z.union([z.string(), z.number()]).nullable(),
  })
  .passthrough();
export type NegotiationReplyRow = z.infer<typeof NegotiationReplyRowSchema>;

export const DealerNegotiationDetailSchema = z
  .object({
    dealer_id: z.string(),
    name: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    website: z.string().nullable(),
    negotiation_status: z.string().nullable(),
    email_count: z.number(),
    quote_sent: z.boolean(),
    best_competing_otd: z.number().nullable(),
    batna_gap_usd: z.number().nullable(),
    status_line: z.string(),
    strategy: z.string(),
    next_steps: z.array(z.string()),
    contacts: z.array(NegotiationContactRowSchema),
    replies: z.array(NegotiationReplyRowSchema),
  })
  .passthrough();
export type DealerNegotiationDetail = z.infer<typeof DealerNegotiationDetailSchema>;

// GET /api/profiles/:id/dealer-negotiations/:dealerId/summary → the LLM
// negotiation-state summary. ALWAYS 200; { summary:null } on any degrade
// (emit-not-called / budget-belt / transport). Tolerant passthrough.
export const DealerNegotiationSummarySchema = z
  .object({
    summary: z.string().nullable(),
  })
  .passthrough();
export type DealerNegotiationSummary = z.infer<typeof DealerNegotiationSummarySchema>;
