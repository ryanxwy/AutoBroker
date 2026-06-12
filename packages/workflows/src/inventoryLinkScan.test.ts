/**
 * inventory_link_scan — contract tests (the workflow steps' tests land with
 * the scaffold). Pins the load-bearing contract facts:
 *   - the suspend payload is wire-identical to the shared batch_review card
 *     shape (generic row keys; the skip-reason enum is the closed link_scan
 *     vocabulary — junk rules + the US gate);
 *   - the resume schema IS inventory_site_scan's (one wire contract across
 *     both scan skills — explicit id list min 1, decline, no approve-all);
 *   - the output contract carries the typed counts (urlsScanned /
 *     listingsMatched headline pair) and the declined member.
 */

import { describe, expect, it } from "vitest";

import { BatchReviewResumeSchema } from "./inventorySiteScan.js";
import {
  InventoryLinkScanStopError,
  LINK_SCAN_REVIEW_QUESTION,
  LinkScanOutputSchema,
  LinkScanReviewResumeSchema,
  LinkScanReviewSuspendSchema,
} from "./inventoryLinkScan.js";

describe("inventory_link_scan contract", () => {
  it("the suspend payload parses the shared batch_review card shape (source-id rows)", () => {
    const payload = {
      kind: "batch_review",
      question: LINK_SCAN_REVIEW_QUESTION,
      targets: [
        {
          dealer_id: "src_aaaaaaaaaaaaaaaa", // the SOURCE id is the row identity
          name: "Tustin Hyundai",
          website: "https://www.tustinhyundai.com/new-inventory/index.htm?model=Tucson",
        },
      ],
      skipped: [
        { dealer_id: "src_bbbbbbbbbbbbbbbb", name: "Tustin Hyundai", reason: "bare_homepage" },
        { dealer_id: "src_cccccccccccccccc", name: "Maple Toronto", reason: "non_us_dealer" },
      ],
      total_targets: 1,
      total_in_radius: 3,
    };
    expect(LinkScanReviewSuspendSchema.parse(payload)).toEqual(payload);
  });

  it("rejects a skip reason outside the closed vocabulary (a typo never renders)", () => {
    const bad = {
      kind: "batch_review",
      question: LINK_SCAN_REVIEW_QUESTION,
      targets: [],
      skipped: [{ dealer_id: "src_x", name: "X", reason: "not_a_reason" }],
      total_targets: 0,
      total_in_radius: 1,
    };
    expect(() => LinkScanReviewSuspendSchema.parse(bad)).toThrow();
  });

  it("the resume schema IS the shared batch_review resume (same object, same vocabulary)", () => {
    expect(LinkScanReviewResumeSchema).toBe(BatchReviewResumeSchema);
    expect(
      LinkScanReviewResumeSchema.parse({
        action: "approve",
        approved_dealer_ids: ["src_aaaaaaaaaaaaaaaa"],
      }),
    ).toEqual({ action: "approve", approved_dealer_ids: ["src_aaaaaaaaaaaaaaaa"] });
    expect(LinkScanReviewResumeSchema.parse({ action: "decline" })).toEqual({
      action: "decline",
    });
    // min-1: an empty approve list never reaches the workflow.
    expect(() =>
      LinkScanReviewResumeSchema.parse({ action: "approve", approved_dealer_ids: [] }),
    ).toThrow();
  });

  it("the output contract carries the typed counts and the declined member", () => {
    const scanned = LinkScanOutputSchema.parse({
      outcome: "scanned",
      searchProfileId: "prof-1",
      resolution: "inferred_newest",
      urlsScanned: 2,
      listingsMatched: 5,
      listingsFound: 7,
      listingsWritten: 5,
      sourcesApproved: 2,
      sourcesSkipped: 1,
      sourcesBlocked: 0,
      sourcesFailed: 0,
      rowsRejected: 2,
      rowsInvalidDropped: 0,
      vinProvenanceDropped: 0,
      urlProvenanceStripped: 0,
      vinPromoted: 0,
      staleSuperseded: 0,
      summary: "Scanned 2 of 2 approved link(s).",
    });
    expect(scanned.outcome).toBe("scanned");
    expect(LinkScanOutputSchema.parse({ outcome: "declined" })).toEqual({
      outcome: "declined",
    });
  });

  it("the typed STOP error carries its code and name", () => {
    const err = new InventoryLinkScanStopError("no_active_profile", "No active search profile.");
    expect(err.code).toBe("no_active_profile");
    expect(err.name).toBe("InventoryLinkScanStopError");
  });
});
