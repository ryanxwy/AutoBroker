/**
 * skills/sessionConsistency — the plan-3 full-journey session-consistency soak
 * driver (the buyer drives the WHOLE pinned-session pipeline by NATURAL LANGUAGE
 * through the product NL router, gates answered by BUTTONS).
 *
 * A SELF-CONTAINED per-skill soak module. It imports plan-0's FROZEN shared infra
 * (startSoakHost / captureMutationBaseline from orchestrator, the UiDriver verbs,
 * spawnClaudeAgent for the buyer + the Opus judge, combineSoakVerdict, the ledger)
 * and the plan-3 assertion lib (sessionConsistency.assertions). It NEVER edits a
 * shared file — the verdict id space is OPEN by design, so the plan-3 assertions
 * declare their OWN assertionId strings + severity and fold via the frozen
 * combineSoakVerdict. The SUT is READ-ONLY: this driver only OBSERVES App.tsx /
 * quotePipeline.ts / skillRuns.ts / router.ts via the live HTTP + DOM surfaces.
 *
 * THE CORE ABSTRACTION — driveMode: "nl" | "slash":
 *  - "nl"  (the real-user way): each skill is launched by typing NATURAL LANGUAGE
 *          into the chat rail (driver.typeInChatRail(<prose>)). The product router
 *          (POST /api/route, commit 8863d11) classifies the prose → the right skill
 *          and launches it through the EXACT existing start path. The journey records
 *          the router's chosen skill per NL turn (off routing.skill_id) → the
 *          deterministic routing-accuracy assertion. Cold-start intake is the buyer's
 *          freeform; every subsequent skill is ALSO NL. HITL is answered ONLY via
 *          gate BUTTONS, never chat text.
 *  - "slash" (the deterministic path): each skill is launched by typing "/skill"
 *          into the SAME rail (driver.typeInChatRail("/dealer_geosearch")). The
 *          slash bypasses the router (App.onSlash → doLaunchSkill). Routing-accuracy
 *          is not scored in slash mode (the router was never exercised).
 *
 * Both modes drive the SAME journey: intake → dealer_geosearch → inventory_site_scan
 * → dealer_inbox_check → quote_pipeline (the ~7-8 launches), one pinned browser =
 * one rail = one Mastra Memory thread for the whole journey.
 *
 * Two halves (mirrors skills/intake.ts + skills/dealerReplyExtract.ts):
 *  (1) the PURE assertion lib (sessionConsistency.assertions, unit-tested over a
 *      real isolated migrated tmp DB) — INV-1..INV-7 + projection + scrape-reap +
 *      journey-wide no_external_mutation + budget + routing-accuracy.
 *  (2) the LIVE drive lane (driveSessionConsistencyJourney): boot the isolated
 *      serverHost, spawn the claude buyer, drive the pinned journey in the given
 *      mode, answer the HITL via buttons, read the assertions off the isolated DB +
 *      the live surfaces, score the Opus coherence judge, append a replayable ledger
 *      row. The live lane (claude -p + Playwright + real DeepSeek) is NOT
 *      unit-tested — it mirrors orchestrator.runScenario / driveIntakeScenario
 *      (wired; live deferred to the e2e under `pnpm soak`).
 *
 * Dependency wall: harness layer. Read-only DB reads ride the @autobroker/db Db
 * handle (via openReadHandleAt) — NEVER better-sqlite3/drizzle directly; the ONE
 * playwright import is the UiDriver class; NO direct provider client.
 */

import { join } from "node:path";

import { openDb } from "@autobroker/db";

import { openReadHandleAt } from "../../dbReads.js";
import { applyDealerReplySeeds } from "../../seed.js";
import type { CaseSeedReply } from "../../cases.js";
import { UiDriver } from "../../uiDriver.js";
import { spawnClaudeAgent, type ClaudeAgentResult } from "../claudeAgent.js";
import { appendLedgerRow, buildSoakLedgerRow, type SoakRunTrace } from "../ledger.js";
import {
  BUYER_PROMPT,
  JUDGE_PROMPT,
  captureMutationBaseline,
  startSoakHost,
} from "../orchestrator.js";
import type { ScenarioClass } from "../taxonomy.js";
import {
  assertL1FuseArmed,
  assertNoExternalMutation,
  combineSoakVerdict,
  runJudge,
  type DeterministicResult,
  type JudgeDimId,
  type JudgeDimResult,
  type SoakVerdictDoc,
} from "../verdict.js";
import {
  assertLastRunIdCoherent,
  assertPinnedProfileStable,
  assertProjectionMatchesSnapshot,
  assertRoutingAccuracy,
  type LaunchObservation,
  type RoutingObservation,
  type SnapshotStatus,
} from "./sessionConsistency.assertions.js";

// ===========================================================================
// the journey step script (the version-controlled launch sequence)
// ===========================================================================

/** The drive mode — the core plan-3 abstraction. */
export type DriveMode = "nl" | "slash";

/** One launch in the journey: the skill it should reach + the NL prose a real
 *  buyer would type to get there (used in "nl" mode; "slash" mode types `/skillId`).
 *  `isIntake` marks the cold-start (a fresh-unpinned fork, never a pinned launch). */
export interface JourneyLaunch {
  skillId: string;
  /** The natural-language phrasing template a real buyer would type (nl mode). The
   *  buyer agent may rephrase; this is the deterministic fallback / intent anchor. */
  nlPhrasing: string;
  isIntake: boolean;
}

/** The canonical journey: cold-start intake → geosearch → inventory scan → inbox
 *  check → quote_pipeline (the ~7-8 launches the spec's happy-path-full-journey
 *  drives). Frozen + enumerable so coverage is measured, not luck. */
export const JOURNEY_LAUNCHES: readonly JourneyLaunch[] = [
  {
    skillId: "search_profile_intake",
    nlPhrasing:
      "I'm looking for a 2026 Hyundai Tucson SEL near Irvine, around $34k, financing — can you help me start a search?",
    isIntake: true,
  },
  {
    skillId: "dealer_geosearch",
    nlPhrasing: "Find the Hyundai dealers near me for this search.",
    isIntake: false,
  },
  {
    skillId: "inventory_site_scan",
    nlPhrasing: "Scan those dealers' inventory sites for matching Tucsons.",
    isIntake: false,
  },
  {
    skillId: "dealer_inbox_check",
    nlPhrasing: "Check my inbox for any dealer replies and pull in the new ones.",
    isIntake: false,
  },
  {
    skillId: "quote_pipeline",
    nlPhrasing: "Run the full quote pipeline over what we have so far.",
    isIntake: false,
  },
] as const;

