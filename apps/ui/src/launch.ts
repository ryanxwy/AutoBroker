/**
 * launch — the intake launch orchestration. Four
 * home/rail entries (Hero CTA, Searches "+ New search", Pipeline Ledger Run,
 * WelcomeWizard) all funnel through `launchIntake`, which forces a fresh unpinned
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
   *  scope notice). Omitted for a true headless / first-launch start. */
  fromSessionId?: string | null;
}

/** Start an intake run. Always forks a fresh unpinned session when a source
 *  session is given so a stale pin never leaks into a new search. */
export async function launchIntake(client: ApiClient, args: LaunchArgs): Promise<StartAck> {
  const base = {
    skill: "search_profile_intake" as const,
    ...(args.fromSessionId !== undefined && args.fromSessionId !== null
      ? { from_session_id: args.fromSessionId }
      : {}),
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
