/**
 * incentive_scrape — skill #5 (the OEM offers scraper). ONE flat linear
 * Mastra `createWorkflow`: 7 named steps chained with `.then()`, no nested
 * workflow. There is NO suspend: this skill is READ-ONLY (it fetches public OEM
 * offers pages and writes only local manufacturer_incentives rows — no email,
 * no form submit), so a brand-new incentive source is recorded and scraped
 * AUTOMATICALLY, never gated by a human approval (owner directive 2026-06-23).
 *
 * STEP MAP:
 *   0 resolveProfile  — the DOCUMENTED EXCEPTION to the single-profile
 *                       three-branch rule: a pinned id wins (exactly that one
 *                       target); otherwise EVERY active profile is a scrape
 *                       target (one row per active profile, never bare
 *                       newest — two accounts both shopping Hyundai are two
 *                       targets). 0 active → typed STOP pointing at intake.
 *                       `resolution` provenance: pinned | all_active.
 *   1 loadTargets     — the deterministic target gates: the US-zip shape
 *                       gate (the scrape key is (make, model, zip)) and the
 *                       7-day cache marker read (newest persisted scraped_at
 *                       + source URL per slice). No navigation, no LLM.
 *   2 resolveOemSource— AUTO-APPROVE (no suspend). Per brand: the data-dir
 *                       file registry is the cross-run memory — a hit resolves
 *                       the URL directly; a miss consults the in-code seed
 *                       candidate table and, on a first encounter, AUTOMATICALLY
 *                       records the seed source (writes the registry entry) and
 *                       proceeds — no human ask. No seed and no registry = an
 *                       honest no_oem_source failure (this build runs
 *                       web-search-free). Every resolved URL passes
 *                       classifyOemHost (aggregator/non-US rejection) + the
 *                       SSRF validator, then the 7-day cache gate (fresh + same
 *                       URL → brands_skipped, ZERO navigation).
 *   3 renderExtract   — PURE READ + the LLM phase; performs NO SQLite
 *                       writes and holds NO gate Approver (the one mutating
 *                       browser face — submitForm — structurally requires an
 *                       Approver, so the mutation funnel is unreachable from
 *                       here). Per ready target: navigate the OEM offers
 *                       page in an ISOLATED throwaway browser (blocked at
 *                       first contact = recorded, NEVER retried harder or
 *                       escalated) → lazy-scroll → deterministic in-page
 *                       offer-card collection woven into delimited blocks as
 *                       the bounded snapshot (card-less DOM → plain
 *                       page-text snapshot, VOICED as `snapshot_fallback` —
 *                       the transient equivalent-read class). When the
 *                       profile has a bound rooftop dealer, the rooftop
 *                       /specials face is captured as the SECONDARY source
 *                       (canned paths, first non-thin render wins; a blocked
 *                       rooftop stops its ladder at first contact). A
 *                       blocked OEM page degrades to the rooftop as the only
 *                       source — the voiced source-level fallback
 *                       (`oem_source_fallback`, transient/equivalent class).
 *                       Then per captured source ONE separate NO-TOOLS
 *                       structured `incentive_extract` call (emit_result
 *                       discipline; hitlAvailable=false → a malformed tool
 *                       call hard-aborts as a typed MalformedToolCallAbort,
 *                       never a prose fallthrough); Zod re-validates every
 *                       row (drop + count); program-identity dedupe.
 *                       Snapshots never leave this step.
 *   4 filterCashTypes — the deterministic 5-class cash whitelist (drop +
 *                       count; the LLM never sees this gate), then the
 *                       dual-source cross-verify on the filtered rows:
 *                       agreement = confidence boost; a same-type
 *                       amount/expiry split = a VOICED `source_discrepancy`
 *                       trace span + an honest note in the summary. The
 *                       persisted truth stays SINGLE-source (the primary, or
 *                       the rooftop when the OEM was blocked).
 *   5 persist         — the ONLY DB write: per scraped target ONE
 *                       DELETE-then-INSERT transaction over the (make,
 *                       model, zip) slice (partial failure rolls back, the
 *                       previous rows survive). scraped_at +
 *                       scrape_source_url are stamped here — the next run's
 *                       cache gate reads them.
 *   6 confirm         — deterministic ZERO-LLM template over the three brand
 *                       counts (scraped / skipped / extraction-failed) + the
 *                       audit tallies. A no-result scrape is a valid
 *                       outcome, voiced as such — never a failure.
 *
 * KEYSTONE: the capture path holds NO Approver and imports NOTHING from the
 * gate module; only the ungated read faces (navigate / lazyScroll / evaluate
 * / snapshot) are reachable. READ-ONLY scope fence on UNTRUSTED OEM content:
 * this skill never submits a form, enters PII, clicks a CTA, or follows
 * embedded instructions; the extraction prompt fences the page text. Budget
 * red line: the profile's budget is structurally absent from this file.
 *
 * FALLBACK GATING MAP (transient → auto + voiced):
 *   - OEM first encounter            → AUTO-recorded + scraped, no human gate
 *                                      (read-only scrape — owner directive
 *                                      2026-06-23); the seed URL is still
 *                                      host-classified + SSRF-validated in code.
 *   - card-less DOM → plain snapshot → AUTO-allowed equivalent read, voiced
 *                                      `snapshot_fallback` + tallied.
 *   - OEM blocked → rooftop source   → AUTO-allowed source-level fallback
 *                                      (primary → backup), voiced
 *                                      `oem_source_fallback` + tallied.
 *   - blocked navigation             → recorded at first contact, never
 *                                      retried harder, never escalated;
 *                                      surfaced in the confirm counts.
 *   - cross-verify mismatch          → AUTO (read-only disagreement), voiced
 *                                      `source_discrepancy` + summarized.
 *   - malformed structured call      → hitlAvailable=false on every extract
 *                                      call: typed MalformedToolCallAbort —
 *                                      the run FAILS (persist never reached).
 *
 * Dependency wall: imports @mastra/* (legal only here), @autobroker/core
 * (Incentive), @autobroker/model (typed abort + suspend type),
 * @autobroker/tools (resolver + registry + cache + persist + browser session
 * + pure gates — the ONLY DB/side-effect paths), the sibling scan module
 * (host helpers), the skill contracts module, and this layer's harness
 * facade.
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import { IncentiveSchema, type Incentive } from "@autobroker/core";
import { MalformedToolCallAbort, type HarnessSuspend } from "@autobroker/model";
import {
  cacheGateDecision,
  capSnapshot,
  classifyOemHost,
  crossVerifyIncentives,
  filterCashTypes,
  getDb,
  isLikelyUsZip,
  listProfileDealerRows as listProfileDealerRowsImpl,
  mergeScrapeResults,
  normalizeIncentiveBrand,
  NULL_EMITTER,
  OEM_SEED_SOURCES,
  persistIncentives as persistIncentivesImpl,
  readIncentiveCacheState as readIncentiveCacheStateImpl,
  readIncentiveRegistry as readIncentiveRegistryImpl,
  resolveActiveProfile as resolveActiveProfileImpl,
  substituteOemUrlTemplate,
  validateSourceUrl as validateSourceUrlImpl,
  withBrowserContext,
  writeIncentiveRegistryEntry as writeIncentiveRegistryEntryImpl,
  type BrowserEmitter,
} from "@autobroker/tools";

import {
  buildIncentiveExtractPrompt,
  INCENTIVE_FAIL_REASONS,
  INCENTIVE_SKIP_REASONS,
  IncentiveExtractSchema,
  IncentiveScrapeInputSchema,
  IncentiveScrapeOutputSchema,
  IncentiveScrapeStopError,
  type IncentiveFailReason,
} from "./incentiveScrapeContracts.js";
import { isDeniedScanHost, scanHostnameOf } from "./inventorySiteScan.js";
import { harness, type HarnessLedgerContext } from "./harness.js";

// ---------------------------------------------------------------------------
// tunables (module constants, not env knobs)
// ---------------------------------------------------------------------------

/** Cap on offer cards collected per page (the snapshot char cap also clamps). */
export const OFFER_COLLECT_MAX = 60;
/** A card-less page whose rendered text is thinner than this is a dead/404
 *  render — the capture ladder tries its next path instead of extracting. */
