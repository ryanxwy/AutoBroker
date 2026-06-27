/**
 * inventory_link_scan — skill #4 (the link-driven sibling of
 * inventory_site_scan). ONE flat linear Mastra `createWorkflow`: 8 named steps
 * chained with `.then()`, no nested workflow. The single suspend is the
 * batch_review card BEFORE any navigation: decline = terminal, ZERO
 * navigation, ZERO DB writes; approve names the exact LINK rows the scan may
 * open.
 *
 * STEP MAP:
 *   0 resolveProfile — the SAME typed three-branch resolver every
 *                      profile-scoped skill uses (pinned → run; exactly-1
 *                      active → inferred-newest, LOGGED, run; 0 active → typed
 *                      STOP pointing at /search_profile_intake; 2+ → typed
 *                      STOP asking by vehicle name). A resolved profile
 *                      missing make/model → typed STOP back at intake (no
 *                      coordinate requirement — links carry their own
 *                      destination). `resolution` provenance threads to the
 *                      output.
 *   1 loadSources    — dealer_inventory_sources rows with
 *                      last_status='pending' for this profile, joined with
 *                      their dealers (US-gate fields + the card label) via the
 *                      tools read closure. Dev-period rows are manual/seeded;
 *                      the dealer_reply_extract handoff writes the same
 *                      pending rows when that skill lands. ZERO pending rows
 *                      is a normal 0/0 done outcome — never a STOP.
 *   2 filterJunk     — `classifySkipUrl` (5 closed rules, tools layer) over
 *                      every pending link; hits surface on the review card's
 *                      skipped section. NO DB write here — skip statuses land
 *                      only at the persist step, after approval.
 *   3 usGate         — ONE batched US classification over the surviving
 *                      links' dealer rows (never per-row calls); non-US →
 *                      skipped `non_us_dealer`. NO DB write here either.
 *   4 reviewGate     — suspend ① (the only one). The SAME batch_review wire +
 *                      card as inventory_site_scan, with link semantics on the
 *                      generic keys (targets[].dealer_id = SOURCE id,
 *                      targets[].website = the link URL, total_in_radius =
 *                      total pending). Resume vocabulary: approve{
 *                      approved_dealer_ids min 1} | decline. decline →
 *                      terminal, zero navigation, zero writes. Zero surviving
 *                      candidates → the gate auto-passes with an empty
 *                      approved set (nothing to review; junk/US skips still
 *                      reach persist for their status marks).
 *   5 visitExtract   — PURE CAPTURE + the LLM phase; performs NO SQLite
 *                      writes and holds NO gate Approver (the one mutating
 *                      browser face — submitForm — structurally requires an
 *                      Approver, so the mutation funnel is unreachable from
 *                      here). Approved links bucket by hostname; one ISOLATED
 *                      throwaway Browser per bucket, ≤SCAN_CONCURRENCY(4)
 *                      Browsers in flight with a launch stagger; links serial
 *                      inside a bucket behind the per-host nav queue (≤1
 *                      in-flight navigation per host at the politeness
 *                      throttle). Per link: navigate → blocked-at-first-
 *                      contact recorded (never retried harder; the REST of a
 *                      blocked host's bucket is marked blocked WITHOUT further
 *                      contact) → lazy-scroll → deterministic per-card
 *                      {href, text} collection woven into URL-tailed card
 *                      blocks as the bounded snapshot (card-less DOM → plain
 *                      page-text snapshot, VOICED as `snapshot_fallback` —
 *                      the transient equivalent-read fallback class:
 *                      auto-allowed, never silent). Then per scanned link ONE
 *                      separate NO-TOOLS structured `inventory_extract` call
 *                      (emit_result discipline; hitlAvailable=false → a
 *                      malformed first hop is retried ONCE on the
 *                      inventory_extract_retry lane via recoverEmitWithRetry,
 *                      else fail-closes as a typed MalformedToolCallAbort,
 *                      never a prose fallthrough).
 *                      Zod re-validates every row; an LLM-emitted VIN must
 *                      appear verbatim in the link's snapshot or the row drops
 *                      + counts; an emitted listing_url must normalize into
 *                      the collected card-href set ∪ {the link itself} or it
 *                      is cleared to null + counted. Match classification is
 *                      deterministic code; `filterForProfile` keeps exact|near
 *                      rows only (mismatch/unknown drop + count). Snapshot
 *                      text stays OUT of the Mastra step output (in-process
 *                      per-run carry).
 *   6 persist        — the ONLY DB write: ONE persistScanResults call over
 *                      every outcome — junk/US skips (status mark only),
 *                      scanned links with their accepted rows, blocked and
 *                      failed links. The shared writer owns the per-source
 *                      status transitions (pending→scanned/blocked/failed/
 *                      skipped), the dual-arm (VIN + normalized-URL) upsert,
 *                      VIN-promotion, and source-scoped supersession gated to
 *                      freshly-SCANNED sources. Links the user left
 *                      undecided/skipped ON THE CARD stay pending (offered
 *                      again next run) — only the pre-review junk/US skips are
 *                      marked. The loader and the writer converge on one
 *                      FROZEN id space (computeSourceId ∘ urlNormalize), so a
 *                      seeded pending row and this run's status mark are the
 *                      same physical row — anti-hollow-green: a scanned link
 *                      provably flips ITS row to last_status='scanned' and
 *                      writes ≥1 listing into the run window with zero
 *                      dual-key duplicates.
 *   7 confirm        — deterministic ZERO-LLM template (scanned/blocked/
 *                      failed/skipped + found/matched/written + drop tallies).
 *
 * KEYSTONE: the capture path holds NO Approver and imports NOTHING from the
 * gate module; only the ungated read faces (navigate / lazyScroll / evaluate /
 * snapshot) are reachable. Budget red line: the profile's budget is
 * structurally absent from this file — only year/make/model/trim reach
 * classification, and only make/model reach the extraction prompt.
 *
 * FALLBACK GATING MAP (semantic → suspend/abort; transient → auto + voiced):
 *   - reviewGate decline/cancel        → terminal `declined`, zero nav, zero
 *                                        writes (semantic, human-decided).
 *   - card-less DOM → plain snapshot   → AUTO-allowed equivalent read, voiced
 *                                        `snapshot_fallback` + tallied (the
 *                                        transient class — never silent).
 *   - blocked navigation               → recorded at first contact, host-wide
 *                                        for the rest of the bucket, never
 *                                        retried harder, never escalated;
 *                                        surfaced in the confirm counts.
 *   - malformed structured call (#1244)→ hitlAvailable=false on every extract
 *                                        call: a malformed first hop is retried
 *                                        ONCE on the inventory_extract_retry
 *                                        (v4-pro+thinking) lane via
 *                                        recoverEmitWithRetry and persist IS
 *                                        reached on a clean retry; only a SECOND
 *                                        malformed / blob-only / budget-
 *                                        exhausted failure reaches the fail-
 *                                        closed MalformedToolCallAbort terminus
 *                                        where the run FAILS (zero writes;
 *                                        persist never reached), never a prose
 *                                        fallthrough.
 *   - unrenderable suspend payload     → the suspend payload is schema-bound
 *                                        (LinkScanReviewSuspendSchema) and the
 *                                        card host falls back to its
 *                                        never-hidden pending placeholder on a
 *                                        defensive-parse miss — the same gate
 *                                        face, fail-closed: nothing proceeds
 *                                        without a decision on THIS suspend.
 *
 * Dependency wall: imports @mastra/* (legal only here), @autobroker/core
 * (InventoryListing), @autobroker/tools (resolver + source loader + browser
 * session + pure helpers + the persist writer — the ONLY DB/side-effect
 * paths), the sibling skill module (shared capture/extract helpers + the
 * batch_review resume contract), this layer's harness facade, and the
 * recoverEmitWithRetry recovery helper (which owns the @autobroker/model
 * contact for the malformed-class retry hop).
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import { InventoryListingSchema, type InventoryListing } from "@autobroker/core";
import {
  capSnapshot,
  classifyMatchStatus,
  classifySkipUrl,
  filterForProfile,
  getDb,
  isUsDealerBatch,
  listPendingSources as listPendingSourcesImpl,
  normalizeListingUrl,
  NULL_EMITTER,
  persistScanResults as persistScanResultsImpl,
  resolveActiveProfile as resolveActiveProfileImpl,
  validateVinProvenance,
  withBrowserContext,
  type BrowserEmitter,
  type BrowserSession,
  type ClassifiedListingRow,
  type DealerScanOutcome,
} from "@autobroker/tools";

import {
  BatchReviewResumeSchema,
  buildInventoryExtractPrompt,
  CARD_COLLECT_MAX,
  collectInventoryCards,
  InventoryExtractSchema,
  parseAcceptableTrims,
  runWorkerPool,
  SCAN_CONCURRENCY,
  scanHostnameOf,
  weaveCardsForExtraction,
} from "./inventorySiteScan.js";
import { harness, type HarnessLedgerContext } from "./harness.js";
import { recoverEmitWithRetry } from "./recoverEmitWithRetry.js";

/** A page handle as the browser session mints it (no direct playwright import
 *  here — the type flows off the tools session surface). */
