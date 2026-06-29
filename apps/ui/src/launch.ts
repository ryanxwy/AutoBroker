/**
 * launch — the intake launch orchestration. The intake entries (the canvas
 * empty-state CTA, the Searches popover "+ New search", and the Skills popover
 * Run on intake) all funnel through `launchIntake`, which forces a fresh unpinned
 * session (never inherit a stale pin) and POSTs the start in slash mode
 * (input_mode 'slash', form direct). Free-form prose is no longer launched here —
 * it goes through the NL router (POST /api/route), which classifies it and, when
 * it picks intake, creates the freeform intake run server-side.
 *
 * The launch returns the StartAck (run_id + session_id + scope_notice); the caller
 * navigates to /runs/:run_id and the single SSE hook drives it from there.
 *
 * Framework-thin: imports the api client + wire types only. No React (the caller
 * owns navigation + store binding); kept pure for unit testing.
 */

import { type ApiClient } from "./api/client.js";
import { type AgentSelection, type StartAck } from "./api/wire.js";

/** The intake start surface (slash mode). Free-form prose routes via the NL
 *  router (POST /api/route), not here. */
export type LaunchMode = { kind: "slash"; seedFields?: Record<string, unknown> | null };

export interface LaunchArgs {
  mode: LaunchMode;
  /** The session intake was triggered from (its pin, if any, drives the fork +
   *  scope notice). null/omitted = first launch — the fork still happens (a
   *  fresh unpinned session with no notice), so every rail intake run has a
   *  session home the popover can re-enter later. */
  fromSessionId?: string | null;
  /** The AgentBar's per-run provider selection — passed ONLY when the user made
   *  an explicit choice (dirty); omitted lets the server default win. */
  agent?: AgentSelection;
}

/** Start a NON-intake skill run in slash mode (the generic skill-run start).
 *  Same StartAck contract as intake, but no fork: only intake forces the
 *  fresh-unpinned fork semantics. When the rail is on a session, `sessionId`
 *  links the run to it (the durable bound-turn the popover pill reads); a
 *  session-less rail starts headless. `args` (slash key=value pairs / the
 *  STOP-picker's search_profile_id) spread into the POST body — the skill's
 *  own RunDescriptor validates its slice server-side (unknown skill → 400,
 *  bad field → 400 content_invalid). */
export async function launchSkill(
  client: ApiClient,
  args: {
    skill: string;
    args?: Record<string, unknown>;
    sessionId?: string | null;
    agent?: AgentSelection;
  },
): Promise<StartAck> {
  return client.startRun({
    ...(args.args ?? {}),
    skill: args.skill,
    input_mode: "slash",
    ...(args.sessionId != null ? { session_id: args.sessionId } : {}),
    ...(args.agent !== undefined ? { agent: args.agent } : {}),
  });
}

/** Start an intake run. ALWAYS forks a fresh unpinned session from the current
 *  one (a stale pin never leaks into a new search; a first launch forks from
 *  nothing) — from_session_id is sent even when null so the server-side fork
 *  rule fires and the run lands in a durable session. */
export async function launchIntake(client: ApiClient, args: LaunchArgs): Promise<StartAck> {
  return client.startRun({
    skill: "search_profile_intake" as const,
    from_session_id: args.fromSessionId ?? null,
    input_mode: "slash",
    ...(args.mode.seedFields !== undefined ? { seed_fields: args.mode.seedFields } : {}),
    ...(args.agent !== undefined ? { agent: args.agent } : {}),
  });
}
