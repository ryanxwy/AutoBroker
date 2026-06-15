/**
 * daily_digest contracts — the typed input/output the dailyDigest workflow and
 * the server descriptor share. Skill-local, single-use (only the workflow file
 * and its tests import them), kept out of the shared core layer like the other
 * skills' contracts.
 *
 * PROFILE SCOPE — multi-active enumerate, NO ASK (the documented exception to
 * the single-profile three-branch rule). A pinned id scopes to that one search;
 * an unpinned (null) input enumerates EVERY active profile (the legacy
 * multi-search digest payload). Zero active profiles → a GRACEFUL SKIP
 * (`outcome: "skipped"`, reason `no_active_profile`, points at intake), NOT a
 * hard STOP. This makes the registry posture `infer_ok` (not `pin_required`):
 * the workflow's own resolveScope step is the behavioral gate, never a UI block.
 *
 * NO suspend, NO HITL, NO LLM step — the whole digest is deterministic
 * (counts → 7-section template). The zero-active skip is a SUCCESS outcome.
 *
 * Dependency wall: imports zod only.
 */

import { z } from "zod";

// The stable workflow id lives with the workflow (dailyDigest.ts) — the single
// canonical source the registry/server descriptor/registration all resolve to.

// ---------------------------------------------------------------------------
// workflow input / output
// ---------------------------------------------------------------------------

/** The workflow input. `search_profile_id` null → every active profile;
 *  `since_hours` is the optional "new since" window for the counters. */
export const DailyDigestInputSchema = z.object({
  search_profile_id: z.string().nullable(),
  since_hours: z.number().nullable().optional(),
});
export type DailyDigestInput = z.infer<typeof DailyDigestInputSchema>;

/**
 * The workflow output — generated | skipped union. `generated` carries the
 * artifact path + the counts the confirm template surfaces (every number, no
 * budget, no hex run id). `skipped` (zero active profiles) is a VALID success,
 * never an error — it points the user at intake.
 */
export const DailyDigestOutputSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("generated"),
    /** The single pinned profile, or null on the multi-active enumerate. */
    searchProfileId: z.string().nullable(),
    artifactPath: z.string(),
    sectionsCount: z.number().int(),
    profilesSummarized: z.number().int(),
    bestOtd: z.number().nullable(),
    summary: z.string(),
  }),
  z.object({
    outcome: z.literal("skipped"),
    reason: z.literal("no_active_profile"),
    summary: z.string(),
  }),
]);
export type DailyDigestOutput = z.infer<typeof DailyDigestOutputSchema>;