type SessionPage = Awaited<ReturnType<BrowserSession["newPage"]>>;

// ---------------------------------------------------------------------------
// typed terminal errors (the run fails loud with a user-facing message)
// ---------------------------------------------------------------------------

/** The three-branch / field-completeness STOP codes. (No "no sources" STOP:
 *  zero pending links is a normal 0/0 done outcome, not an error.) */
export type InventoryLinkScanStopCode =
  | "no_active_profile"
  | "multiple_active_profiles"
  | "profile_missing_fields";

/** Typed STOP from the pre-review steps. The message is the user-facing
 *  wording — the server surfaces it verbatim on the run's error frame. */
export class InventoryLinkScanStopError extends Error {
  readonly code: InventoryLinkScanStopCode;
  constructor(code: InventoryLinkScanStopCode, message: string) {
    super(message);
    this.name = "InventoryLinkScanStopError";
    this.code = code;
  }
}

/** The in-process capture carry vanished between capture and persist (the only
 *  way: the process died mid-run and the run re-entered a later step without
 *  re-executing the capture). Fail LOUD over persisting an empty result. */
export class InventoryLinkScanCaptureLostError extends Error {
  constructor() {
    super(
      "The captured link-scan data for this run was lost (the server restarted " +
        "mid-run). Nothing was written — re-run /inventory_link_scan.",
    );
    this.name = "InventoryLinkScanCaptureLostError";
  }
}

// ---------------------------------------------------------------------------
// tunables (module constants, not env knobs)
// ---------------------------------------------------------------------------

/** Gap between consecutive isolated-browser launches (mirrors the sibling
 *  scan: first-contact requests must not land in the same instant). */
const LINK_LAUNCH_STAGGER_MS = 4_000;
/** Concurrent `inventory_extract` LLM calls in the extract phase. */
const EXTRACT_CONCURRENCY = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// the review-card skip vocabulary (pre-review filters)
// ---------------------------------------------------------------------------

/**
 * Row-level skip vocabulary for the review card's skipped section: the five
 * junk-URL rules (classifySkipUrl, tools layer) plus the US gate. Closed set —
 * the card renders these as the per-row reason.
 */
export const LINK_SCAN_SKIP_REASONS = [
  "unsubscribe",
  "google_services",
  "social_media",
  "crm_tracking",
  "bare_homepage",
  "non_us_dealer",
] as const;
export type LinkScanSkipReason = (typeof LINK_SCAN_SKIP_REASONS)[number];

// ---------------------------------------------------------------------------
// the batch_review suspend / resume contracts
// ---------------------------------------------------------------------------

/** The review-card question (fixed copy). */
export const LINK_SCAN_REVIEW_QUESTION = "Open and scan these inventory links now?";

/**
 * The suspend payload (the spec_inline the shared batch_review card renders).
 * Wire-identical to inventory_site_scan's payload shape; the generic row keys
 * carry link semantics (dealer_id = SOURCE id, website = the link URL,
 * total_in_radius = total pending links). IDs + short labels only — the
 * payload must stay small (<8KB; the harness re-asserts the bound on every
 * live sighting).
 */
export const LinkScanReviewSuspendSchema = z.object({
  kind: z.literal("batch_review"),
  question: z.string(),
  targets: z.array(
    z.object({ dealer_id: z.string(), name: z.string(), website: z.string() }),
  ),
  skipped: z.array(
    z.object({
      dealer_id: z.string(),
      name: z.string(),
      reason: z.enum(LINK_SCAN_SKIP_REASONS),
    }),
  ),
  total_targets: z.number().int(),
  total_in_radius: z.number().int(),
});
export type LinkScanReviewSuspend = z.infer<typeof LinkScanReviewSuspendSchema>;

/**
 * The resume vocabulary — REUSED VERBATIM from inventory_site_scan (one
 * batch_review wire contract across both scan skills): an explicit
 * approved-id list (`approved_dealer_ids`, min 1 — here carrying SOURCE ids)
 * or a decline. Re-exported under a link_scan name so the server descriptor
 * and tests name the contract they mean.
 */
export const LinkScanReviewResumeSchema = BatchReviewResumeSchema;
export type LinkScanReviewResume = z.infer<typeof LinkScanReviewResumeSchema>;

// ---------------------------------------------------------------------------
// workflow input / output contracts
// ---------------------------------------------------------------------------

/** The workflow input shape (the server descriptor builds this from the start
 *  body). The profile pin is the ONLY input — links come from the DB's
 *  pending dealer_inventory_sources rows, never from the start body. */
export const LinkScanInputSchema = z.object({
  /** Explicit profile pin, or null → three-branch resolution over active rows. */
  search_profile_id: z.string().nullable(),
});
export type LinkScanInput = z.infer<typeof LinkScanInputSchema>;

