/**
 * SessionThread — the product projection of a dashboard chat-rail session.
 *
 * PROVENANCE (PHASE_0_foundation §2 core deliverables; ARCH_ORCHESTRATION_
 * SESSIONS §3 "Sessions = Memory threads"): one chat rail = one Mastra Memory
 * thread, bound to one search profile; the local user is the `resourceId`.
 * The pinned-profile binding lives in thread metadata + working memory — NOT
 * buried in the transcript (the oracle's per-turn pin-reminder workaround dies
 * here). Skill runs triggered from a rail link back via runId ↔ thread
 * metadata.
 *
 * This is a PRODUCT contract (pure Zod, framework-free): Mastra's own thread
 * rows live in mastra.db and are never imported here — higher layers project
 * them onto this shape, exactly like SkillRunStatus projects run status.
 *
 * Schema style (ARCH_STRUCTURED_OUTPUT): flat, all fields required, explicit
 * null over optional.
 */

import { z } from "zod";

export const SessionThreadSchema = z
  .object({
    /** Mastra Memory thread id — the session identity. */
    threadId: z.string().min(1),
    /** Mastra Memory resource id — the local user (single-user product). */
    resourceId: z.string().min(1),
    /** The search profile this rail is bound to (1 rail = 1 thread = 1
     *  profile); null until intake pins one. TEXT id per the introspected
     *  oracle — lockstep with SearchProfile.id. Inferred-newest resolutions
     *  are logged, never silent — see the profile-ASK three-branch contract. */
    pinnedSearchProfileId: z.string().nullable(),
    /** Human-facing rail title; null until first user turn names it. */
    title: z.string().nullable(),
  })
  .strict()
  .describe("Product projection of one chat-rail session (one Memory thread).");

export type SessionThread = z.infer<typeof SessionThreadSchema>;