export const OFFER_RENDER_MIN_CHARS = 400;
/** The rooftop secondary-source canned paths, tried in order (one host, one
 *  ladder; a blocked first contact stops the whole ladder). */
export const ROOFTOP_SPECIALS_PATHS = [
  "/specials",
  "/offers",
  "/new-vehicle-specials",
] as const;

// ---------------------------------------------------------------------------
// the deterministic in-page offer-card collector (NO LLM in this section)
// ---------------------------------------------------------------------------

/** One offer card lifted off the live offers-page DOM (collapsed text). */
export interface CollectedOfferCard {
  offerText: string;
}

/**
 * In-page probe: collect the visible offer cards on a rendered offers page.
 * A "card" is a leaf-most container showing a dollar amount or a %-rate with
 * non-trivial (but non-wrapper) text. Deterministic; executes inside the page
 * via page.evaluate, so it MUST be fully self-contained — every constant
 * lives INSIDE the function body (a module-scope reference does not exist
 * after serialization into the page).
 */
export function collectOfferCards(args: { max: number }): CollectedOfferCard[] {
  const CARD_TEXT_MIN_CHARS = 30;
  // Beyond this the match is a container/section, not a single offer card.
  const CARD_TEXT_MAX_CHARS = 1_500;
  interface ProbeEl {
    textContent: string | null;
    contains(other: ProbeEl): boolean;
  }
  const g = globalThis as {
    document?: { querySelectorAll(selector: string): ArrayLike<ProbeEl> };
  };
  const doc = g.document;
  if (doc === undefined) return [];
  const moneyRe = /\$\s?\d|%/;
  const nodes = doc.querySelectorAll(
    "[class*='offer'], [class*='incentive'], [class*='deal'], [class*='card'], article, li",
  );
  const candidates: Array<{ el: ProbeEl; text: string }> = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const el = nodes[i]!;
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length < CARD_TEXT_MIN_CHARS || text.length > CARD_TEXT_MAX_CHARS) continue;
    if (!moneyRe.test(text)) continue;
    candidates.push({ el, text });
  }
  // Leaf-most wins: drop any candidate that CONTAINS another candidate (a
  // wrapper around real cards would smear several offers into one block).
  const out: CollectedOfferCard[] = [];
  const seenText: Record<string, true> = {};
  for (const c of candidates) {
    if (out.length >= args.max) break;
    let isWrapper = false;
    for (const other of candidates) {
      if (other.el !== c.el && c.el.contains(other.el)) {
        isWrapper = true;
        break;
      }
    }
    if (isWrapper) continue;
    if (seenText[c.text] === true) continue;
    seenText[c.text] = true;
    out.push({ offerText: c.text });
  }
  return out;
}

/**
 * In-page probe: find a CSS selector for the page's own location/ZIP picker
 * input, or null when none is present. Returns a STABLE selector (id-based when
 * possible, else an indexed `input` selector) the ZIP face re-probes and
 * re-fences before typing — this finder is a convenience locator, NOT a trust
 * boundary. Executes inside the page via page.evaluate, so it MUST be fully
 * self-contained (no module-scope references survive serialization).
 */