/** The NL text to type for one launch in the given mode: the prose (nl) or the
 *  deterministic `/skillId` (slash). Pure. */
export function launchTextFor(launch: JourneyLaunch, mode: DriveMode): string {
  return mode === "nl" ? launch.nlPhrasing : `/${launch.skillId}`;
}

/** The intake form the orchestrator fills + submits after the cold-start prose
 *  renders the data_collection surface. The buyer's freeform prose seeds the
 *  vehicle/location; the orchestrator confirms the search the journey runs over.
 *  The PII keys are NEVER pre-filled (the never-guess invariant): phone stays
 *  blank → fake-phone default; email is the harness fixture address; NO budget
 *  goes in the form (budget never persists / never leaks — invariant #9). */
export const JOURNEY_FORM_FIELDS: Readonly<Record<string, unknown>> = {
  year: 2026,
  make: "Hyundai",
  model: "Tucson Hybrid",
  trim: "SEL",
  location_query: "Irvine, CA 92614",
  financing_preference: "finance",
  follow_up_email: "jordan.buyer@example.com",
} as const;

/** The "Year Make Model Trim" vehicle label the Searches popover row renders for
 *  the confirmed profile (mirrors apps/ui profileView.vehicleLabel — re-derived
 *  here from the form fields, NEVER imported across the layer wall). pinned the
 *  REAL way by this exact label. Pure — unit-tested. */
export function journeyVehicleLabel(): string {
  return [
    JOURNEY_FORM_FIELDS["year"],
    JOURNEY_FORM_FIELDS["make"],
    JOURNEY_FORM_FIELDS["model"],
    JOURNEY_FORM_FIELDS["trim"],
  ]
    .filter((p) => p !== null && p !== undefined && p !== "")
    .join(" ")
    .trim();
}

// ===========================================================================
// the deterministic journey-world seed (bound US dealers WITH websites +
// inventory listings + Sonnet-or-fixture dealer replies) — applied AFTER the
// live cold-start intake created the profile, scoped to its LIVE-created id.
//
// THE POINT of plan-3 is the session-consistency invariants + NL routing of
// each skill, NOT live data-gathering: so the consuming skills (geosearch /
// inventory_site_scan / dealer_inbox_check / quote_pipeline) get MATERIAL here
// WITHOUT driving live Google-Maps geosearch or live site-scraping. The reply
// half rides the SANCTIONED applyDealerReplySeeds (the same fake_mailbox +
// inbound-candidate corpus the dealer_reply_extract func cases use), so the
// inbox-check → quote_pipeline.extract child has real inbound quotes to chew.
//
// Wall-legal: this writes through @autobroker/db openDb (the one permitted DB
// channel seed.ts + the fixtures already use) into the run's ISOLATED tmp DB.
// ===========================================================================

/** One bound US dealer the journey seeds WITH a website (the inventory scan +
 *  inbox-check + targeted-VIN paths all need a bound dealer that has a site). */
export interface JourneyDealer {
  dealerId: string;
  name: string;
  website: string;
  distanceMiles: number;
}

/** One inventory listing the journey seeds (a VIN-carrying in-stock row → the
 *  inventory_site_scan candidates + the targeted-VIN OTD ask). */
export interface JourneyListing {
  listingId: string;
  dealerId: string;
  vin: string;
  stockNumber: string;
  trim: string;
}

/** The canonical journey world: 2 bound US dealers WITH websites + 2 in-stock
 *  VIN-carrying listings + 2 Sonnet-or-fixture dealer replies. Frozen so the
 *  consuming-skill material is deterministic (the soak's randomness is the buyer
 *  PHRASING, never the world). */
export const JOURNEY_DEALERS: readonly JourneyDealer[] = [
  { dealerId: "sc-jim-click", name: "Jim Click Hyundai", website: "https://www.jimclickhyundai.com", distanceMiles: 4.2 },
  { dealerId: "sc-precision", name: "Precision Hyundai", website: "https://www.precisionhyundai.com", distanceMiles: 6.8 },
] as const;

export const JOURNEY_LISTINGS: readonly JourneyListing[] = [
  { listingId: "sc-listing-1", dealerId: "sc-jim-click", vin: "5NMJBCAE0RH000001", stockNumber: "STK-7421", trim: "SEL" },
  { listingId: "sc-listing-2", dealerId: "sc-precision", vin: "5NMJBCAE0RH000002", stockNumber: "STK-9930", trim: "SEL" },
] as const;

/** The Sonnet-or-fixture dealer replies the inbox-check → quote_pipeline.extract
 *  reads. Budget-free quoted OTD prices (dealer-quoted prices are explicitly
 *  allowed; the buyer's private ceiling is never seeded). Default to a fixed
 *  pair; a live Sonnet dealer can substitute the body text (the world shape is
 *  frozen, the prose may vary). */
export function defaultJourneyReplies(): CaseSeedReply[] {
  return JOURNEY_DEALERS.map((d, i): CaseSeedReply => ({
    dealerName: d.name,
    dealerWebsite: d.website,
    from: `sales@${new URL(d.website).hostname.replace(/^www\./, "")}`,
    subject: "Re: 2026 Tucson Hybrid SEL — out-the-door numbers",
    body:
      i === 0
        ? "Thanks for reaching out! We have a 2026 Tucson Hybrid SEL in stock. " +
          "Selling price is 33,200 and your out-the-door comes to 35,500 with finance. " +
          "Happy to hold it for you."
        : "Good afternoon — we can do the 2026 Tucson Hybrid SEL at 32,900 selling, " +
          "36,100 out the door financed. Let me know if you'd like to move forward.",
    attachment: null,
  }));
}

export interface JourneySeedResult {
  dealers: number;
  listings: number;
  replyDealers: number;
  replyMessages: number;
}

