/**
 * pipeline_reset contracts — the typed input/output, the ONE typed-YES
 * confirmation-gate suspend payload + its resume vocabulary, and the workflow id.
 * Skill-local, single-use (the workflow file + the server descriptor + their
 * tests import them), kept out of the shared core layer like the other skills'
 * contracts.
 *
 * DESTRUCTIVE skill. ONE typed-YES second-confirm suspend. No confirmation →
 * ZERO destruction. The 5 consequence_lines are PLAIN SPEECH that NEVER name a
 * table and that EXPLICITLY state in-flight skill runs / workflow runtime state
 * will be cleared. The token is re-validated SERVER-SIDE in the resume handler
 * (verbatim YES, case-insensitive) — the workflow never trusts the client/LLM.
 *
 * ZERO-LLM: the whole pipeline (gate, close-out stub, backup, reset, verify,
 * notify, confirm) is deterministic; there is no emit schema, no structured-output surface.
 *
 * Dependency wall: imports zod only.
 */

import { z } from "zod";

/** The stable workflow id (registration + the server descriptor). */
export const PIPELINE_RESET_WORKFLOW_ID = "pipeline_reset" as const;

/** The literal confirmation token the typed-YES gate requires. */
export const PIPELINE_RESET_CONFIRM_TOKEN = "YES" as const;

/**
 * The 5 plain-speech consequence lines the destructive gate renders. They NEVER
 * name a table or a file; the FOURTH line explicitly states that in-flight skill
 * runs / workflow runtime state will be cleared (the mastra.db reset). Frozen
 * here so the card, the harness, and the safety review read the same text.
 */
export const PIPELINE_RESET_CONSEQUENCE_LINES: readonly [
  string,
  string,
  string,
  string,
  string,
] = [
  "I'll close out your active dealers first, then erase all of your local pipeline data.",
  "Every search profile, dealer, message, quote, and saved result on this machine will be permanently deleted.",
  "I'll save a one-time local backup just before erasing, in case you need to recover.",
  "Any skill run that is still in progress, and anything waiting on your approval, will be cleared too.",
  "After the reset there is no undo from the app — you'll start over from a clean intake.",
];

// ---------------------------------------------------------------------------
// workflow input / output
// ---------------------------------------------------------------------------

/**
 * The workflow input (the server descriptor builds this from the start body).
 * `search_profile_id` is PRO FORMA — pipeline_reset is non-profile-scoped (a
 * full wipe), so the wipe ignores it; it is accepted only to match the standard
 * skill input shape.
 */
export const PipelineResetInputSchema = z.object({
  search_profile_id: z.string().nullable(),
});
export type PipelineResetInput = z.infer<typeof PipelineResetInputSchema>;

/**
 * The workflow output — reset | declined union. `reset` carries the verified
 * table count + the backup path; `declined` (a decline/cancel at the typed-YES
 * gate) means ZERO destruction for the whole run.
 */
export const PipelineResetOutputSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("reset"),
    databaseReset: z.literal(true),
    tablesCreated: z.number().int(),
    backupPath: z.string(),
    summary: z.string(),
  }),
  z.object({ outcome: z.literal("declined") }),
]);
export type PipelineResetOutput = z.infer<typeof PipelineResetOutputSchema>;

// ---------------------------------------------------------------------------
// the ONE typed-YES confirmation-gate suspend payload
// ---------------------------------------------------------------------------

/**
 * The suspend payload the destructive confirmation_gate renders. `destructive`
 * is always true; `confirm_token` echoes the literal word the user must type
 * back (the client validates before POST, the SERVER re-validates on resume);
 * `consequence_lines` is exactly the 5 plain-speech lines.
 */
export const PipelineResetGateSuspendSchema = z
  .object({
    kind: z.literal("confirmation_gate"),
    destructive: z.literal(true),
    /** The literal word the user must type back (display + client pre-check). */
    confirm_token: z.literal(PIPELINE_RESET_CONFIRM_TOKEN),
    question: z.string(),
    /** Exactly 5 plain-speech lines; never names a table. */
    consequence_lines: z.array(z.string()).length(5),
  })
  .strict();
export type PipelineResetGateSuspend = z.infer<typeof PipelineResetGateSuspendSchema>;

// ---------------------------------------------------------------------------
// the typed-YES resume vocabulary
// ---------------------------------------------------------------------------

/**
 * The resume — a confirm carrying the typed token, or a decline. The workflow
 * trusts ONLY validateResetToken on the carried token (verbatim YES,
 * case-insensitive) — a confirm with a non-YES token is treated as a decline
 * (no destruction). decline/cancel is terminal (zero destruction).
 */
export const PipelineResetResumeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm"), confirm_token: z.string() }),
  z.object({ action: z.literal("decline") }),
]);
export type PipelineResetResume = z.infer<typeof PipelineResetResumeSchema>;