/** The workflow output — scanned | declined union. The `scanned` member's
 *  counts are the skill's typed output contract (urlsScanned /
 *  listingsMatched are the headline pair; the rest are the audit tallies the
 *  confirm template surfaces). */
export const LinkScanOutputSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("scanned"),
    searchProfileId: z.string(),
    /** Profile-resolution provenance, threaded from the resolve step. */
    resolution: z.enum(["pinned", "inferred_newest"]),
    /** Links actually navigated and captured (scanned sources). */
    urlsScanned: z.number().int(),
    /** Listings that matched the profile (exact|near) and were handed to the
     *  persist writer. */
    listingsMatched: z.number().int(),
    /** All valid listings the extraction emitted (before profile filtering). */
    listingsFound: z.number().int(),
    /** Rows the dual-arm writer inserted or refreshed. */
    listingsWritten: z.number().int(),
    /** Links the user approved on the review card. */
    sourcesApproved: z.number().int(),
    /** Pre-review skips (junk rules + US gate), marked at persist. */
    sourcesSkipped: z.number().int(),
    /** Links refused at first contact (never retried harder, never escalated). */
    sourcesBlocked: z.number().int(),
    /** Links whose capture failed (navigation/page error). */
    sourcesFailed: z.number().int(),
    /** Extracted rows dropped by the profile filter: mismatch (wrong
     *  year/make/model) + unknown (identity fields missing). */
    rowsRejected: z.number().int(),
    /** Extracted rows dropped for failing the 11-field Zod contract. */
    rowsInvalidDropped: z.number().int(),
    /** Rows dropped because the emitted VIN was not verbatim in the snapshot. */
    vinProvenanceDropped: z.number().int(),
    /** Emitted listing_urls outside the captured provenance set, cleared to
     *  null (the row then lives or dies by the usual VIN-or-URL key rule). */
    urlProvenanceStripped: z.number().int(),
    /** URL-keyed rows superseded by a VIN-keyed row for the same car. */
    vinPromoted: z.number().int(),
    /** Rows retired by source-scoped supersession (freshly-scanned sources only). */
    staleSuperseded: z.number().int(),
    summary: z.string(),
  }),
  z.object({ outcome: z.literal("declined") }),
]);
export type LinkScanOutput = z.infer<typeof LinkScanOutputSchema>;

// ---------------------------------------------------------------------------
// the parallel link capture (pure capture — injectable for tests)
// ---------------------------------------------------------------------------

/** One approved link to capture. */
export interface LinkCaptureTarget {
  sourceId: string;
  url: string;
}

/** Arguments to the capture boundary. */
export interface LinkScanCaptureArgs {
  /** The Mastra runId (prefixes the per-bucket throwaway browser names). */
  runId: string;
  /** The APPROVED links, in review order. */
  targets: readonly LinkCaptureTarget[];
  /** The voiced-trace emitter (SSE in production, NULL_EMITTER otherwise). */
  emitter: BrowserEmitter;
}

/** One link's capture outcome. PURE DATA — nothing has been classified and
 *  nothing has been written; persist runs serially after the whole capture. */
export interface SourceCaptureOutcome {
  sourceId: string;
  status: "scanned" | "blocked" | "failed";
  errorJson: string | null;
  /** The bounded extraction snapshot (scanned outcomes only): the woven
   *  per-card blocks, or the plain page-text snapshot when no cards
   *  collected. */
  snapshotText: string | null;
  /** The collected per-card hrefs (absolute, same-host) — together with the
   *  link itself, the URL-provenance set the extract phase validates
   *  LLM-emitted listing_urls against. */
  cardHrefs: string[];
  /** True when the card collector found nothing and the plain page-text
   *  snapshot was used (the voiced transient fallback). */
  snapshotFallback: boolean;
}

/** One hostname bucket = one isolated-browser task. Same-host links merge into
 *  ONE task and run serially inside it (isolated browsers cannot coordinate
 *  their per-host politeness throttles, so a host must never be walked by two
 *  browsers at once). */
export interface LinkBucket {
  host: string;
  targets: LinkCaptureTarget[];
}

/** Pre-dedupe + bucket links by URL hostname, preserving first-seen order. */
export function bucketLinksByHost(targets: readonly LinkCaptureTarget[]): LinkBucket[] {
  const byHost = new Map<string, LinkBucket>();
  for (const t of targets) {
    const host = scanHostnameOf(t.url) ?? t.sourceId; // defensive — junk URLs were filtered upstream
    const bucket = byHost.get(host);
    if (bucket === undefined) byHost.set(host, { host, targets: [t] });
    else bucket.targets.push(t);
  }
  return [...byHost.values()];
}

/** One bucket task's runner (the seam the pool test fakes). */
export type LinkBucketRunner = (
  args: LinkScanCaptureArgs,
  bucket: LinkBucket,
) => Promise<SourceCaptureOutcome[]>;

function failedLinkOutcome(
  target: LinkCaptureTarget,
  reason: string,
  message: string,
): SourceCaptureOutcome {
  return {
    sourceId: target.sourceId,
    status: "failed",
    errorJson: JSON.stringify({ reason, message }),
    snapshotText: null,
    cardHrefs: [],
    snapshotFallback: false,
  };
}

function blockedLinkOutcome(
  target: LinkCaptureTarget,
  marker: string | null,
  propagated: boolean,
): SourceCaptureOutcome {
  return {
    sourceId: target.sourceId,
    status: "blocked",
    errorJson: JSON.stringify(
      propagated ? { reason: "blocked", marker, propagated: true } : { reason: "blocked", marker },
    ),
    snapshotText: null,
    cardHrefs: [],
    snapshotFallback: false,
  };
}

/**
 * Capture ONE approved link inside an already-open isolated browser session:
 * navigate (per-host nav queue + politeness throttle) → blocked-at-first-
 * contact recorded → lazy-scroll → deterministic per-card collection + URL
 * weave as the bounded snapshot. A card-less DOM degrades to the plain
 * page-text snapshot — the transient equivalent-read fallback, auto-allowed
 * but VOICED on the emitter (`snapshot_fallback`), never silent.
 *
 * Read faces only: this function can express navigation, scrolling and
 * read-only DOM evaluation — the session's one mutating face (submitForm)
 * requires an Approver this path does not hold.
 *
 * Exported for unit tests (the bucket runner is the production caller).
 */
