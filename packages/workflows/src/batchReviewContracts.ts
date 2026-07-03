/**
 * Shared batch_review suspend / resume contracts — the ONE card the irreversible
 * send skills (dealer_web_lead_submit ①, negotiation_followup ①,
 * dealer_closeout_email, dealer_inbox_check) and the link-driven scan
 * (inventory_link_scan) all suspend against, plus the server approval-inbox
 * descriptors and the UI card build. These used to live in inventory_site_scan,
 * but that skill is owner-ratified auto-approve (read-only, no human gate, no
 * suspend), so the shared contract now lives in its own home.
 *
 * The suspend payload is IDs + short labels only; skipped rows carry NO website
 * so the payload stays small (<8KB at a 40-dealer full-radius batch). The resume
 * vocabulary is an EXPLICIT approved-id list or a decline — there is no
 * approve-all member ("select all" is a UI affordance that still sends the full
 * explicit list over the wire).
 *
 * Dependency wall: imports zod + the row-skip vocabulary (SCAN_SKIP_REASONS)
 * from inventory_site_scan. One-way (this module → inventorySiteScan.js); the
 * scan skill imports nothing back, so there is no cycle.
 */

import { z } from "zod";

import { SCAN_SKIP_REASONS } from "./inventorySiteScan.js";

/** The suspend payload (the spec_inline the review card renders). IDs + short
 *  labels only; skipped rows carry NO website — the payload must stay small
 *  (<8KB at a 40-dealer full-radius batch). */
export const BatchReviewSuspendSchema = z.object({
  kind: z.literal("batch_review"),
  question: z.string(),
  targets: z.array(
    z.object({ dealer_id: z.string(), name: z.string(), website: z.string() }),
  ),
  skipped: z.array(
    z.object({
      dealer_id: z.string(),
      name: z.string(),
      reason: z.enum(SCAN_SKIP_REASONS),
    }),
  ),
  total_targets: z.number().int(),
  total_in_radius: z.number().int(),
  // Opt-in: render a "Skip all & reset" action on the review card (the closeout
  // skip-all → pipeline_reset hand-off). OPTIONAL → absent on every other
  // emitter, so no other batch_review payload changes and the button never
  // renders there. Backward-compatible (no other suspend gains a field).
  allow_skip_all: z.boolean().optional(),
  // The primary submit button's label. lead-submit/closeout/negotiation set their
  // own send verb so the reused card reads correctly; absent ⇒ the inventory-scan
  // default ("Scan approved dealers") in the card. OPTIONAL, backward-compatible
  // (like allow_skip_all above — no other emitter changes).
  submit_label: z.string().optional(),
  // Opt-in submission-preview block (lead_submit, owner rule #5): the MINIMAL info
  // shown above the dealer list so the buyer sees what is sent before approving
  // (vehicle, buyer email, placeholder-phone note). Budget is NEVER included (inv #9).
  // MUST be declared here: the step's suspend-schema validation (Mastra
  // validateStepSuspendData, validateInputs default true) re-parses the payload and
  // a plain z.object STRIPS undeclared keys — an undeclared `summary` silently
  // disappears before the card/approval-inbox read it. OPTIONAL → absent on every
  // read-only/scan emitter, backward-compatible (like allow_skip_all/submit_label).
  summary: z
    .object({
      heading: z.string(),
      lines: z.array(z.object({ label: z.string(), value: z.string() })),
    })
    .optional(),
});
export type BatchReviewSuspend = z.infer<typeof BatchReviewSuspendSchema>;

/** The resume vocabulary: an EXPLICIT approved-id list or a decline. There is
 *  no approve-all member — "select all" is a UI affordance that still sends
 *  the full explicit list over the wire. */
export const BatchReviewResumeSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    approved_dealer_ids: z.array(z.string()).min(1),
  }),
  z.object({ action: z.literal("decline") }),
]);
export type BatchReviewResume = z.infer<typeof BatchReviewResumeSchema>;