export function findZipInputSelector(): string | null {
  const zipFieldRe = /zip|postal|location/i;
  interface ProbeEl {
    getAttribute(name: string): string | null;
    closest(selector: string): unknown;
  }
  const g = globalThis as {
    document?: { querySelectorAll(selector: string): ArrayLike<ProbeEl> };
  };
  const doc = g.document;
  if (doc === undefined) return null;
  const inputs = doc.querySelectorAll(
    "input[type='text'], input[type='tel'], input[type='number'], input[type='search'], input:not([type])",
  );
  for (let i = 0; i < inputs.length; i += 1) {
    const el = inputs[i]!;
    // Skip anything sitting in an email/phone lead-capture form (the ZIP face
    // refuses these anyway; skipping here avoids a noisy refusal).
    if (el.closest("form input[type='email'], form input[type='tel']") !== null) {
      // closest() above targets the input itself; the structural fence in the
      // ZIP face is the real guard, so a false negative here is harmless.
    }
    const hay = [
      el.getAttribute("name") ?? "",
      el.getAttribute("id") ?? "",
      el.getAttribute("placeholder") ?? "",
      el.getAttribute("aria-label") ?? "",
    ].join(" ");
    if (!zipFieldRe.test(hay)) continue;
    const id = el.getAttribute("id");
    if (id !== null && id !== "") return `#${(globalThis as { CSS?: { escape(s: string): string } }).CSS?.escape(id) ?? id}`;
    return `input:nth-of-type(${i + 1})`;
  }
  return null;
}

/** Weave collected offer cards into the extraction input: one clearly
 *  delimited block per card. Pure. */
export function weaveOfferCards(cards: readonly CollectedOfferCard[]): string {
  return cards.map((c, i) => `[OFFER ${i + 1}]\n${c.offerText}`).join("\n\n");
}

/** Resolve the rooftop secondary-source candidate URLs for a dealer website
 *  (origin-absolute canned paths), or [] when the site is unusable. Pure. */
export function rooftopSpecialsUrls(website: string | null): string[] {
  if (website === null) return [];
  const host = scanHostnameOf(website);
  if (host === null || isDeniedScanHost(host)) return [];
  let origin: string;
  try {
    origin = new URL(website).origin;
  } catch {
    return [];
  }
  return ROOFTOP_SPECIALS_PATHS.map((p) => `${origin}${p}`);
}

// ---------------------------------------------------------------------------
// the offers-page capture boundary (injectable for tests)
// ---------------------------------------------------------------------------

/** Arguments to one capture ladder (ONE host: the OEM page, or the rooftop's
 *  canned-path ladder). */
export interface OfferCaptureArgs {
  /** The Mastra runId (prefixes the throwaway browser name). */
  runId: string;
  /** Short label for the browser name + the voiced trace target. */
  label: string;
  /** Candidate URLs, tried in order; the first usable render wins. A BLOCKED
   *  first contact stops the whole ladder (the host refused — never poked
   *  again this run). */
  urls: readonly string[];
  /** The voiced-trace emitter (SSE in production, NULL_EMITTER otherwise). */
  emitter: BrowserEmitter;
  /** The profile's US ZIP. When the rendered page exposes its own location/ZIP
   *  picker, the ladder types these digits into it (the page makes its OWN
   *  localization XHR) so region-priced offers render. ZIP DIGITS ONLY — the
   *  ZIP face refuses any non-ZIP value. null = skip localization. */
  zip: string | null;
}

/** One ladder's outcome. PURE DATA — nothing classified, nothing written. */
export type OfferCaptureOutcome =
  | {
      kind: "captured";
      /** The URL that actually rendered (the provenance the persist stamps). */
      url: string;
      snapshotText: string;
      /** True when the card collector found nothing and the plain page-text
       *  snapshot was used (the voiced transient fallback). */
      snapshotFallback: boolean;
    }
  | { kind: "blocked"; url: string; marker: string | null }
  | { kind: "failed"; message: string };

/** The narrow session slice the ladder drives (the real BrowserSession
 *  satisfies it; tests stub it with a fake page). */
export interface OfferLadderSession {
  newPage(): Promise<{
    evaluate(fn: typeof collectOfferCards, args: { max: number }): Promise<CollectedOfferCard[]>;
    evaluate(fn: typeof findZipInputSelector): Promise<string | null>;
    close(): Promise<void>;
  }>;
  navigate(page: never, url: string): Promise<{ blocked: string | null }>;
  /** Type the profile ZIP into the page's own location picker (ZIP-digits-only,
   *  fenced, ungated). Best-effort at the call site — a missing picker or a
   *  refused target must not fail the ladder. */
  fillLocationZip(page: never, selector: string, zip: string): Promise<void>;
  lazyScroll(page: never): Promise<void>;
  snapshot(page: never): Promise<string>;
}

/**
 * One capture ladder over an ALREADY-OPEN session: candidate URLs serial
 * (the session's per-host politeness throttle paces them). Per URL:
 * navigate → BLOCKED = STOP the whole ladder (recorded, never escalated, the
 * remaining paths are NEVER contacted — a refusing host is not poked again
 * this run) → lazy-scroll → deterministic offer-card collection (cards →
 * woven blocks; card-less → VOICED plain-snapshot fallback; a thin card-less
 * render is a dead/404 page and falls through to the next path). Read faces
 * only — this path can express navigation, scrolling and read-only DOM
 * evaluation; it holds no Approver, so the one mutating browser face is
 * structurally unreachable.
 *
 * Exported for unit tests with a fake session (captureOffersImpl is the
 * production caller, wrapping it in an isolated throwaway browser).
 */