/**
 * Seed the journey world into the ISOLATED run DB at `dbPath`, scoped to the
 * LIVE-created `profileId`. Two halves:
 *  (1) bound US dealers WITH websites + in-stock VIN listings — DIRECT openDb
 *      writes (idempotent ON CONFLICT), mirroring the fixtures' shape; this is
 *      the geosearch/inventory/targeted-VIN material WITHOUT a live scan.
 *  (2) the dealer replies — the SANCTIONED applyDealerReplySeeds (fake_mailbox +
 *      inbound candidate rows) the inbox-check → extract child consumes.
 * Pure-ish (opens + closes its own short-lived handle); unit-tested over a real
 * isolated migrated tmp DB.
 */
export function seedJourneyWorld(opts: {
  dbPath: string;
  profileId: string;
  dealers?: readonly JourneyDealer[];
  listings?: readonly JourneyListing[];
  replies?: readonly CaseSeedReply[];
}): JourneySeedResult {
  const dealers = opts.dealers ?? JOURNEY_DEALERS;
  const listings = opts.listings ?? JOURNEY_LISTINGS;
  const replies = opts.replies ?? defaultJourneyReplies();

  const db = openDb(opts.dbPath);
  let dealerCount = 0;
  let listingCount = 0;
  try {
    const insertDealer = db.$client.prepare(
      "INSERT INTO dealers (dealer_id, name, website, address, city, state, postal_code, distance_miles, country) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'US') ON CONFLICT(dealer_id) DO NOTHING",
    );
    const bind = db.$client.prepare(
      "INSERT INTO profile_dealers (search_profile_id, dealer_id, status) VALUES (?, ?, 'bound') " +
        "ON CONFLICT(search_profile_id, dealer_id) DO NOTHING",
    );
    const insertListing = db.$client.prepare(
      "INSERT INTO inventory_listings " +
        "(listing_id, search_profile_id, dealer_id, year, make, model, trim, vin, stock_number, " +
        "inventory_status, match_status, raw_listing_json, first_seen_at, last_seen_at, observed_at) " +
        "VALUES (?, ?, ?, 2026, 'Hyundai', 'Tucson Hybrid', ?, ?, ?, 'in_stock', 'exact', '{}', ?, ?, ?) " +
        "ON CONFLICT(listing_id) DO NOTHING",
    );
    for (const d of dealers) {
      const info = insertDealer.run(
        d.dealerId,
        d.name,
        d.website,
        `${d.distanceMiles} mi away, Irvine, CA`,
        "Irvine",
        "CA",
        "92614",
        d.distanceMiles,
      );
      if (info.changes > 0) dealerCount += 1;
      bind.run(opts.profileId, d.dealerId);
    }
    const now = Date.now();
    for (const l of listings) {
      const info = insertListing.run(
        l.listingId,
        opts.profileId,
        l.dealerId,
        l.trim,
        l.vin,
        l.stockNumber,
        now,
        now,
        now,
      );
      if (info.changes > 0) listingCount += 1;
    }
  } finally {
    db.$client.close();
  }

  // The reply corpus — the SANCTIONED inbound-candidate + fake_mailbox seeder
  // (CREATES its own dealers/threads/messages keyed off a deterministic per-reply
  // id, idempotent). These dealers are DISTINCT from the bound dealers above (the
  // reply seeder owns its own dealer ids), so the inbox-check sees real replies.
  const replyResult = applyDealerReplySeeds({ dbPath: opts.dbPath, profileId: opts.profileId, replies: [...replies] });

  return {
    dealers: dealerCount,
    listings: listingCount,
    replyDealers: replyResult.dealers,
    replyMessages: replyResult.messages,
  };
}

// ===========================================================================
// FOLLOW-UP 2 hardening — the bounded-promise guard (every live leg + judge +
// trace fetch is wrapped so a single `soak e2e` self-terminates under throttle)
// ===========================================================================

/** The hard wall-clock bound for the Opus judge spawn — a rate-limited judge
 *  fails fast (the best-effort catch keeps the deterministic verdict). The judge
 *  is a SOFT dim; it must NEVER hang the run. */
export const JUDGE_TIMEOUT_MS = 90_000;

/** The hard wall-clock bound for the journey trace fetch (buildRunDetail's
 *  unbounded HTTP drain must not hang the ledger write). */
export const TRACE_TIMEOUT_MS = 30_000;

/** A sentinel a bounded operation resolves to when it times out (vs a real
 *  value). The caller distinguishes the timeout from a genuine null result. */
export const BOUNDED_TIMEOUT = Symbol("bounded_timeout");

/**
 * Race a promise against a wall-clock timeout: resolve to the value if it
 * settles first, else the BOUNDED_TIMEOUT sentinel. A rejection inside `p` is
 * swallowed to the sentinel too (the caller's best-effort path handles both the
 * same way). The timer is unref'd so it can never keep the process alive. Pure +
 * unit-tested — this is the load-bearing "a single invocation always terminates"
 * guard for the live lane.
 */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
): Promise<T | typeof BOUNDED_TIMEOUT> {
  return Promise.race([
    p.catch(() => BOUNDED_TIMEOUT as T | typeof BOUNDED_TIMEOUT),
    new Promise<typeof BOUNDED_TIMEOUT>((resolve) => {
      const t = setTimeout(() => resolve(BOUNDED_TIMEOUT), ms);
      t.unref();
    }),
  ]);
}

// ===========================================================================
// the live-surface read helpers (READ-ONLY HTTP — the journey reads the product
// session / status projection / NL routing decision off the live server, never
// the DB directly for these; the DB channel is for the dbReads snapshot deltas).
// Every fetch is BOUNDED via withTimeout at the call site so a throttled server
// can never hang the journey. These are thin + unit-tested for shape.
// ===========================================================================

/** The session fields the journey invariants read (snake_case wire shape). */
export interface SessionState {
  id: string;
  lastRunId: string | null;
  pinnedProfileId: string | null;
}

/** Parse the GET /api/sessions/:id (or a /api/sessions list element) body into
 *  the SessionState the INV-1/INV-2 assertions consume. Pure. */
export function parseSessionState(body: Record<string, unknown>): SessionState {
  return {
    id: typeof body["id"] === "string" ? body["id"] : "",
    lastRunId: typeof body["last_run_id"] === "string" ? body["last_run_id"] : null,
    pinnedProfileId: typeof body["pinned_profile_id"] === "string" ? body["pinned_profile_id"] : null,
  };
}