export async function captureOneLink(deps: {
  session: BrowserSession;
  queueNav: (page: SessionPage, url: string) => Promise<{ blocked: string | null }>;
  emitter: BrowserEmitter;
  target: LinkCaptureTarget;
  host: string;
}): Promise<SourceCaptureOutcome> {
  const { session, queueNav, emitter, target, host } = deps;
  const page = await session.newPage();
  try {
    const nav = await queueNav(page, target.url);
    if (nav.blocked !== null) {
      return blockedLinkOutcome(target, nav.blocked, false);
    }

    await session.lazyScroll(page);

    // Per-card {href, text} off the live DOM — the extraction input is the
    // URL-woven card blocks (bounded by the snapshot cap; cards beyond the
    // cap simply aren't extracted).
    const cards = await page.evaluate(collectInventoryCards, { max: CARD_COLLECT_MAX });
    let snapshotText: string;
    let snapshotFallback = false;
    if (cards.length > 0) {
      snapshotText = capSnapshot(weaveCardsForExtraction(cards));
    } else {
      // Card-less DOM (a VDP, or a heuristic miss) → the plain page-text
      // snapshot. Equivalent-read fallback: auto-allowed, voiced, traced via
      // the emitter — never a silent degrade.
      emitter.action("snapshot_fallback", host);
      snapshotText = await session.snapshot(page); // bounded by the session cap
      snapshotFallback = true;
    }

    return {
      sourceId: target.sourceId,
      status: "scanned",
      errorJson: null,
      snapshotText,
      cardHrefs: cards.map((c) => c.href),
      snapshotFallback,
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * One bucket's serial link loop over an ALREADY-OPEN session: per-host nav
 * queue (≤1 in-flight navigation per host at the politeness throttle), a
 * per-link try/catch so one link degrades — never kills — its same-host
 * siblings, and the blocked-at-first-contact discipline: once the host
 * refuses, the REST of the bucket is marked blocked WITHOUT further contact
 * (a refusing host is never poked again this run, and a block is never
 * "escalated" with retries — the navigate face already did its bounded
 * backoff before classifying).
 *
 * Exported for unit tests with a fake session (the real bucket runner wraps
 * it in an isolated throwaway browser).
 */
export async function runLinkBucket(deps: {
  session: BrowserSession;
  emitter: BrowserEmitter;
  bucket: LinkBucket;
}): Promise<SourceCaptureOutcome[]> {
  const { session, emitter, bucket } = deps;
  // Per-host nav queue: every navigation in this task chains through one
  // promise, so at most ONE navigation per host is in flight at the
  // session's existing politeness throttle.
  let navChain: Promise<unknown> = Promise.resolve();
  const queueNav = (
    page: SessionPage,
    url: string,
  ): Promise<{ blocked: string | null }> => {
    const turn = navChain.then(() => session.navigate(page, url));
    navChain = turn.catch(() => undefined);
    return turn;
  };

  const outcomes: SourceCaptureOutcome[] = [];
  let hostBlockedMarker: string | null = null;
  for (const target of bucket.targets) {
    if (hostBlockedMarker !== null) {
      // The host already refused this run — record, don't re-contact.
      outcomes.push(blockedLinkOutcome(target, hostBlockedMarker, true));
      continue;
    }
    try {
      const outcome = await captureOneLink({
        session,
        queueNav,
        emitter,
        target,
        host: bucket.host,
      });
      if (outcome.status === "blocked") {
        const parsed = JSON.parse(outcome.errorJson ?? "{}") as { marker?: string | null };
        hostBlockedMarker = parsed.marker ?? "blocked";
      }
      outcomes.push(outcome);
    } catch (err) {
      outcomes.push(
        failedLinkOutcome(
          target,
          "capture_error",
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }
  return outcomes;
}

/** The REAL per-bucket task: ONE isolated throwaway browser for the bucket's
 *  host (named `${runId}-${host}` so trace files never collide), then the
 *  serial bucket loop above. */
const realLinkBucketRunner: LinkBucketRunner = async (args, bucket) => {
  return withBrowserContext(`${args.runId}-${bucket.host}`, { emitter: args.emitter }, (session) =>
    runLinkBucket({ session, emitter: args.emitter, bucket }),
  );
};

/**
 * The parallel capture core. PURE CAPTURE: performs NO SQLite writes — persist
 * runs serially after the whole capture returns. Links are bucketed by
 * hostname (same-host links share one task, serial inside); buckets run under
 * a SCAN_CONCURRENCY-wide worker pool (counting isolated BROWSERS) with a
 * launch stagger between browser starts. A throwing bucket degrades to
 * per-link failed outcomes — it never kills the run. Headed-debug degrade:
 * 1 browser. Outcome order follows the input target order.
 */
export async function captureLinksParallelImpl(
  args: LinkScanCaptureArgs,
  runBucket: LinkBucketRunner = realLinkBucketRunner,
): Promise<SourceCaptureOutcome[]> {
  const headed = process.env["AUTOBROKER_CHROME_HEADLESS"] === "0";
  const browserLimit = headed ? 1 : SCAN_CONCURRENCY;
  const buckets = bucketLinksByHost(args.targets);

  // Launch-stagger gate (synchronous bookkeeping → race-free in one loop).
  let nextLaunchAt = 0;
  const launchGate = async (): Promise<void> => {
    const waitMs = Math.max(0, nextLaunchAt - Date.now());
    nextLaunchAt = Date.now() + waitMs + LINK_LAUNCH_STAGGER_MS;
    if (waitMs > 0) await sleep(waitMs);
  };

  const perBucket = await runWorkerPool<SourceCaptureOutcome[]>(
    browserLimit,
    buckets.length,
    async (i) => {
      const bucket = buckets[i]!;
      try {
        await launchGate();
        return await runBucket(args, bucket);
      } catch (err) {
        // Whole-task failure (e.g. the browser never launched): every link in
        // the bucket fails, the other buckets are untouched.
        const message = err instanceof Error ? err.message : String(err);
        return bucket.targets.map((t) => failedLinkOutcome(t, "scan_task_error", message));
      }
    },
  );

  // Flatten back to target order (buckets preserve first-seen target order).
  const bySource = new Map<string, SourceCaptureOutcome>();
  for (const outcome of perBucket.flat()) bySource.set(outcome.sourceId, outcome);
  return args.targets.map(
    (t) =>
      bySource.get(t.sourceId) ??
      failedLinkOutcome(t, "scan_task_error", "no outcome produced for this link"),
  );
}

// ---------------------------------------------------------------------------
// the in-process capture carry (snapshots NEVER enter Mastra step outputs)
// ---------------------------------------------------------------------------

/** Per-run heavyweight capture data: link snapshots + card hrefs from the
 *  capture phase, accepted classified rows from the extract phase. Keyed by
 *  runId; written by visitExtract, consumed and DELETED by persist (and on
 *  any extract failure). The suspend lives BEFORE visitExtract, so no resume
 *  boundary ever sits between producer and consumer — a crash mid-window
 *  re-runs the capture (repopulating) or trips the typed capture-lost guard. */
interface LinkScanCarry {
  captures: Map<string, { snapshotText: string; cardHrefs: string[] }>;
  classified: Map<string, ClassifiedListingRow[]>;
}
const linkScanCarryByRun = new Map<string, LinkScanCarry>();

// ---------------------------------------------------------------------------
// dependency-injection seam (test-runner-guarded, mirroring the other skills)
// ---------------------------------------------------------------------------

/**
 * The runtime collaborators the workflow steps call. Injectable so the offline
 * tests drive the REAL flat Mastra workflow → REAL suspend/resume chain
 * against deterministic stubs and an isolated tmp DB, WITHOUT module mocks.
 */
export interface InventoryLinkScanWorkflowDeps {
  harnessGenerate: typeof harness.generate;
  /** The typed three-branch profile resolver (tools layer). */
  resolveProfile: typeof resolveActiveProfileImpl;
  /** The pending dealer_inventory_sources ⋈ dealers read closure (tools layer). */
  listPendingSources: typeof listPendingSourcesImpl;
  /** The pure-capture boundary (the only browser-touching collaborator). */
  captureLinks: (args: LinkScanCaptureArgs) => Promise<SourceCaptureOutcome[]>;
  /** The capture-then-serial persist writer (tools layer, the ONLY DB write). */
  persistScan: typeof persistScanResultsImpl;
  /** The DB accessor the read/write closures run through (tools layer). */
  getDb: typeof getDb;
}

const realDeps: InventoryLinkScanWorkflowDeps = {
  harnessGenerate: harness.generate,
  resolveProfile: resolveActiveProfileImpl,
  listPendingSources: listPendingSourcesImpl,
  captureLinks: captureLinksParallelImpl,
  persistScan: persistScanResultsImpl,
  getDb,
};

let injectedDeps: InventoryLinkScanWorkflowDeps | undefined;

function deps(): InventoryLinkScanWorkflowDeps {
  return injectedDeps ?? realDeps;
}

/** TEST-ONLY seam — refused outside a test runner (a production caller must
 *  never redirect the harness, the browser, or the DB write path). */
export function __setInventoryLinkScanDepsForTests(
  partial: Partial<InventoryLinkScanWorkflowDeps>,
): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__setInventoryLinkScanDepsForTests is a test-only seam (refused outside a test runner)",
    );
  }
  injectedDeps = { ...realDeps, ...partial };
}

/** Restore the real wiring between test cases. */
export function __resetInventoryLinkScanDepsForTests(): void {
  injectedDeps = undefined;
}

// ---------------------------------------------------------------------------
// per-run browser-emitter injection (production wiring, set once at app boot)
// ---------------------------------------------------------------------------

let browserEmitterFactory: (runId: string) => BrowserEmitter = () => NULL_EMITTER;

/** Install the app-layer per-run emitter factory (idempotent; last call wins —
 *  one server per process in the production topology). */
export function setLinkScanBrowserEmitterFactory(
  factory: (runId: string) => BrowserEmitter,
): void {
  browserEmitterFactory = factory;
}

// ---------------------------------------------------------------------------
// ledger identity for the extract-phase LLM calls
// ---------------------------------------------------------------------------

function linkScanLedger(runId: string): HarnessLedgerContext {
  return {
    runId,
    skill: "inventory_link_scan",
    layer: "L2",
    promptVersion: "p2-b3-v1",
    schemaVersion: "p2-b3-v1",
  };
}

// ---------------------------------------------------------------------------
// the threaded workflow state (each step's input == prior step's output)
// ---------------------------------------------------------------------------

/** One pending link row (loadSources output; the dealer fields feed the US
 *  gate and the card label). */
const SourceRowStateSchema = z.object({
  source_id: z.string(),
  dealer_id: z.string(),
  dealer_name: z.string(),
  source_url: z.string(),
  website: z.string().nullable(),
  country: z.string().nullable(),
  state: z.string().nullable(),
  postal_code: z.string().nullable(),
  city: z.string().nullable(),
});
type SourceRowState = z.infer<typeof SourceRowStateSchema>;

const SkippedSourceStateSchema = z.object({
  source_id: z.string(),
  dealer_id: z.string(),
  dealer_name: z.string(),
  source_url: z.string(),
  reason: z.enum(LINK_SCAN_SKIP_REASONS),
});

/** Light per-link capture row (NO snapshot text — that lives in the carry). */
const CapturedSourceStateSchema = z.object({
  source_id: z.string(),
  dealer_id: z.string(),
  source_url: z.string(),
  status: z.enum(["scanned", "blocked", "failed"]),
  error_json: z.string().nullable(),
});

const LinkPersistCountsSchema = z.object({
  sourcesScanned: z.number().int(),
  sourcesBlocked: z.number().int(),
  sourcesSkipped: z.number().int(),
  sourcesFailed: z.number().int(),
  listingsWritten: z.number().int(),
  vinPromoted: z.number().int(),
  droppedNoKey: z.number().int(),
  staleSuperseded: z.number().int(),
});

/**
 * The accumulating state threaded through the 8 steps. Flat plain-JSON (Mastra
 * snapshots it) and LEAN: ids, counts and the light rows the next step needs —
 * snapshot text never enters this object.
 */
const LinkScanStateSchema = z.object({
  searchProfileId: z.string(),
  /** pinned vs inferred-newest — the resolution provenance, always recorded. */
  resolution: z.enum(["pinned", "inferred_newest"]),
  make: z.string(),
  model: z.string(),
  year: z.number().int(),
  trim: z.string().nullable(),
  acceptableTrims: z.array(z.string()).nullable(),
  /** Terminal-declined flag: once true, every later step passes through. */
  declined: z.boolean(),
  sources: z.array(SourceRowStateSchema).nullable(),
  skipped: z.array(SkippedSourceStateSchema).nullable(),
  /** Junk/US survivors — the review-card candidates. */
  candidates: z.array(SourceRowStateSchema).nullable(),
  totalPending: z.number().int(),
  approvedSourceIds: z.array(z.string()).nullable(),
  /** Supersession watermark: set immediately before capture begins. */
  runStartedAt: z.string().nullable(),
  captured: z.array(CapturedSourceStateSchema).nullable(),
  urlsScanned: z.number().int(),
  listingsFound: z.number().int(),
  listingsMatched: z.number().int(),
  rowsRejectedMismatch: z.number().int(),
  rowsRejectedUnknown: z.number().int(),
  rowsInvalidDropped: z.number().int(),
  vinProvenanceDropped: z.number().int(),
  urlProvenanceStripped: z.number().int(),
  /** Card-less captures that degraded to the plain page-text snapshot
   *  (the voiced transient fallback — tallied for the confirm template). */
  snapshotFallbacks: z.number().int(),
  persist: LinkPersistCountsSchema.nullable(),
});
type LinkScanState = z.infer<typeof LinkScanStateSchema>;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Re-hydrate a typed state from a step's loosely-typed inputData. */
function asState(inputData: unknown): LinkScanState {
  return LinkScanStateSchema.parse(inputData);
}

/** Run `fn` against the SHARED tools-layer DB connection. */
function withDb<T>(fn: (db: ReturnType<typeof getDb>) => T): T {
  return fn(deps().getDb());
}

/** "2026 Hyundai Tucson SEL"-style label for ask-by-vehicle stops. */
function vehicleLabel(p: {
  year: number;
  make: string;
  model: string;
  trim: string | null;
}): string {
  return [p.year, p.make, p.model, p.trim].filter((x) => x !== null && x !== "").join(" ");
}

// ---------------------------------------------------------------------------
// step 0 — resolveProfile (typed three-branch + field-completeness gate)
// ---------------------------------------------------------------------------

const resolveProfileStep = createStep({
  id: "resolveProfile",
  inputSchema: LinkScanInputSchema,
  outputSchema: LinkScanStateSchema,
  execute: async ({ inputData }) => {
    const resolved = withDb((db) =>
      deps().resolveProfile(
        db,
        inputData.search_profile_id !== null ? { threadPin: inputData.search_profile_id } : {},
      ),
    );

    if (resolved.kind === "none") {
      throw new InventoryLinkScanStopError(
        "no_active_profile",
        "No active search profile found — inventory_link_scan needs one to know " +
          "which vehicle to match listings against. Run /search_profile_intake " +
          "to create a profile, then re-run /inventory_link_scan.",
      );
    }
    if (resolved.kind === "ambiguous") {
      const labels = resolved.candidates.map((p) => vehicleLabel(p)).join(" | ");
      throw new InventoryLinkScanStopError(
        "multiple_active_profiles",
        `Multiple active search profiles found (${labels}). Tell me which vehicle ` +
          "to scan inventory links for by re-running /inventory_link_scan with " +
          "that profile's search_profile_id.",
      );
    }

    const profile = resolved.profile;
    const missing: string[] = [];
    if (profile.make.trim() === "") missing.push("make");
    if (profile.model.trim() === "") missing.push("model");
    if (missing.length > 0) {
      throw new InventoryLinkScanStopError(
        "profile_missing_fields",
        `The resolved profile (${vehicleLabel(profile)}) is missing ` +
          `${missing.join(", ")} — inventory_link_scan needs the vehicle identity ` +
          "to match listings. Run /search_profile_intake to complete or recreate " +
          "the profile, then re-run /inventory_link_scan.",
      );
    }

    return {
      searchProfileId: profile.id,
      resolution: resolved.kind,
      make: profile.make,
      model: profile.model,
      year: profile.year,
      trim: profile.trim,
      acceptableTrims: parseAcceptableTrims(profile.acceptableTrimsJson),
      declined: false,
      sources: null,
      skipped: null,
      candidates: null,
      totalPending: 0,
      approvedSourceIds: null,
      runStartedAt: null,
      captured: null,
      urlsScanned: 0,
      listingsFound: 0,
      listingsMatched: 0,
      rowsRejectedMismatch: 0,
      rowsRejectedUnknown: 0,
      rowsInvalidDropped: 0,
      vinProvenanceDropped: 0,
      urlProvenanceStripped: 0,
      snapshotFallbacks: 0,
      persist: null,
    };
  },
});

// ---------------------------------------------------------------------------
// step 1 — loadSources (tools read; ZERO pending = a normal 0/0 outcome)
// ---------------------------------------------------------------------------

const loadSourcesStep = createStep({
  id: "loadSources",
  inputSchema: LinkScanStateSchema,
  outputSchema: LinkScanStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    const rows = withDb((db) => deps().listPendingSources(db, state.searchProfileId));
    const sources: SourceRowState[] = rows.map((r) => ({
      source_id: r.sourceId,
      dealer_id: r.dealerId,
      dealer_name: r.dealerName,
      source_url: r.sourceUrl,
      website: r.website,
      country: r.country,
      state: r.state,
      postal_code: r.postalCode,
      city: r.city,
    }));
    return { ...state, sources, totalPending: sources.length };
  },
});

// ---------------------------------------------------------------------------
// step 2 — filterJunk (pure; NO DB write — skip marks land at persist)
// ---------------------------------------------------------------------------

const filterJunkStep = createStep({
  id: "filterJunk",
  inputSchema: LinkScanStateSchema,
  outputSchema: LinkScanStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    const skipped = [...(state.skipped ?? [])];
    const candidates: SourceRowState[] = [];
    for (const source of state.sources ?? []) {
      const reason = classifySkipUrl(source.source_url);
      if (reason !== null) {
        skipped.push({
          source_id: source.source_id,
          dealer_id: source.dealer_id,
          dealer_name: source.dealer_name,
          source_url: source.source_url,
          reason,
        });
      } else {
        candidates.push(source);
      }
    }
    return { ...state, skipped, candidates };
  },
});

// ---------------------------------------------------------------------------
// step 3 — usGate (pure; ONE batched classification, never per-row calls)
// ---------------------------------------------------------------------------

const usGateStep = createStep({
  id: "usGate",
  inputSchema: LinkScanStateSchema,
  outputSchema: LinkScanStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    const rows = state.candidates ?? [];
    const usFlags = isUsDealerBatch(
      rows.map((r) => ({
        country: r.country,
        website: r.website,
        state: r.state,
        postal_code: r.postal_code,
        name: r.dealer_name,
        city: r.city,
      })),
    );
    const skipped = [...(state.skipped ?? [])];
    const candidates: SourceRowState[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      if (usFlags[i] === true) {
        candidates.push(row);
      } else {
        skipped.push({
          source_id: row.source_id,
          dealer_id: row.dealer_id,
          dealer_name: row.dealer_name,
          source_url: row.source_url,
          reason: "non_us_dealer",
        });
      }
    }
    return { ...state, skipped, candidates };
  },
});

