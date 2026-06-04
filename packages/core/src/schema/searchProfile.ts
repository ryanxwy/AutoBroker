/**
 * SearchProfile — one active new-car search for an (account, brand).
 *
 * STUB: identity fields + lifecycle status; TODO for location/contact/financing
 * preferences written by search_profile_intake (Phase 1, root dependency).
 *
 * Invariants this contract underpins (legacy CLAUDE.md §Constraints + W-C):
 *   - New cars only.
 *   - One `active` profile per (account, brand).
 *   - Identity fields editable in place UNTIL the first lead_submissions row;
 *     after first outbound, edits prompt Replace (new active profile,
 *     supersedes old) or Cancel.
 *   - Trim must be present and LLM-verified at intake (force-override audited).
 *   - profile-ASK three-branch resolution (exactly-1 / 0 / 2+) is enforced by
 *     the resolver in the tools/workflows layer; the resolver returns a TYPED
 *     result distinguishing `pinned` vs `inferred-newest` (W-C). This schema is
 *     just the row shape.
 *
 * This file MUST NOT import any framework. Pure types + Zod only.
 */

import { z } from "zod";

export const SearchProfileStatusSchema = z.enum([
  "active",
  /** Superseded by a Replace after first outbound; kept for history. */
  "superseded",
  /** Closed out (e.g. before pipeline_reset / closeout). */
  "closed",
]);
export type SearchProfileStatus = z.infer<typeof SearchProfileStatusSchema>;

export const SearchProfileSchema = z
  .object({
    /** Integer PK mirroring the DB autoincrement id — keep in lockstep with
     *  DealerQuote.search_profile_id and SessionThread.pinnedSearchProfileId. */
    id: z.number().int().describe("Stable profile id (resolver returns this)."),
    /** Gmail account that owns the search. */
    account: z.string(),
    /** Brand the search targets; (account, brand) is the active-uniqueness key. */
    brand: z.string(),

    // --- identity (editable in place until first lead_submissions row) -------
    year: z.number().int().describe("Model year; new cars only."),
    make: z.string(),
    model: z.string(),
    /** Trim must be present and LLM-verified at intake; null only mid-intake. */
    trim: z.string().nullable(),
    location: z.string().describe("Search origin (geosearch anchor)."),

    status: SearchProfileStatusSchema,

    // TODO: contact surface — fake_phone default (real only on explicit opt-in),
    //       contact_email; financing prefs (financing_mode, budget kept LOCAL and
    //       NEVER sent to a dealer — _redact_budget); radius_miles; trim_verified
    //       + force_override audit ref; first_outbound_at (locks identity edits);
    //       superseded_by FK.
  })
  .strict()
  .describe("One (account, brand) new-car search; row shape, not the resolver.");

export type SearchProfile = z.infer<typeof SearchProfileSchema>;