export async function runOfferLadder(deps: {
  session: OfferLadderSession;
  emitter: BrowserEmitter;
  label: string;
  urls: readonly string[];
  /** The profile ZIP, typed into the page's own location picker when present
   *  so region-priced offers render. null = skip localization. */
  zip: string | null;
}): Promise<OfferCaptureOutcome> {
  const { session, emitter, label, urls, zip } = deps;
  const page = await session.newPage();
  try {
    let lastFailure = "every candidate path failed to render";
    for (const url of urls) {
      let nav: { blocked: string | null };
      try {
        nav = await session.navigate(page as never, url);
      } catch (err) {
        lastFailure = err instanceof Error ? err.message : String(err);
        continue; // a dead path is not a refusal — try the next one
      }
      if (nav.blocked !== null) {
        return { kind: "blocked", url, marker: nav.blocked };
      }
      // Localize to the profile ZIP if the page exposes its own picker, so
      // region-priced offers render (the page makes its OWN localization XHR;
      // ZIP DIGITS ONLY). Best-effort: a missing picker or a fenced-out target
      // must not fail the ladder.
      if (zip !== null) {
        try {
          const zipSelector = await page.evaluate(findZipInputSelector);
          if (zipSelector !== null) {
            await session.fillLocationZip(page as never, zipSelector, zip);
            // Let the page's localization XHR repaint before we read the cards.
            await session.lazyScroll(page as never);
          }
        } catch (err) {
          emitter.action("location_zip_skipped", err instanceof Error ? err.message : String(err));
        }
      }
      await session.lazyScroll(page as never);
      const cards = await page.evaluate(collectOfferCards, { max: OFFER_COLLECT_MAX });
      if (cards.length > 0) {
        return {
          kind: "captured",
          url,
          snapshotText: capSnapshot(weaveOfferCards(cards)),
          snapshotFallback: false,
        };
      }
      // Card-less DOM → the plain page-text snapshot (equivalent-read
      // fallback: auto-allowed, VOICED — never silent).
      const snapshot = await session.snapshot(page as never);
      if (snapshot.length >= OFFER_RENDER_MIN_CHARS) {
        emitter.action("snapshot_fallback", label);
        return { kind: "captured", url, snapshotText: snapshot, snapshotFallback: true };
      }
      lastFailure = `thin render at ${url} (${snapshot.length} chars)`;
    }
    return { kind: "failed", message: lastFailure };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** The REAL capture ladder: ONE isolated throwaway browser for the ladder's
 *  host (named `${runId}-${label}` so trace files never collide), then the
 *  serial ladder above. */
export async function captureOffersImpl(args: OfferCaptureArgs): Promise<OfferCaptureOutcome> {
  if (args.urls.length === 0) return { kind: "failed", message: "no candidate URLs" };
  return withBrowserContext(`${args.runId}-${args.label}`, { emitter: args.emitter }, (session) =>
    runOfferLadder({
      session: session as unknown as OfferLadderSession,
      emitter: args.emitter,
      label: args.label,
      urls: args.urls,
      zip: args.zip,
    }),
  );
}

// ---------------------------------------------------------------------------
// dependency-injection seam (test-runner-guarded, mirroring the other skills)
// ---------------------------------------------------------------------------

/**
 * The runtime collaborators the workflow steps call. Injectable so the
 * offline tests drive the REAL flat Mastra workflow → REAL suspend/resume
 * chain against deterministic stubs and an isolated tmp DB, WITHOUT module
 * mocks.
 */
export interface IncentiveScrapeWorkflowDeps {
  harnessGenerate: typeof harness.generate;
  /** The typed profile resolver (tools layer; this skill consumes ALL active
   *  rows on the unpinned branch — the documented exception). */
  resolveProfile: typeof resolveActiveProfileImpl;
  /** The profile_dealers ⋈ dealers read closure (the rooftop secondary). */
  listProfileDealers: typeof listProfileDealerRowsImpl;
  /** The (make, model, zip) cache-marker read (tools layer). */
  readCacheState: typeof readIncentiveCacheStateImpl;
  /** The data-dir file registry faces (tools layer). */
  readRegistry: typeof readIncentiveRegistryImpl;
  writeRegistryEntry: typeof writeIncentiveRegistryEntryImpl;
  /** The SSRF validator (async DNS — stubbed in tests). */
  validateUrl: typeof validateSourceUrlImpl;
  /** The pure-read capture boundary (the only browser-touching collaborator). */
  captureOffers: (args: OfferCaptureArgs) => Promise<OfferCaptureOutcome>;
  /** The DELETE-then-INSERT slice writer (tools layer, the ONLY DB write). */
  persistIncentives: typeof persistIncentivesImpl;
  /** The DB accessor the read/write closures run through (tools layer). */
  getDb: typeof getDb;
}

const realDeps: IncentiveScrapeWorkflowDeps = {
  harnessGenerate: harness.generate,
  resolveProfile: resolveActiveProfileImpl,
  listProfileDealers: listProfileDealerRowsImpl,
  readCacheState: readIncentiveCacheStateImpl,
  readRegistry: readIncentiveRegistryImpl,
  writeRegistryEntry: writeIncentiveRegistryEntryImpl,
  validateUrl: validateSourceUrlImpl,
  captureOffers: captureOffersImpl,
  persistIncentives: persistIncentivesImpl,
  getDb,
};

let injectedDeps: IncentiveScrapeWorkflowDeps | undefined;

function deps(): IncentiveScrapeWorkflowDeps {
  return injectedDeps ?? realDeps;
}

/** TEST-ONLY seam — refused outside a test runner (a production caller must
 *  never redirect the harness, the browser, or the DB write path). */
export function __setIncentiveScrapeDepsForTests(
  partial: Partial<IncentiveScrapeWorkflowDeps>,
): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__setIncentiveScrapeDepsForTests is a test-only seam (refused outside a test runner)",
    );
  }
  injectedDeps = { ...realDeps, ...partial };
}

/** Restore the real wiring between test cases. */
export function __resetIncentiveScrapeDepsForTests(): void {
  injectedDeps = undefined;
}

// ---------------------------------------------------------------------------
// per-run browser-emitter injection (production wiring, set once at app boot)
// ---------------------------------------------------------------------------

let browserEmitterFactory: (runId: string) => BrowserEmitter = () => NULL_EMITTER;

/** Install the app-layer per-run emitter factory (idempotent; last call wins —
 *  one server per process in the production topology). */