// ---------------------------------------------------------------------------
// step 4 — reviewGate (suspend ①: the human gate before ANY navigation)
// ---------------------------------------------------------------------------

const reviewGateStep = createStep({
  id: "reviewGate",
  inputSchema: LinkScanStateSchema,
  outputSchema: LinkScanStateSchema,
  resumeSchema: LinkScanReviewResumeSchema,
  suspendSchema: LinkScanReviewSuspendSchema,
  execute: async ({ inputData, resumeData, suspend }) => {
    const state = asState(inputData);
    const candidates = state.candidates ?? [];
    const skipped = state.skipped ?? [];

    // Nothing survived the junk/US filters (or nothing was pending at all):
    // there is nothing to review and nothing to navigate — the gate
    // auto-passes with an EMPTY approved set. The junk/US skip marks still
    // reach persist; zero-pending stays a 0/0 done.
    if (candidates.length === 0 && resumeData === undefined) {
      return { ...state, approvedSourceIds: [] };
    }

    // First pass: render the review card (gate before prose). Each row is one
    // LINK: the generic dealer_id key carries the SOURCE id, website carries
    // the link URL. Nothing has been written and no page has been opened.
    if (resumeData === undefined) {
      return (await suspend({
        kind: "batch_review",
        question: LINK_SCAN_REVIEW_QUESTION,
        targets: candidates.map((c) => ({
          dealer_id: c.source_id,
          name: c.dealer_name,
          website: c.source_url,
        })),
        skipped: skipped.map((s) => ({
          dealer_id: s.source_id,
          name: s.dealer_name,
          reason: s.reason,
        })),
        total_targets: candidates.length,
        total_in_radius: state.totalPending,
      })) as never;
    }

    // Explicitly re-parse the resume (the schema is the authority).
    const resume = LinkScanReviewResumeSchema.parse(resumeData);

    // decline → terminal, ZERO writes (every later step passes through).
    if (resume.action === "decline") {
      return { ...state, declined: true };
    }

    // approve → the explicit id list IS the scan set. The server seam already
    // rejected ids outside the reviewed rows; the intersection here is
    // defense-in-depth (an id that slipped through scans nothing).
    const candidateIds = new Set(candidates.map((c) => c.source_id));
    const approved = [...new Set(resume.approved_dealer_ids)].filter((id) =>
      candidateIds.has(id),
    );
    if (approved.length === 0) {
      throw new Error(
        "reviewGate: approved ids resolved to zero reviewed links — refusing to scan",
      );
    }
    return { ...state, approvedSourceIds: approved };
  },
});

