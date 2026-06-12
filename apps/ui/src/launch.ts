/**
 * launch — the intake launch orchestration. The intake entries (the canvas
 * empty-state CTA, the Searches popover "+ New search", and the Skills popover
 * Run on intake) all funnel through `launchIntake`, which forces a fresh unpinned
 * session (never inherit a stale pin) and POSTs the start. Two start surfaces:
 *
 *   - slash  (`/search_profile_intake`) → input_mode 'slash', form direct (no
 *     prefill step).
 *   - freeform (prose) → input_mode 'freeform' with freeform_text; the workflow's
 *     prefill step extracts a nullable subset to SEED the form. Extraction never
 *     writes the DB — the form still renders for human confirm.
 *
 * The launch returns the StartAck (run_id + session_id + scope_notice); the caller
 * navigates to /runs/:run_id and the single SSE hook drives it from there.
 *
 * Framework-thin: imports the api client + wire types only. No React (the caller
 * owns navigation + store binding); kept pure for unit testing.
 */

import { type ApiClient } from "./api/client.js";
import { type StartAck } from "./api/wire.js";

/** The two intake start surfaces. */
export type LaunchMode =
  | { kind: "slash"; seedFields?: Record<string, unknown> | null }
  | { kind: "freeform"; freeformText: string };

export interface LaunchArgs {
  mode: LaunchMode;
  /** The session intake was triggered from (its pin, if any, drives the fork +
   *  scope notice). null/omitted = first launch — the fork still happens (a
   *  fresh unpinned session with no notice), so every rail intake run has a
   *  session home the popover can re-enter later. */
  fromSessionId?: string | null;
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
  args: { skill: string; args?: Record<string, unknown>; sessionId?: string | null },
): Promise<StartAck> {
  return client.startRun({
    ...(args.args ?? {}),
    skill: args.skill,
    input_mode: "slash",
    ...(args.sessionId != null ? { session_id: args.sessionId } : {}),
  });
}

/** Start an intake run. ALWAYS forks a fresh unpinned session from the current
 *  one (a stale pin never leaks into a new search; a first launch forks from
 *  nothing) — from_session_id is sent even when null so the server-side fork
 *  rule fires and the run lands in a durable session. */
export async function launchIntake(client: ApiClient, args: LaunchArgs): Promise<StartAck> {
  const base = {
    skill: "search_profile_intake" as const,
    from_session_id: args.fromSessionId ?? null,
  };
  if (args.mode.kind === "freeform") {
    return client.startRun({
      ...base,
      input_mode: "freeform",
      freeform_text: args.mode.freeformText,
    });
  }
  return client.startRun({
    ...base,
    input_mode: "slash",
    ...(args.mode.seedFields !== undefined ? { seed_fields: args.mode.seedFields } : {}),
  });
}