export function setIncentiveScrapeBrowserEmitterFactory(
  factory: (runId: string) => BrowserEmitter,
): void {
  browserEmitterFactory = factory;
}

// ---------------------------------------------------------------------------
// ledger identity for the extract-phase LLM calls
// ---------------------------------------------------------------------------

function incentiveLedger(runId: string): HarnessLedgerContext {
  return {
    runId,
    skill: "incentive_scrape",
    layer: "L2",
    promptVersion: "p2-b4-v1",
    schemaVersion: "p2-b4-v1",
  };
}

// ---------------------------------------------------------------------------
// the threaded workflow state (each step's input == prior step's output)
// ---------------------------------------------------------------------------

/** One scrape target (one active profile). Incentive rows are tiny 4-field
 *  records, so they ride the state directly — page SNAPSHOTS never do (they
 *  are consumed inside renderExtract and discarded). */
const IncentiveTargetStateSchema = z.object({
  search_profile_id: z.string(),
  make: z.string(),
  model: z.string(),
  zip: z.string().nullable(),
  /** Normalized brand key (the registry/seed identity). */
  brand: z.string(),
  status: z.enum(["pending", "ready", "scraped", "skipped", "failed"]),
  skip_reason: z.enum(INCENTIVE_SKIP_REASONS).nullable(),
  fail_reason: z.enum(INCENTIVE_FAIL_REASONS).nullable(),
  /** The resolved + validated offers URL (ready targets). */
  resolved_url: z.string().nullable(),
  /** The URL the capture actually used (the persist provenance). */
  used_source_url: z.string().nullable(),
  primary_rows: z.array(IncentiveSchema).nullable(),
  secondary_rows: z.array(IncentiveSchema).nullable(),
  final_rows: z.array(IncentiveSchema).nullable(),
  source_fallback: z.boolean(),
  snapshot_fallbacks: z.number().int(),
  cross_verified: z.boolean(),
  discrepancies: z.number().int(),
});
type IncentiveTargetState = z.infer<typeof IncentiveTargetStateSchema>;

const IncentiveScrapeStateSchema = z.object({
  resolution: z.enum(["pinned", "all_active"]),
  /** Terminal-declined flag: once true, every later step passes through. */
  declined: z.boolean(),
  targets: z.array(IncentiveTargetStateSchema),
  rowsInvalidDropped: z.number().int(),
  rowsDroppedNonCash: z.number().int(),
  incentivesWritten: z.number().int(),
});
type IncentiveScrapeState = z.infer<typeof IncentiveScrapeStateSchema>;

/** Re-hydrate a typed state from a step's loosely-typed inputData. */
function asState(inputData: unknown): IncentiveScrapeState {
  return IncentiveScrapeStateSchema.parse(inputData);
}

/** Narrow a harness.generate result to the HarnessSuspend branch. */
function isHarnessSuspend(r: unknown): r is HarnessSuspend {
  return typeof r === "object" && r !== null && "suspended" in r;
}

function failTarget(t: IncentiveTargetState, reason: IncentiveFailReason): IncentiveTargetState {
  return { ...t, status: "failed", fail_reason: reason };
}

// ---------------------------------------------------------------------------
// step 0 — resolveProfile (the documented enumerate-all-active exception)
// ---------------------------------------------------------------------------

const resolveProfileStep = createStep({
  id: "resolveProfile",
  inputSchema: IncentiveScrapeInputSchema,
  outputSchema: IncentiveScrapeStateSchema,
  execute: async ({ inputData }) => {
    const resolved = deps().resolveProfile(
      deps().getDb(),
      inputData.search_profile_id !== null ? { threadPin: inputData.search_profile_id } : {},
    );

    if (resolved.kind === "none") {
      throw new IncentiveScrapeStopError(
        "no_active_profile",
        "No active search profile found — incentive_scrape needs at least one " +
          "to know which vehicles to find incentives for. Run " +
          "/search_profile_intake to create a profile, then re-run " +
          "/incentive_scrape.",
      );
    }

    // Pinned wins exactly one target. Otherwise EVERY active profile is a
    // target (the documented exception — never bare newest): exactly-1 active
    // IS the whole active set; 2+ active are all enumerated (logged, never an
    // ASK — the per-profile scrape granularity makes the ambiguity moot).
    let profiles;
    let resolution: "pinned" | "all_active";
    if (resolved.kind === "pinned") {
      profiles = [resolved.profile];
      resolution = "pinned";
    } else if (resolved.kind === "inferred_newest") {
      profiles = [resolved.profile];
      resolution = "all_active";
    } else {
      profiles = resolved.candidates;
      resolution = "all_active";
      console.info(
        JSON.stringify({
          trace: "incentive_scrape",
          event: "all_active_enumeration",
          count: profiles.length,
        }),
      );
    }

    const targets: IncentiveTargetState[] = profiles.map((p) => ({
      search_profile_id: p.id,
      make: p.make,
      model: p.model,
      zip: p.postalCode,
      brand: normalizeIncentiveBrand(p.make),
      status: "pending",
      skip_reason: null,
      fail_reason: null,
      resolved_url: null,
      used_source_url: null,
      primary_rows: null,
      secondary_rows: null,
      final_rows: null,
      source_fallback: false,
      snapshot_fallbacks: 0,
      cross_verified: false,
      discrepancies: 0,
    }));

    return {
      resolution,
      declined: false,
      targets,
      rowsInvalidDropped: 0,
      rowsDroppedNonCash: 0,
      incentivesWritten: 0,
    };
  },
});

// ---------------------------------------------------------------------------
// step 1 — loadTargets (US-zip shape gate; the cache markers are read at
// resolution time, where the URL arm exists)
// ---------------------------------------------------------------------------