// ---------------------------------------------------------------------------
// step 5 — visitExtract (PURE CAPTURE + the LLM phase; zero DB writes)
// ---------------------------------------------------------------------------

const visitExtractStep = createStep({
  id: "visitExtract",
  inputSchema: LinkScanStateSchema,
  outputSchema: LinkScanStateSchema,
  execute: async ({ inputData, runId }) => {
    const state = asState(inputData);
    if (state.declined) return state; // pass-through (zero capture, zero write).

    const approvedIds = new Set(state.approvedSourceIds ?? []);
    const approved = (state.candidates ?? []).filter((c) => approvedIds.has(c.source_id));

    // The supersession watermark is minted BEFORE any capture so every row
    // this run writes is observed at-or-after it.
    const runStartedAt = new Date().toISOString();

    if (approved.length === 0) {
      linkScanCarryByRun.set(runId, { captures: new Map(), classified: new Map() });
      return { ...state, runStartedAt, captured: [] };
    }

    const bySourceId = new Map(approved.map((c) => [c.source_id, c]));
    const outcomes = await deps().captureLinks({
      runId,
      targets: approved.map((c) => ({ sourceId: c.source_id, url: c.source_url })),
      emitter: browserEmitterFactory(runId),
    });

    // Heavy capture data goes into the in-process carry; the step output
    // keeps light rows + counters only.
    const carry: LinkScanCarry = { captures: new Map(), classified: new Map() };
    let snapshotFallbacks = 0;
    const captured = outcomes.map((o) => {
      const source = bySourceId.get(o.sourceId);
      if (o.status === "scanned" && o.snapshotText !== null) {
        carry.captures.set(o.sourceId, {
          snapshotText: o.snapshotText,
          cardHrefs: o.cardHrefs,
        });
      }
      if (o.snapshotFallback) snapshotFallbacks += 1;
      return {
        source_id: o.sourceId,
        dealer_id: source?.dealer_id ?? "",
        source_url: source?.source_url ?? "",
        status: o.status,
        error_json: o.errorJson,
      };
    });
    linkScanCarryByRun.set(runId, carry);

    // ---- the LLM phase: per scanned link ONE no-tools structured call ------
    try {
      let urlsScanned = 0;
      let listingsFound = 0;
      let listingsMatched = 0;
      let rowsRejectedMismatch = 0;
      let rowsRejectedUnknown = 0;
      let rowsInvalidDropped = 0;
      let vinProvenanceDropped = 0;
      let urlProvenanceStripped = 0;

      const scanned = captured.filter((c) => c.status === "scanned");
      await runWorkerPool(EXTRACT_CONCURRENCY, scanned.length, async (i) => {
        const row = scanned[i]!;
        const capture = carry.captures.get(row.source_id);
        if (capture === undefined) throw new InventoryLinkScanCaptureLostError();

        const result = await recoverEmitWithRetry({
          harnessGenerate: deps().harnessGenerate,
          input: {
            useCase: "inventory_extract",
            schema: InventoryExtractSchema,
            prompt: buildInventoryExtractPrompt(state.make, state.model, capture.snapshotText),
            // A malformed tool call retries ONCE on the strong+thinking lane,
            // else fail-closes — never a prose fallthrough, never a regexed-out
            // tool call.
            hitlAvailable: false,
          },
          retryUseCase: "inventory_extract_retry",
          ledger: linkScanLedger(runId),
        });

        // URL-provenance set: the collected card hrefs PLUS the link itself
        // (a card-less VDP capture has no hrefs, but the page's own URL is
        // first-party provenance — we navigated it).
        const collectedUrls = new Set(capture.cardHrefs.map((h) => normalizeListingUrl(h)));
        collectedUrls.add(normalizeListingUrl(row.source_url));

        const classified: ClassifiedListingRow[] = [];
        for (const raw of result.object.listings) {
          // Zod is the authority on every row; a drifted row drops + counts.
          const parsed = InventoryListingSchema.safeParse(raw);
          if (!parsed.success) {
            rowsInvalidDropped += 1;
            continue;
          }
          const listing: InventoryListing = parsed.data;

          // An LLM-emitted VIN must appear VERBATIM in the snapshot the model
          // actually saw — anything else is a hallucination; the row drops.
          const vin = listing.vin === "" ? null : listing.vin;
          if (vin !== null && !validateVinProvenance(vin, capture.snapshotText)) {
            vinProvenanceDropped += 1;
            continue;
          }

          // URL provenance: an emitted listing_url outside the provenance set
          // was invented — treat it as ABSENT (null, counted); the row still
          // stands on its VIN if any.
          let listingUrl = listing.listing_url === "" ? null : listing.listing_url;
          if (listingUrl !== null && !collectedUrls.has(normalizeListingUrl(listingUrl))) {
            listingUrl = null;
            urlProvenanceStripped += 1;
          }

          const matchStatus = classifyMatchStatus(
            state.year,
            state.make,
            state.model,
            state.trim,
            state.acceptableTrims,
            listing.year,
            listing.make,
            listing.model,
            listing.trim,
          );
          classified.push({
            listing: { ...listing, vin, listing_url: listingUrl },
            matchStatus,
            raw: { ...raw },
          });
          listingsFound += 1;
        }

        // Deterministic profile filter: persist receives exact|near rows only.
        const filtered = filterForProfile(classified);
        for (const rejection of filtered.rejected) {
          if (rejection.reason === "trim_or_year_mismatch") rowsRejectedMismatch += 1;
          else rowsRejectedUnknown += 1;
        }
        listingsMatched += filtered.accepted.length;
        carry.classified.set(row.source_id, filtered.accepted);
        urlsScanned += 1;
      });

      return {
        ...state,
        runStartedAt,
        captured,
        snapshotFallbacks,
        urlsScanned,
        listingsFound,
        listingsMatched,
        rowsRejectedMismatch,
        rowsRejectedUnknown,
        rowsInvalidDropped,
        vinProvenanceDropped,
        urlProvenanceStripped,
      };
    } catch (err) {
      // A failed extract phase fails the run — release the carry so the heavy
      // snapshots never outlive the run.
      linkScanCarryByRun.delete(runId);
      throw err;
    }
  },
});

