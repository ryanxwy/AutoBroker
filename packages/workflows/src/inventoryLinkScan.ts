/**
 * inventory_link_scan — skill #4 (the link-driven sibling of
 * inventory_site_scan). Visits NOT-YET-SCANNED dealer inventory URLs
 * (dealer_inventory_sources rows with last_status='pending'), junk-filters
 * them, gates EVERYTHING behind one batch_review suspend BEFORE any
 * navigation, captures each approved page read-only, extracts listings with
 * the shared `inventory_extract` posture, and persists through the shared
 * dual-arm (VIN + normalized-URL) upsert writer.
 *
 * THIS COMMIT: the skill CONTRACT only — typed STOP errors, the review-card
 * skip vocabulary, the suspend payload schema, the workflow input/output
 * schemas. The flat workflow steps land next (the 7-step build loop's
 * step-③ scaffold).
 *
 * CONTRACT NOTES (load-bearing):
 *   - The review card is the SAME component + wire shape as
 *     inventory_site_scan's batch_review card (one card, one kind, one testid
 *     vocabulary — never a link_scan fork). On this skill each card ROW is one
 *     pending LINK, so the generic row keys carry link semantics:
 *       targets[].dealer_id  = the SOURCE id (the row identity the resume
 *                              approves — unique per link even when one dealer
 *                              contributed several links);
 *       targets[].name       = the dealer's name (the human label);
 *       targets[].website    = the link URL itself (the card renders its host);
 *       total_in_radius      = total pending links loaded (the card's
 *                              "N of M" header denominator).
 *   - The resume vocabulary is REUSED VERBATIM from inventory_site_scan
 *     (`BatchReviewResumeSchema`): an explicit approved-id list (min 1) or a
 *     decline. There is no approve-all wire member; decline = terminal, ZERO
 *     navigation, ZERO writes.
 *   - Pre-review skips (junk rules + the US gate) are surfaced on the card's
 *     skipped section and marked last_status='skipped' ONLY at the persist
 *     step (post-approval) — the gate-front steps never touch the DB.
 *   - dev-period sources are manual/seeded rows; the dealer_reply_extract
 *     handoff (reply_link rows written by the email pipeline) arrives with
 *     that later skill — loadSources reads pending rows only.
 *
 * Dependency wall: this contract slice imports zod + the sibling skill module
 * (the shared resume schema). The workflow steps will add @autobroker/tools /
 * the harness facade exactly like inventory_site_scan.
 */

import { z } from "zod";

import { BatchReviewResumeSchema } from "./inventorySiteScan.js";

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
 * Wire-identical to inventory_site_scan's payload shape; see the header for
 * how the generic row keys carry link semantics (dealer_id = SOURCE id,
 * website = the link URL, total_in_radius = total pending links). IDs + short
 * labels only — the payload must stay small (<8KB; the harness re-asserts the
 * bound on every live sighting).
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