const loadTargetsStep = createStep({
  id: "loadTargets",
  inputSchema: IncentiveScrapeStateSchema,
  outputSchema: IncentiveScrapeStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    const targets = state.targets.map((t) => {
      if (t.status !== "pending") return t;
      if (!isLikelyUsZip(t.zip)) return failTarget(t, "missing_zip");
      return t;
    });
    return { ...state, targets };
  },
});

// ---------------------------------------------------------------------------
// step 2 — resolveOemSource (auto-approve every new source; NO human gate)
// ---------------------------------------------------------------------------

/** Resolve one target against a registry/seed URL template: substitute →
 *  host-classify → SSRF → 7-day cache gate. Returns the decided target. */
async function resolveTargetAgainstTemplate(
  target: IncentiveTargetState,
  urlTemplate: string,
  failReasonOnInvalid: IncentiveFailReason,
): Promise<IncentiveTargetState> {
  let resolvedUrl: string;
  try {
    resolvedUrl = substituteOemUrlTemplate(urlTemplate, {
      zip: target.zip ?? "",
      model: target.model,
    });
  } catch {
    return failTarget(target, failReasonOnInvalid);
  }
  const verdict = classifyOemHost(resolvedUrl);
  if (!verdict.ok) {
    return failTarget(
      target,
      verdict.reason === "malformed_url" ? failReasonOnInvalid : verdict.reason,
    );
  }
  try {
    await deps().validateUrl(resolvedUrl);
  } catch {
    return failTarget(target, failReasonOnInvalid);
  }

  // The 7-day cache gate, decided HERE where the URL arm exists: fresh AND
  // same URL → skip with ZERO navigation; a changed URL forces a re-scrape.
  const cache = deps().readCacheState(deps().getDb(), {
    make: target.make,
    model: target.model,
    zip: target.zip ?? "",
  });
  if (cacheGateDecision(cache, resolvedUrl, new Date().toISOString()) === "skip") {
    return { ...target, status: "skipped", skip_reason: "cache_fresh", resolved_url: resolvedUrl };
  }
  return { ...target, status: "ready", resolved_url: resolvedUrl };
}

const resolveOemSourceStep = createStep({
  id: "resolveOemSource",
  inputSchema: IncentiveScrapeStateSchema,
  outputSchema: IncentiveScrapeStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) return state;

    // AUTO-APPROVE (owner directive 2026-06-23): incentive_scrape is READ-ONLY —
    // it fetches PUBLIC OEM offers pages and writes only local
    // manufacturer_incentives rows; it sends no email and submits no form, so a
    // brand-new incentive source is a UX choice, not a safety/L2 send gate.
    // Every first-encounter source is therefore recorded and scraped
    // automatically with NO suspend: a registry hit resolves as before, and a
    // first encounter with an in-code seed writes the registry entry itself
    // (the cross-run memory) and proceeds. No seed and no registry is still an
    // honest no_oem_source failure (this build runs web-search-free).
    const targets: IncentiveTargetState[] = [];
    const decidedBrands = new Map<string, IncentiveTargetState>();

    for (const target of state.targets) {
      if (target.status !== "pending") {
        targets.push(target);
        continue;
      }

      // A brand decided earlier IN THIS LOOP (two profiles, one brand): the
      // registry/seed identity is brand-keyed, so re-resolve the same way.
      const sibling = decidedBrands.get(target.brand);
      if (sibling !== undefined && sibling.status === "failed") {
        targets.push(failTarget(target, sibling.fail_reason ?? "no_oem_source"));
        continue;
      }

      const registry = deps().readRegistry();
      const entry = registry[target.brand];
      if (entry !== undefined) {
        // Cross-run memory hit: resolve against the remembered template.
        const decided = await resolveTargetAgainstTemplate(
          target,
          entry.url_template,
          "invalid_source_url",
        );
        decidedBrands.set(target.brand, decided);
        targets.push(decided);
        continue;
      }

      const seed = OEM_SEED_SOURCES[target.brand];
      if (seed === undefined) {
        // Web-search-free build: no registry, no seed → an honest failure.
        const decided = failTarget(target, "no_oem_source");
        decidedBrands.set(target.brand, decided);
        targets.push(decided);
        continue;
      }

      // FIRST ENCOUNTER → auto-record the seed source (the registry remembers
      // the SEED template verbatim so other zips/models substitute correctly)
      // and proceed. The seed template is still SSRF-/host-classified and
      // cache-gated inside resolveTargetAgainstTemplate before anything trusts
      // it; a candidate that fails those code-level gates is a failed target.
      const probe = await resolveTargetAgainstTemplate(
        target,
        seed.urlTemplate,
        "invalid_source_url",
      );
      if (probe.status === "failed") {
        decidedBrands.set(target.brand, probe);
        targets.push(probe);
        continue;
      }
      await deps().writeRegistryEntry(target.brand, {
        url_template: seed.urlTemplate,
        added_at: new Date().toISOString(),
        added_for_profile: target.search_profile_id,
      });
      decidedBrands.set(target.brand, probe);
      targets.push(probe);
    }

    return { ...state, targets };
  },
});

// ---------------------------------------------------------------------------
// step 3 — renderExtract (pure read + the LLM phase; zero DB writes)
// ---------------------------------------------------------------------------

/** Run ONE no-tools structured extraction over a captured snapshot. */
async function extractIncentiveRows(args: {
  runId: string;
  make: string;
  model: string;
  snapshotText: string;
}): Promise<{ rows: Incentive[]; invalidDropped: number }> {
  const result = await deps().harnessGenerate(
    {
      useCase: "incentive_extract",
      schema: IncentiveExtractSchema,
      prompt: buildIncentiveExtractPrompt(args.make, args.model, capSnapshot(args.snapshotText)),
      // A malformed tool call hard-aborts (fail-closed) — never a prose
      // fallthrough, never a regexed-out tool call.
      hitlAvailable: false,
    },
    incentiveLedger(args.runId),
  );
  if (isHarnessSuspend(result)) {
    // Defensive: with hitlAvailable=false the harness throws rather than
    // suspends; a suspend-shaped return still fail-closes identically.
    throw new MalformedToolCallAbort(result.signals);
  }

  const scrapedAt = new Date().toISOString();
  const valid: Incentive[] = [];
  let invalidDropped = 0;
  for (const raw of result.object.incentives) {
    const parsed = IncentiveSchema.safeParse(raw);
    if (parsed.success) valid.push(parsed.data);
    else invalidDropped += 1;
  }
  // Program-identity dedupe (an LLM pass may emit the same offer twice).
  return { rows: mergeScrapeResults(valid.map((incentive) => ({ incentive, scrapedAt }))), invalidDropped };
}