// ---------------------------------------------------------------------------
// step 6 — persist (the ONLY DB write of the whole run)
// ---------------------------------------------------------------------------

const persistStep = createStep({
  id: "persist",
  inputSchema: LinkScanStateSchema,
  outputSchema: LinkScanStateSchema,
  execute: async ({ inputData, runId }) => {
    const state = asState(inputData);
    if (state.declined) return state; // terminal decline: ZERO writes.

    const carry = linkScanCarryByRun.get(runId);
    try {
      const captured = state.captured ?? [];
      if (carry === undefined && captured.some((c) => c.status === "scanned")) {
        throw new InventoryLinkScanCaptureLostError();
      }

      // Capture-then-serial: the ONE write of the whole run. Junk/US skips are
      // status marks on existing pending rows; scanned links carry their
      // accepted rows; the writer owns the dual-arm upsert, VIN-promotion and
      // the scanned-only supersession gate. Card-skipped links appear in NO
      // outcome — they stay pending for the next run.
      const outcomes: DealerScanOutcome[] = [
        ...(state.skipped ?? []).map((s) => ({
          dealerId: s.dealer_id,
          sourceUrl: s.source_url,
          status: "skipped" as const,
          errorJson: JSON.stringify(
            s.reason === "non_us_dealer"
              ? { reason: "non_us_dealer" }
              : { reason: "non_inventory_url", rule: s.reason },
          ),
        })),
        ...captured.map((c) => ({
          dealerId: c.dealer_id,
          sourceUrl: c.source_url,
          status: c.status,
          errorJson: c.error_json,
          rows: c.status === "scanned" ? (carry?.classified.get(c.source_id) ?? []) : [],
        })),
      ];

      const runStartedAt = state.runStartedAt ?? new Date().toISOString();
      const persist = deps().persistScan({
        searchProfileId: state.searchProfileId,
        runStartedAt,
        outcomes,
        db: deps().getDb(),
      });
      return { ...state, persist };
    } finally {
      linkScanCarryByRun.delete(runId); // the heavy capture never outlives the run
    }
  },
});