/** Read the ONE session the cold-start created (the isolated DB starts empty, so
 *  GET /api/sessions lists exactly the journey's rail). Returns null when no
 *  session exists yet (cold-start did not record a run). BOUNDED via withTimeout
 *  by the caller. READ-ONLY. */
export async function readJourneySession(apiBase: string): Promise<SessionState | null> {
  const res = await fetch(`${apiBase.replace(/\/$/, "")}/api/sessions`, { method: "GET" });
  if (!res.ok) return null;
  const body = (await res.json()) as { sessions?: unknown } | unknown[];
  const list = Array.isArray(body)
    ? body
    : Array.isArray((body as { sessions?: unknown }).sessions)
      ? (body as { sessions: unknown[] }).sessions
      : [];
  // Newest-first: the single journey session is the head.
  const head = list[0];
  if (head === undefined || head === null || typeof head !== "object") return null;
  return parseSessionState(head as Record<string, unknown>);
}

/** Read one session by id (the per-boundary INV-1/INV-2 reads). BOUNDED by the
 *  caller. Returns null on 404 / non-OK. READ-ONLY. */
export async function readSessionById(apiBase: string, sessionId: string): Promise<SessionState | null> {
  const res = await fetch(
    `${apiBase.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(sessionId)}`,
    { method: "GET" },
  );
  if (!res.ok) return null;
  return parseSessionState((await res.json()) as Record<string, unknown>);
}

/** Read the projected product status for a run (GET /api/skill-runs/:id applies
 *  projectStatus server-side — INV-projection reads it, NOT a cross-layer import
 *  of the projector). BOUNDED by the caller. Returns null on 404. READ-ONLY. */