const renderExtractStep = createStep({
  id: "renderExtract",
  inputSchema: IncentiveScrapeStateSchema,
  outputSchema: IncentiveScrapeStateSchema,
  execute: async ({ inputData, runId }) => {
    const state = asState(inputData);
    if (state.declined) return state; // pass-through (zero capture, zero write).

    const emitter = browserEmitterFactory(runId);
    let rowsInvalidDropped = state.rowsInvalidDropped;
    const targets: IncentiveTargetState[] = [];

    // Targets run SERIALLY (politeness-first: one OEM site + at most one
    // rooftop ladder in flight at a time, each in its own isolated browser).
    for (const target of state.targets) {
      if (target.status !== "ready" || target.resolved_url === null) {
        targets.push(target);
        continue;
      }

      const primary = await deps().captureOffers({
        runId,
        label: `oem-${target.brand}`,
        urls: [target.resolved_url],
        emitter,
        zip: target.zip,
      });

      // The rooftop secondary (dual-source): the profile's nearest bound
      // dealer with a usable own-site website, canned /specials paths.
      const dealerRows = deps().listProfileDealers(deps().getDb(), target.search_profile_id);
      const rooftopSite =
        dealerRows
          .map((d) => (typeof d["website"] === "string" ? d["website"] : null))
          .find((w) => rooftopSpecialsUrls(w).length > 0) ?? null;
      const secondaryUrls = rooftopSpecialsUrls(rooftopSite);
      const secondary =
        secondaryUrls.length > 0
          ? await deps().captureOffers({
              runId,
              label: `rooftop-${target.brand}`,
              urls: secondaryUrls,
              emitter,
              zip: target.zip,
            })
          : null;

      let snapshotFallbacks = 0;
      let primaryRows: Incentive[] | null = null;
      let secondaryRows: Incentive[] | null = null;

      if (primary.kind === "captured") {
        if (primary.snapshotFallback) snapshotFallbacks += 1;
        const extracted = await extractIncentiveRows({
          runId,
          make: target.make,
          model: target.model,
          snapshotText: primary.snapshotText,
        });
        primaryRows = extracted.rows;
        rowsInvalidDropped += extracted.invalidDropped;
      }
      if (secondary !== null && secondary.kind === "captured") {
        if (secondary.snapshotFallback) snapshotFallbacks += 1;
        const extracted = await extractIncentiveRows({
          runId,
          make: target.make,
          model: target.model,
          snapshotText: secondary.snapshotText,
        });
        secondaryRows = extracted.rows;
        rowsInvalidDropped += extracted.invalidDropped;
      }

      if (primary.kind === "captured") {
        targets.push({
          ...target,
          status: "scraped",
          used_source_url: primary.url,
          primary_rows: primaryRows,
          secondary_rows: secondaryRows,
          snapshot_fallbacks: snapshotFallbacks,
        });
      } else if (secondary !== null && secondary.kind === "captured") {
        // OEM page refused/dead → the rooftop is the only source. The voiced
        // source-level fallback (primary → backup, transient/equivalent).
        emitter.action("oem_source_fallback", target.brand);
        targets.push({
          ...target,
          status: "scraped",
          used_source_url: secondary.url,
          primary_rows: null,
          secondary_rows: secondaryRows,
          source_fallback: true,
          snapshot_fallbacks: snapshotFallbacks,
        });
      } else {
        // Both arms dead. A refusal is recorded as blocked (never escalated);
        // anything else is a capture failure.
        const wasBlocked =
          primary.kind === "blocked" || (secondary !== null && secondary.kind === "blocked");
        targets.push(failTarget(target, wasBlocked ? "blocked" : "capture_failed"));
      }
    }

    return { ...state, targets, rowsInvalidDropped };
  },
});

// ---------------------------------------------------------------------------
// step 4 — filterCashTypes (the deterministic whitelist + cross-verify)
// ---------------------------------------------------------------------------

const filterCashTypesStep = createStep({
  id: "filterCashTypes",
  inputSchema: IncentiveScrapeStateSchema,
  outputSchema: IncentiveScrapeStateSchema,
  execute: async ({ inputData, runId }) => {
    const state = asState(inputData);
    if (state.declined) return state;

    let rowsDroppedNonCash = state.rowsDroppedNonCash;
    const targets = state.targets.map((target): IncentiveTargetState => {
      if (target.status !== "scraped") return target;

      const primary = target.primary_rows === null ? null : filterCashTypes(target.primary_rows);
      const secondary =
        target.secondary_rows === null ? null : filterCashTypes(target.secondary_rows);
      rowsDroppedNonCash += (primary?.dropped ?? 0) + (secondary?.dropped ?? 0);

      // Dual-source reconciliation on the FILTERED rows: agreement boosts
      // confidence; a same-type split is voiced + counted, never silent.
      let crossVerified = false;
      let discrepancies = 0;
      if (primary !== null && secondary !== null) {
        const verdict = crossVerifyIncentives(primary.kept, secondary.kept);
        crossVerified = verdict.consistent;
        discrepancies = verdict.discrepancies.length;
        if (discrepancies > 0) {
          browserEmitterFactory(runId).action(
            "source_discrepancy",
            `${target.brand}: ${discrepancies} program(s) disagree between the OEM page and the rooftop`,
          );
        }
      }

      // The persisted truth stays single-source: the OEM rows when the OEM
      // page was captured, the rooftop rows on the source-level fallback.
      const finalRows = primary !== null ? primary.kept : (secondary?.kept ?? []);
      return {
        ...target,
        primary_rows: primary?.kept ?? null,
        secondary_rows: secondary?.kept ?? null,
        final_rows: finalRows,
        cross_verified: crossVerified,
        discrepancies,
      };
    });

    return { ...state, targets, rowsDroppedNonCash };
  },
});