// ---------------------------------------------------------------------------
// step 7 — confirm (deterministic ZERO-LLM template)
// ---------------------------------------------------------------------------

const confirmStep = createStep({
  id: "confirm",
  inputSchema: LinkScanStateSchema,
  outputSchema: LinkScanOutputSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) {
      return { outcome: "declined" as const };
    }

    const persist = state.persist ?? {
      sourcesScanned: 0,
      sourcesBlocked: 0,
      sourcesSkipped: 0,
      sourcesFailed: 0,
      listingsWritten: 0,
      vinPromoted: 0,
      droppedNoKey: 0,
      staleSuperseded: 0,
    };
    const approvedCount = (state.approvedSourceIds ?? []).length;
    const rowsRejected = state.rowsRejectedMismatch + state.rowsRejectedUnknown;

    let summary: string;
    if (state.totalPending === 0) {
      summary =
        "No pending inventory links to scan. These are queued automatically from " +
        "dealer email replies (via dealer_reply_extract) or manual seeding — not " +
        "from a URL pasted into chat, so a pasted link is not picked up here. " +
        "Nothing was opened and nothing was written.";
    } else if (approvedCount === 0) {
      summary =
        `All ${state.totalPending} pending link(s) were filtered before review ` +
        `(${persist.sourcesSkipped} marked skipped: junk/non-US). Nothing was ` +
        "opened and no listings were written.";
    } else {
      summary =
        `Scanned ${persist.sourcesScanned} of ${approvedCount} approved link(s)` +
        (persist.sourcesBlocked > 0 ? `, ${persist.sourcesBlocked} blocked` : "") +
        (persist.sourcesFailed > 0 ? `, ${persist.sourcesFailed} failed` : "") +
        (persist.sourcesSkipped > 0
          ? `; ${persist.sourcesSkipped} link(s) skipped before review (junk/non-US)`
          : "") +
        `. Found ${state.listingsFound} listing(s), ${state.listingsMatched} matched ` +
        `the profile, ${persist.listingsWritten} written/refreshed` +
        (persist.vinPromoted > 0 ? `, ${persist.vinPromoted} VIN-promoted` : "") +
        (persist.staleSuperseded > 0 ? `, ${persist.staleSuperseded} stale retired` : "") +
        (rowsRejected > 0 ? `; ${rowsRejected} non-matching row(s) dropped` : "") +
        (state.rowsInvalidDropped + state.vinProvenanceDropped > 0
          ? `, ${state.rowsInvalidDropped + state.vinProvenanceDropped} row(s) dropped`
          : "") +
        (state.urlProvenanceStripped > 0
          ? `, ${state.urlProvenanceStripped} unverifiable URL(s) cleared`
          : "") +
        (state.snapshotFallbacks > 0
          ? `. ${state.snapshotFallbacks} page(s) used the plain-text snapshot fallback.`
          : ".");
    }

    return {
      outcome: "scanned" as const,
      searchProfileId: state.searchProfileId,
      resolution: state.resolution,
      urlsScanned: state.urlsScanned,
      listingsMatched: state.listingsMatched,
      listingsFound: state.listingsFound,
      listingsWritten: persist.listingsWritten,
      sourcesApproved: approvedCount,
      sourcesSkipped: persist.sourcesSkipped,
      sourcesBlocked: persist.sourcesBlocked,
      sourcesFailed: persist.sourcesFailed,
      rowsRejected,
      rowsInvalidDropped: state.rowsInvalidDropped,
      vinProvenanceDropped: state.vinProvenanceDropped,
      urlProvenanceStripped: state.urlProvenanceStripped,
      vinPromoted: persist.vinPromoted,
      staleSuperseded: persist.staleSuperseded,
      summary,
    };
  },
});

// ---------------------------------------------------------------------------
// the flat workflow (8 steps, .then() chain, .commit())
// ---------------------------------------------------------------------------

export const inventoryLinkScanWorkflow = createWorkflow({
  id: "inventory_link_scan",
  inputSchema: LinkScanInputSchema,
  outputSchema: LinkScanOutputSchema,
})
  .then(resolveProfileStep)
  .then(loadSourcesStep)
  .then(filterJunkStep)
  .then(usGateStep)
  .then(reviewGateStep)
  .then(visitExtractStep)
  .then(persistStep)
  .then(confirmStep)
  .commit();

/** The workflow id, exported for registration + runtimeGlue workflowIds. */
export const INVENTORY_LINK_SCAN_WORKFLOW_ID = "inventory_link_scan" as const;