export async function readProjectedStatus(apiBase: string, runId: string): Promise<string | null> {
  const res = await fetch(
    `${apiBase.replace(/\/$/, "")}/api/skill-runs/${encodeURIComponent(runId)}`,
    { method: "GET" },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { status?: unknown };
  return typeof body["status"] === "string" ? body["status"] : null;
}

/** Map a projected product status onto the SnapshotStatus the INV-projection
 *  EXPECTED_PROJECTION table is keyed by (the reverse of the projection — the
 *  journey observes the projected status off the live run and pairs it with the
 *  snapshot truth the orchestrator knows it drove). Pure. */
export function snapshotTruthForProjected(projected: string | null): SnapshotStatus {
  switch (projected) {
    case "awaiting_approval":
      return "suspended";
    case "done":
      return "success";
    case "declined":
      return "success_declined";
    case "running":
      return "running";
    case "error":
      return "failed";
    default:
      return "running";
  }
}

// ===========================================================================
// the live drive lane (structurally complete; live-tested later)
// ===========================================================================

/** The judge dims this driver may activate (a subset of the frozen JUDGE_DIM_IDS —
 *  the buyer's step-to-step coherence + the dealer-reply extraction fidelity). */
const JOURNEY_JUDGE_DIMS: readonly JudgeDimId[] = ["buyer_coherence", "extraction_quality"];

export interface DriveJourneyOpts {
  scenario: ScenarioClass;
  /** The drive mode (the core abstraction): nl routes via the product router; slash
   *  uses the deterministic /skill path. */
  mode: DriveMode;
  /** Run root under ~/.autobroker-ts/soak-runs/<ts>/ (data dir + ledger live here). */
  runRoot: string;
  headless?: boolean;
  legTimeoutMs?: number;
}

export interface DriveJourneyResult {
  scenarioId: string;
  mode: DriveMode;
  verdict: SoakVerdictDoc;
  ledgerPath: string;
  buyerSessionId: string | null;
  /** The router's per-NL-turn decisions (empty in slash mode) — the routing-accuracy
   *  evidence persisted into the ledger / surfaced to the operator. */
  routingObservations: RoutingObservation[];
}

/**
 * Build the buyer's per-scenario journey task. The buyer.md role file (plan-0)
 * already constrains "emit text only, one vehicle, in character, no test-framework
 * language"; the task carries the journey edge-class intent + the drive mode (so
 * the buyer phrases natural prose in nl mode, never a literal slash).
 */
export function journeyBuyerTaskFor(scenario: ScenarioClass, mode: DriveMode): string {
  return [
    `Scenario class: ${scenario.className}.`,
    `What this stresses: ${scenario.stresses}`,
    `Drive mode: ${mode} (${mode === "nl" ? "type natural prose; the assistant routes it" : "the harness types /slash launches; you still narrate naturally"}).`,
    "",
    "Write the FIRST chat message a real car buyer would type to cold-start this",
    "search — freeform prose, ONE vehicle of interest, in character. Emit ONLY that",
    "message text — no JSON wrapper, no commentary, no slash command.",
  ].join("\n");
}

/**
 * Drive ONE session-consistency journey end-to-end (LIVE — boot host + spawn
 * claude + drive Playwright in the given mode). Structurally complete + wired;
 * mirrors orchestrator.runScenario / driveIntakeScenario. The per-launch gate
 * choreography (cold-start intake confirm → geosearch approve → inventory
 * batch_review → inbox batch_review → quote_pipeline fan-out / targeted approve)
 * + the per-INV reads are filled in against real DeepSeek under `pnpm soak`. NOT
 * unit-tested — the pure assertion lib (sessionConsistency.assertions) IS.
 *
 * THE MODE BRANCH (the core abstraction) is the launch helper: in "nl" mode each
 * launch is `driver.typeInChatRail(<prose>)` and the router's routing.skill_id is
 * recorded for the routing-accuracy assertion; in "slash" mode each launch is
 * `driver.typeInChatRail("/skillId")` (router not exercised). HITL is answered ONLY
 * via the gate-BUTTON verbs in BOTH modes (clickApprovalApprove/Deny,
 * decideBatchRow/clickBatchSubmit, decideInboxRow/clickInboxSubmit,
 * pickProfileStopOption/clickStopIntakeCta) — NEVER a chat-text answer to a gate.
 */
export async function driveSessionConsistencyJourney(
  opts: DriveJourneyOpts,
): Promise<DriveJourneyResult> {
  const dataDir = join(opts.runRoot, "data");
  const dbPath = join(dataDir, "autobroker.db");
  const ledgerPath = join(opts.runRoot, "ledger.jsonl");
  const legTimeoutMs = opts.legTimeoutMs ?? 180_000;

  // Pin the orchestrator's own in-process DB reads to the isolated db.
  process.env["AUTOBROKER_DB"] = dbPath;

  const host = await startSoakHost({ dataDir, dbPath });
  let driver: UiDriver | null = null;
  let buyer: ClaudeAgentResult | null = null;
  const deterministic: DeterministicResult[] = [];
  let judge: JudgeDimResult[] = [];
  const routingObservations: RoutingObservation[] = [];

  try {
    // L1-fuse anchor — the armed env recorded into the verdict for every scenario.
    deterministic.push(assertL1FuseArmed(host.env));

    // The single pinned browser (the orchestrator owns the one UiDriver = one rail
    // = one Mastra Memory thread for the WHOLE journey — the session-consistency
    // invariant).
    driver = await UiDriver.launch({
      baseUrl: host.apiBase,
      screenshotDir: join(opts.runRoot, "screenshots"),
      ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
    });

    // Spawn the buyer → GENERATE the freeform cold-start text (emit only). The
    // buyer/dealer claude children EMIT text; the orchestrator owns the one browser
    // + every gate button.
    buyer = await spawnClaudeAgent({
      rolePromptPath: BUYER_PROMPT,
      model: opts.scenario.buyerModel,
      task: journeyBuyerTaskFor(opts.scenario, opts.mode),
      timeoutMs: legTimeoutMs,
    });

    // Keystone baseline BEFORE the first launch.
    const baseline = captureMutationBaseline();

    // (cold-start) Type the buyer's freeform into the chat rail. In nl mode the
    // product router (POST /api/route) classifies it → intake; in slash mode the
    // cold-start would be /search_profile_intake — but a real cold start is always
    // freeform, so the cold-start types the buyer's prose in BOTH modes (the mode
    // branch starts at the SECOND launch). The intake form renders for human-confirm;
    // the orchestrator owns the gate buttons (fillRenderedForm + clickSubmit).
    await driver.typeInChatRail(buyer.generatedText);
    await driver.waitForIntakeForm(legTimeoutMs);

    // Drive the full multi-launch journey (intake confirm → geosearch → inventory
    // batch_review → inbox batch_review → quote_pipeline). The journey OBSERVES the
    // session/projection/routing off the live HTTP surfaces (every read BOUNDED via
    // withTimeout so a throttled server cannot hang). It is best-effort: a leg that
    // cannot reach its surface against real DeepSeek records the limitation and the
    // journey proceeds — the always-on keystone + L1-fuse + the per-INV assertions
    // it COULD score still fold into the verdict.
    const journey = await driveJourneyLaunches({
      driver,
      apiBase: host.apiBase,
      dbPath,
      mode: opts.mode,
      scenario: opts.scenario,
      legTimeoutMs,
    });
    routingObservations.push(...journey.routingObservations);
    deterministic.push(...journey.deterministic);

    const trace = await captureJourneyTrace(driver, host.apiBase);

    // The journey-wide keystone (read-only DB scan delta vs baseline) — emitted under
    // the canonical `no_external_mutation` id (the always-on floor every scenario
    // declares + combineSoakVerdict's BLOCKER set scores). At the END of the journey
    // the targeted-approve local dealer_quotes record is a legal fake-outbound write,
    // so the keystone scan opts into allowFakeOutbound once a send leg has fired.
    const { db, close } = openReadHandleAt(dbPath);
    try {
      deterministic.push(
        assertNoExternalMutation({ db, baseline, allowFakeOutbound: journey.sendLegFired }),
      );
    } finally {
      close();
    }

    // The soft-dim coherence judge (load-bearing for the buyer's step-to-step
    // coherence + the dealer-reply extraction fidelity ONLY; deterministic red-lines
    // stay authoritative). Activated when the scenario asks for it; the live lane
    // assembles the journey transcript as the judge's SUT view.
    //
    // extraction_quality is scored ONLY once the quote_pipeline extraction child
    // actually ran (it then has extracted dealer_quotes fields to judge). When NO
    // extraction ran (a journey that STOPped before extract, or a non-extract
    // scenario), asking the judge to rule on extraction would flip the verdict RED
    // on empty output (a category error) — so it stays gated OFF in that case.
    // buyer_coherence always scores the journey prose.
    const extractionRan = journey.extractionChildRan;
    const activeDims = (opts.scenario.judgeDims as JudgeDimId[])
      .filter((d) => JOURNEY_JUDGE_DIMS.includes(d))
      .filter((d) => !(d === "extraction_quality" && !extractionRan));
    if (activeDims.length > 0) {
      // BOUNDED judge spawn (FOLLOW-UP 2): a rate-limited Opus judge fails fast at
      // JUDGE_TIMEOUT_MS → the best-effort catch keeps the deterministic verdict. The
      // judge is a SOFT dim; it must NEVER hang or block the safety floor.
      const judged = await withTimeout(
        runJudge({
          judgePromptPath: JUDGE_PROMPT,
          scenarioIntent: opts.scenario.stresses,
          generatedText: buyer.generatedText,
          sutOutput: buildJourneyJudgeSutOutput({
            mode: opts.mode,
            routingObservations,
            extractedQuotes: journey.extractedQuotes,
          }),
          activeDims,
        }).catch((err: unknown) => {
          console.error(
            `soak e2e: judge unavailable (${err instanceof Error ? err.message : String(err)}) — deterministic verdict stands`,
          );
          return null;
        }),
        JUDGE_TIMEOUT_MS,
      );
      if (judged === BOUNDED_TIMEOUT) {
        console.error(`soak e2e: judge timed out after ${JUDGE_TIMEOUT_MS}ms — deterministic verdict stands`);
      } else if (judged !== null) {
        judge = judged.dims;
      }
    }

    const verdict = combineSoakVerdict({ deterministic, judge });

    const row = buildSoakLedgerRow({
      scenarioId: opts.scenario.id,
      className: opts.scenario.className,
      surface: opts.scenario.surface,
      role: "buyer",
      model: buyer.model ?? opts.scenario.buyerModel,
      generatedText: buyer.generatedText,
      contentHash: buyer.contentHash,
      claudeSessionId: buyer.claudeSessionId,
      costUsd: buyer.costUsd,
      rateLimited: buyer.rateLimited,
      trace,
      verdict: verdict.verdict,
      deterministicResults: verdict.deterministic,
      judgeResults: verdict.judge,
    });
    appendLedgerRow(ledgerPath, row);

    return {
      scenarioId: opts.scenario.id,
      mode: opts.mode,
      verdict,
      ledgerPath,
      buyerSessionId: buyer.claudeSessionId,
      routingObservations,
    };
  } finally {
    // Bounded teardown — Playwright's driver.close() and the host SIGTERM can wedge
    // AFTER the verdict + ledger are written; a soft-timeout race guarantees the CLI
    // returns (the entrypoint then process.exit's) instead of hanging on teardown +
    // orphaning the serverHost.
    const bounded = (p: Promise<unknown>, ms: number): Promise<unknown> =>
      Promise.race([
        p.catch(() => undefined),
        new Promise<void>((r) => {
          setTimeout(r, ms).unref();
        }),
      ]);
    if (driver !== null) await bounded(driver.close(), 6000);
    await bounded(host.stop(), 8000);
  }
}

/** One extracted dealer-quote field set the extraction-quality judge reads (the
 *  dollars the SUT recorded from a Sonnet/fixture reply — so the judge can rule on
 *  whether they reflect what the dealer wrote, with no hallucinated/dropped quote). */
export interface ExtractedQuoteView {
  dealerId: string | null;
  otdTotal: number | null;
  sellingPrice: number | null;
  financingMode: string | null;
}

// ===========================================================================
// the per-launch journey choreography (the FOLLOW-UP-1 multi-launch drive)
// ===========================================================================

/** The id of the live-created profile (read off the isolated DB after intake
 *  confirms — the resolver's SELECT_ACTIVE predicate, newest first by rowid since
 *  search_profiles carries no created_at). The isolated journey DB has exactly the
 *  one intake-created profile, so rowid-newest is the journey's profile. null when
 *  no active profile exists yet (intake declined / not confirmed). READ-ONLY. */
export function readNewestActiveProfileId(dbPath: string): string | null {
  const { db, close } = openReadHandleAt(dbPath);
  try {
    const row = db.$client
      .prepare(
        "SELECT search_profile_id AS id FROM search_profiles WHERE status = 'active' OR status IS NULL " +
          "ORDER BY rowid DESC LIMIT 1",
      )
      .get() as { id: string } | undefined;
    return row?.id ?? null;
  } finally {
    close();
  }
}

/** Read the extracted dealer_quotes for the profile (the extraction-quality judge
 *  view) — populated once the quote_pipeline extract child ran over the seeded
 *  replies. READ-ONLY. */
export function readExtractedQuotes(dbPath: string, profileId: string): ExtractedQuoteView[] {
  const { db, close } = openReadHandleAt(dbPath);
  try {
    const rows = db.$client
      .prepare(
        "SELECT dealer_id, otd_total, selling_price, financing_mode FROM dealer_quotes " +
          "WHERE search_profile_id = ? ORDER BY quote_id",
      )
      .all(profileId) as Array<{
      dealer_id: string | null;
      otd_total: number | null;
      selling_price: number | null;
      financing_mode: string | null;
    }>;
    return rows.map((r) => ({
      dealerId: r.dealer_id,
      otdTotal: r.otd_total,
      sellingPrice: r.selling_price,
      financingMode: r.financing_mode,
    }));
  } finally {
    close();
  }
}

/** The subsequent-launch sequence (everything AFTER the cold-start intake): the
 *  four pinned-session skills the journey drives in mode. The intake launch is the
 *  cold-start; these are the mode-branched launches. */
export const SUBSEQUENT_LAUNCHES: readonly JourneyLaunch[] = JOURNEY_LAUNCHES.filter((l) => !l.isIntake);

export interface DriveJourneyLaunchesArgs {
  driver: UiDriver;
  apiBase: string;
  dbPath: string;
  mode: DriveMode;
  scenario: ScenarioClass;
  legTimeoutMs: number;
}

export interface DriveJourneyLaunchesResult {
  /** The per-INV deterministic results the multi-launch journey scored LIVE. */
  deterministic: DeterministicResult[];
  /** The router's per-NL-turn decisions (empty in slash mode). */
  routingObservations: RoutingObservation[];
  /** Whether the quote_pipeline extraction child ran (→ extraction_quality scorable). */
  extractionChildRan: boolean;
  /** The extracted dealer_quotes the extraction-quality judge reads. */
  extractedQuotes: ExtractedQuoteView[];
  /** Whether a send/targeted-approve leg fired (→ the keystone scan allows the
   *  legal fake-outbound local record). */
  sendLegFired: boolean;
  /** A human note when a leg could not be driven against live external data. */
  limitations: string[];
}

/** Answer the HITL gate for one launch via the gate-BUTTON verbs (NEVER chat
 *  text). Best-effort + bounded: a gate that never renders (the live skill STOPped,
 *  or finished without a gate) is a no-op, not a throw. Returns whether a gate was
 *  answered. Each verb maps to the scenario's declared gate_verbs / the skill's
 *  natural gate. */
async function answerGateForLaunch(args: {
  driver: UiDriver;
  skillId: string;
  scenario: ScenarioClass;
  legTimeoutMs: number;
}): Promise<boolean> {
  const { driver, skillId, scenario, legTimeoutMs } = args;
  const verbs = new Set(scenario.gateVerbs);
  // A short gate-render wait: the gate either renders quickly or the run finished
  // without one. We never block the whole leg on a gate that will not come.
  const gateWaitMs = Math.min(legTimeoutMs, 60_000);
  try {
    if (skillId === "inventory_site_scan") {
      await driver.waitForBatchReviewCard(gateWaitMs);
      await driver.clickBatchSelectAll();
      await driver.clickBatchSubmit(gateWaitMs);
      return true;
    }
    if (skillId === "dealer_inbox_check") {
      await driver.waitForInboxReviewCard(gateWaitMs);
      await driver.clickInboxSelectAll();
      await driver.clickInboxSubmit(gateWaitMs);
      return true;
    }
    if (skillId === "quote_pipeline") {
      // The ONLY quote_pipeline HITL is the targeted-VIN SEND approval. A no-target
      // fan-out has no gate (it runs autonomously). Drive the approval only when the
      // scenario asked for it (approval_approve / approval_deny).
      if (verbs.has("approval_deny")) {
        await driver.waitForApprovalPrompt(gateWaitMs);
        await driver.clickApprovalDeny(gateWaitMs);
        return true;
      }
      if (verbs.has("approval_approve")) {
        await driver.waitForApprovalPrompt(gateWaitMs);
        await driver.clickApprovalApprove(gateWaitMs);
        return true;
      }
      return false;
    }
  } catch {
    // The gate did not render in the window — the live skill finished/STOPped
    // without it. Not a failure of the journey; the per-INV reads below capture
    // the actual terminal state.
    return false;
  }
  return false;
}

/**
 * Drive every launch AFTER the cold-start intake, in the journey's drive mode,
 * answering each HITL via gate BUTTONS. The CORE of FOLLOW-UP 1: confirm intake →
 * seed the journey world deterministically → pin the profile → drive geosearch →
 * inventory_site_scan → dealer_inbox_check → quote_pipeline, scoring INV-1
 * (lastRunId coherence/monotonic), INV-2 (pinnedProfileId stability), INV-projection
 * (projected status == snapshot truth per boundary), and routing-accuracy (nl mode)
 * LIVE.
 *
 * Best-effort + BOUNDED: every live HTTP read is wrapped in withTimeout so a
 * throttled server can never hang the journey; a leg that cannot reach its surface
 * records a limitation and the journey proceeds. The pure assertion lib stays
 * authoritative — this only OBSERVES the live surfaces and feeds the assertions.
 */
export async function driveJourneyLaunches(
  args: DriveJourneyLaunchesArgs,
): Promise<DriveJourneyLaunchesResult> {
  const { driver, apiBase, dbPath, mode, scenario, legTimeoutMs } = args;
  const deterministic: DeterministicResult[] = [];
  const routingObservations: RoutingObservation[] = [];
  const launchObservations: LaunchObservation[] = [];
  const projectionBoundaries: Array<{ snapshot: SnapshotStatus; projected: string }> = [];
  const launchScopedProfileIds: string[] = [];
  const pinReads: (string | null)[] = [];
  const limitations: string[] = [];
  let extractionChildRan = false;
  let sendLegFired = false;

  // ---- (1) confirm the cold-start intake (fillRenderedForm + clickSubmit) -----
  // The buyer's freeform seeded the form; the orchestrator confirms the search the
  // whole journey runs over. PII (phone) stays blank → fake-phone default; NO budget
  // is entered (never persists / never leaks).
  await driver.fillRenderedForm(JOURNEY_FORM_FIELDS);
  await driver.clickSubmit(legTimeoutMs);
  const intakeRunId = driver.currentRunId();
  try {
    await driver.waitForTerminal(legTimeoutMs);
  } catch {
    limitations.push("intake did not reach a terminal rendering in the leg window");
  }

  // The intake launch's lastRunId coherence (the cold-start recorded its run).
  const intakeSession = await withTimeout(readJourneySession(apiBase), TRACE_TIMEOUT_MS);
  const sessionId =
    intakeSession !== BOUNDED_TIMEOUT && intakeSession !== null ? intakeSession.id : null;
  if (intakeRunId !== null && intakeSession !== BOUNDED_TIMEOUT && intakeSession !== null) {
    launchObservations.push({ runId: intakeRunId, lastRunIdAfter: intakeSession.lastRunId });
  }

  // ---- (2) discover the live-created profile + SEED the journey world ---------
  const profileId = readNewestActiveProfileId(dbPath);
  if (profileId === null) {
    limitations.push("no active profile after intake — journey cannot seed/pin (intake declined or not confirmed)");
    // Score what we have (the intake launch coherence) and return; the keystone +
    // fuse still fold in the caller.
    if (launchObservations.length > 0) deterministic.push(assertLastRunIdCoherent(launchObservations));
    return { deterministic, routingObservations, extractionChildRan, extractedQuotes: [], sendLegFired, limitations };
  }
  // Seed bound US dealers WITH websites + inventory listings + Sonnet-or-fixture
  // replies (the consuming-skill MATERIAL, WITHOUT a live geosearch/site-scan).
  seedJourneyWorld({ dbPath, profileId });

  // ---- (3) pin the profile the REAL way (Searches popover) -------------------
  // The vehicle label the pinned row shows is the UI's "Year Make Model Trim"
  // (profileView.vehicleLabel); pinProfileInSearches fails LOUD on a zero/ambiguous
  // match, so we build the SAME label off the confirmed form fields.
  const pinLabel = journeyVehicleLabel();
  let pinnedProfileId: string | null = null;
  try {
    await driver.pinProfileInSearches(pinLabel, legTimeoutMs);
    const afterPin = await withTimeout(
      sessionId !== null ? readSessionById(apiBase, sessionId) : readJourneySession(apiBase),
      TRACE_TIMEOUT_MS,
    );
    pinnedProfileId =
      afterPin !== BOUNDED_TIMEOUT && afterPin !== null ? afterPin.pinnedProfileId : null;
  } catch (err) {
    limitations.push(
      `could not pin "${pinLabel}" via Searches (${err instanceof Error ? err.message : String(err)}) — pinned-stability not scored`,
    );
  }

  // ---- (4) drive each subsequent launch in mode, answering HITL via buttons --
  for (const launch of SUBSEQUENT_LAUNCHES) {
    const prevRunId = driver.currentRunId();
    const text = launchTextFor(launch, mode);

    // In NL mode each turn is classified by the product router (POST /api/route);
    // the launch happens through the SAME start path. We record the router's
    // chosen skill for the routing-accuracy assertion by reading the run's
    // descriptor after the route lands. In slash mode the router is bypassed.
    await driver.typeInChatRail(text);

    let runId: string | null = null;
    try {
      runId = await driver.waitForRunRoute(prevRunId, legTimeoutMs);
    } catch {
      // The turn did not start a new run (router clarified, or a STOP card rendered
      // without a run). Record the routing miss (nl) and continue.
      if (mode === "nl") {
        routingObservations.push({ nlText: text, expectedSkillId: launch.skillId, routedSkillId: null });
      }
      limitations.push(`launch "${launch.skillId}" did not start a run (clarify/STOP)`);
      continue;
    }

    if (mode === "nl") {
      // The router's chosen skill is the run's skill (read off the run summary's
      // skill id when present; fall back to the expected on a missing field — the
      // assertion still fails loud if the skill differs).
      const routed = await withTimeout(readRunSkillId(apiBase, runId), TRACE_TIMEOUT_MS);
      routingObservations.push({
        nlText: text,
        expectedSkillId: launch.skillId,
        routedSkillId: routed === BOUNDED_TIMEOUT ? null : routed,
      });
    }

    // INV-1: the session's last_run_id == the runId just started (recordRun).
    const sess = await withTimeout(
      sessionId !== null ? readSessionById(apiBase, sessionId) : readJourneySession(apiBase),
      TRACE_TIMEOUT_MS,
    );
    if (sess !== BOUNDED_TIMEOUT && sess !== null) {
      launchObservations.push({ runId, lastRunIdAfter: sess.lastRunId });
      pinReads.push(sess.pinnedProfileId);
    }

    // Answer the HITL gate (button-only) for this launch.
    const sawGate = await answerGateForLaunch({ driver, skillId: launch.skillId, scenario, legTimeoutMs });
    if (launch.skillId === "quote_pipeline" && sawGate) sendLegFired = true;

    // The terminal projected status (INV-projection: projected == snapshot truth).
    let terminalProjected: string | null = null;
    try {
      await driver.waitForTerminal(legTimeoutMs);
    } catch {
      limitations.push(`launch "${launch.skillId}" did not reach a terminal rendering`);
    }
    const proj = await withTimeout(readProjectedStatus(apiBase, runId), TRACE_TIMEOUT_MS);
    terminalProjected = proj === BOUNDED_TIMEOUT ? null : proj;
    if (terminalProjected !== null) {
      projectionBoundaries.push({
        snapshot: snapshotTruthForProjected(terminalProjected),
        projected: terminalProjected,
      });
    }

    // The launch's effective scope (the pinned profile is threaded as
    // search_profile_id on every non-intake launch — App.tsx pin-threading).
    launchScopedProfileIds.push(profileId);

    // Track whether the quote_pipeline extract child ran (the seeded replies →
    // dealer_quotes the extraction-quality judge reads).
    if (launch.skillId === "quote_pipeline") {
      const quotes = readExtractedQuotes(dbPath, profileId);
      if (quotes.length > 0) extractionChildRan = true;
    }
  }

  // ---- score the per-INV assertions the multi-launch journey could read LIVE --
  if (launchObservations.length > 0) {
    deterministic.push(assertLastRunIdCoherent(launchObservations));
  }
  if (pinnedProfileId !== null) {
    deterministic.push(
      assertPinnedProfileStable({ pinnedProfileId, pinReads, launchScopedProfileIds }),
    );
  }
  if (projectionBoundaries.length > 0) {
    deterministic.push(assertProjectionMatchesSnapshot(projectionBoundaries));
  }
  if (mode === "nl" && routingObservations.length > 0) {
    deterministic.push(assertRoutingAccuracy(routingObservations));
  }

  const extractedQuotes = extractionChildRan ? readExtractedQuotes(dbPath, profileId) : [];
  return { deterministic, routingObservations, extractionChildRan, extractedQuotes, sendLegFired, limitations };
}

/** Read a run's skill id off GET /api/skill-runs/:id (the router-chosen skill for
 *  the routing-accuracy assertion). BOUNDED by the caller. Returns null when the
 *  summary carries no skill field. READ-ONLY. */
export async function readRunSkillId(apiBase: string, runId: string): Promise<string | null> {
  const res = await fetch(
    `${apiBase.replace(/\/$/, "")}/api/skill-runs/${encodeURIComponent(runId)}`,
    { method: "GET" },
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { skill?: unknown; skill_id?: unknown };
  const skill = body["skill"] ?? body["skill_id"];
  return typeof skill === "string" ? skill : null;
}

/** Assemble the journey judge's SUT-output view: the drive mode + the router's
 *  per-NL-turn decisions + (when extraction ran) the extracted dealer_quotes the
 *  extraction-quality dim judges (the judge reasons about whether the buyer's prose
 *  drove a coherent journey AND whether the recorded quotes are faithful). Pure —
 *  unit-tested. */
export function buildJourneyJudgeSutOutput(args: {
  mode: DriveMode;
  routingObservations: readonly RoutingObservation[];
  extractedQuotes?: readonly ExtractedQuoteView[];
}): string {
  const parts: string[] = [];
  if (args.mode === "slash") {
    parts.push("drive mode: slash (deterministic /skill launches — the router was not exercised)");
  } else if (args.routingObservations.length === 0) {
    parts.push("drive mode: nl (no router decisions captured yet)");
  } else {
    const lines = args.routingObservations.map(
      (o) => `"${o.nlText.slice(0, 48)}…" → routed ${o.routedSkillId ?? "clarify"} (expected ${o.expectedSkillId})`,
    );
    parts.push(`drive mode: nl — router decisions:\n${lines.join("\n")}`);
  }
  if (args.extractedQuotes !== undefined && args.extractedQuotes.length > 0) {
    const lines = args.extractedQuotes.map(
      (q) => `dealer=${q.dealerId ?? "?"} otd=${q.otdTotal ?? "—"} selling=${q.sellingPrice ?? "—"} mode=${q.financingMode ?? "—"}`,
    );
    parts.push(`extracted dealer_quotes (the extraction-quality dim):\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

/** Drain the journey run trace off the rail's current run (the cold-start started
 *  one). Mirrors orchestrator.captureTrace; small + stable for the ledger row. The
 *  buildRunDetail HTTP drain is BOUNDED (FOLLOW-UP 2) — an unbounded SSE fetch
 *  against a throttled server could hang the ledger write; the timeout falls back
 *  to a minimal trace so the row is always written. */
async function captureJourneyTrace(driver: UiDriver, apiBase: string): Promise<SoakRunTrace | null> {
  const runId = driver.currentRunId();
  if (runId === null) return null;
  const { buildRunDetail } = await import("../../detail.js");
  const detail = await withTimeout(buildRunDetail(apiBase, runId), TRACE_TIMEOUT_MS);
  if (detail === BOUNDED_TIMEOUT) {
    return { runId, terminalStatus: null, eventCount: 0, sawApprovalGate: false, sawMalformedToolCall: false };
  }
  return {
    runId,
    terminalStatus: detail.terminalStatus,
    eventCount: detail.events.length,
    sawApprovalGate: detail.sawApprovalGate,
    sawMalformedToolCall: detail.sawMalformedToolCall,
  };
}