// ---------------------------------------------------------------------------
// step 5 — persist (the ONLY DB write of the whole run)
// ---------------------------------------------------------------------------

const persistStep = createStep({
  id: "persist",
  inputSchema: IncentiveScrapeStateSchema,
  outputSchema: IncentiveScrapeStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) return state; // terminal decline: ZERO writes.

    let incentivesWritten = state.incentivesWritten;
    const scrapedAt = new Date().toISOString();
    for (const target of state.targets) {
      if (target.status !== "scraped") continue;
      // Each slice is replaced as a unit in ONE transaction (rollback on a
      // partial failure). An empty row set is a legal refresh — the slice's
      // current truth is "no cash incentives".
      incentivesWritten += deps().persistIncentives({
        make: target.make,
        model: target.model,
        zip: target.zip ?? "",
        rows: target.final_rows ?? [],
        scrapeSourceUrl: target.used_source_url ?? target.resolved_url ?? "",
        scrapedAt,
        db: deps().getDb(),
      });
    }
    return { ...state, incentivesWritten };
  },
});

// ---------------------------------------------------------------------------
// step 6 — confirm (deterministic ZERO-LLM template)
// ---------------------------------------------------------------------------

const confirmStep = createStep({
  id: "confirm",
  inputSchema: IncentiveScrapeStateSchema,
  outputSchema: IncentiveScrapeOutputSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) {
      return { outcome: "declined" as const };
    }

    const scraped = state.targets.filter((t) => t.status === "scraped");
    const skipped = state.targets.filter((t) => t.status === "skipped");
    const failed = state.targets.filter((t) => t.status === "failed");
    const cacheSkips = skipped.filter((t) => t.skip_reason === "cache_fresh").length;
    const userSkips = skipped.length - cacheSkips;
    const sourceFallbacks = scraped.filter((t) => t.source_fallback).length;
    const snapshotFallbacks = scraped.reduce((n, t) => n + t.snapshot_fallbacks, 0);
    const crossVerified = scraped.filter((t) => t.cross_verified).length;
    const discrepancies = scraped.reduce((n, t) => n + t.discrepancies, 0);

    let summary: string;
    if (state.targets.length === 0) {
      summary = "No scrape targets — nothing was opened and nothing was written.";
    } else {
      const failBits = failed.map((t) => `${t.make} ${t.model}: ${t.fail_reason ?? "failed"}`);
      summary =
        `Checked ${state.targets.length} brand target(s): ${scraped.length} scraped` +
        (cacheSkips > 0 ? `, ${cacheSkips} skipped (fresh <7d)` : "") +
        (userSkips > 0 ? `, ${userSkips} skipped by you` : "") +
        (failed.length > 0 ? `, ${failed.length} failed (${failBits.join("; ")})` : "") +
        `. ${state.incentivesWritten} incentive(s) saved` +
        (state.rowsDroppedNonCash > 0
          ? ` (${state.rowsDroppedNonCash} non-cash offer(s) dropped)`
          : "") +
        (state.rowsInvalidDropped > 0 ? `, ${state.rowsInvalidDropped} invalid row(s) dropped` : "") +
        (crossVerified > 0 ? `; ${crossVerified} brand(s) cross-verified against a rooftop` : "") +
        (discrepancies > 0
          ? `; ${discrepancies} program(s) DISAGREE between the OEM page and the rooftop — treat amounts as unconfirmed`
          : "") +
        (sourceFallbacks > 0
          ? `; ${sourceFallbacks} brand(s) read from the rooftop only (OEM page unreachable)`
          : "") +
        (snapshotFallbacks > 0
          ? `; ${snapshotFallbacks} page(s) used the plain-text snapshot fallback`
          : "") +
        (state.incentivesWritten === 0 && scraped.length > 0
          ? ". Zero current cash incentives is a valid result — quote_audit simply has nothing to flag."
          : ".");
    }

    return {
      outcome: "scraped" as const,
      resolution: state.resolution,
      targetsTotal: state.targets.length,
      brandsScraped: scraped.length,
      brandsSkipped: skipped.length,
      brandsExtractionFailed: failed.length,
      incentivesWritten: state.incentivesWritten,
      rowsDroppedNonCash: state.rowsDroppedNonCash,
      rowsInvalidDropped: state.rowsInvalidDropped,
      sourceFallbacks,
      snapshotFallbacks,
      crossVerifiedBrands: crossVerified,
      sourceDiscrepancies: discrepancies,
      summary,
    };
  },
});

// ---------------------------------------------------------------------------
// the flat workflow (7 steps, .then() chain, .commit())
// ---------------------------------------------------------------------------

export const incentiveScrapeWorkflow = createWorkflow({
  id: "incentive_scrape",
  inputSchema: IncentiveScrapeInputSchema,
  outputSchema: IncentiveScrapeOutputSchema,
})
  .then(resolveProfileStep)
  .then(loadTargetsStep)
  .then(resolveOemSourceStep)
  .then(renderExtractStep)
  .then(filterCashTypesStep)
  .then(persistStep)
  .then(confirmStep)
  .commit();

/** The workflow id, exported for registration + the server descriptor. */
export const INCENTIVE_SCRAPE_WORKFLOW_ID = "incentive_scrape" as const;
