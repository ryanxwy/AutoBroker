/**
 * statusProjection — Mastra's 10-value WorkflowRunStatus → the product's 7-value
 * core SkillRunStatus. "The product never re-implements a status machine; it
 * renames one" (core/types.ts SKILL_RUN_STATUSES comment).
 *
 * The 10 live-probed Mastra 1.41 statuses (mastra.ts / runtimeGlue header):
 *   running | success | failed | tripwire | suspended | waiting | pending |
 *   canceled | bailed | paused
 *
 * The 7 product statuses (core SKILL_RUN_STATUSES):
 *   pending | running | awaiting_approval | done | error | declined | aborted
 *
 * THE SUSPENDED FORK (the load-bearing distinction): a Mastra `suspended` run is
 * ALWAYS a HITL pause, but the PRODUCT splits it by WHICH suspend payload kind is
 * pending — a `data_collection` / `ambiguous_location` form maps to
 * `awaiting_approval` (the product's single HITL-suspend projection used for the
 * form gate and approval gates alike; core's enum has no separate `awaiting_user`,
 * see core/types.ts — the awaiting_user/awaiting_approval distinction lives in the
 * SSE *event* vocabulary, not the run-status enum, so both collapse onto
 * `awaiting_approval` here). With no pending payload kind we still report
 * `awaiting_approval` (a suspended run is, by definition, awaiting a human).
 *
 * canceled → the app decides declined-vs-aborted from its own metadata (a user
 * decline at a form vs a stale-run cancel); the projection itself maps bare
 * `canceled` to `aborted` and lets the caller override to `declined` when it
 * knows the cancel came from a decline outcome. `bailed` (an internal early-exit)
 * → `error`. `tripwire` (a guard trip) → `error`.
 *
 * Pure: no Mastra import (it takes the status string + an optional payload-kind
 * hint), no I/O. Unit-tested across all 10 inputs.
 */

import type { SkillRunStatus } from "@autobroker/core";

/** The 10 live-probed Mastra 1.41 WorkflowRunStatus values (mastra.ts header). */
export const MASTRA_RUN_STATUSES = [
  "running",
  "success",
  "failed",
  "tripwire",
  "suspended",
  "waiting",
  "pending",
  "canceled",
  "bailed",
  "paused",
] as const;
export type MastraRunStatus = (typeof MASTRA_RUN_STATUSES)[number];

/**
 * Extra signals the projection needs that the bare Mastra status does not carry.
 *   - `declined`: the app knows this terminal `canceled`/`success` came from a
 *     user decline/cancel at a form gate (intake's terminal {outcome:'declined'}
 *     or a decline form-decision). Forces `declined` over `aborted`/`done`.
 */
export interface ProjectionHints {
  /** The app observed a decline outcome (form decline/cancel, or the workflow's
   *  own terminal {outcome:'declined'}). */
  declined?: boolean;
}

/**
 * Project a Mastra run status onto the product's 7-value SkillRunStatus.
 *
 * @param mastraStatus the live-probed Mastra WorkflowRunStatus string.
 * @param hints        app-side metadata (declined) the status alone cannot carry.
 */
export function projectStatus(
  mastraStatus: MastraRunStatus,
  hints: ProjectionHints = {},
): SkillRunStatus {
  switch (mastraStatus) {
    case "pending":
      return "pending";
    case "running":
    case "waiting":
    case "paused":
      // waiting/paused are in-flight shapes (a step awaiting a non-HITL signal or
      // a paused run); to the product they read as still-running, not gated.
      return "running";
    case "suspended":
      // Every Mastra suspend is a HITL pause → the product's single HITL-suspend
      // projection. The SSE event vocabulary (awaiting_user vs approval) carries
      // the finer kind; the run-status enum does not (see header).
      return "awaiting_approval";
    case "success":
      // A workflow whose own terminal output was {outcome:'declined'} is a
      // user-decline, not a completion — the app passes declined:true.
      return hints.declined ? "declined" : "done";
    case "canceled":
      // A user decline at a form → declined; a stale-run / abort cancel → aborted.
      return hints.declined ? "declined" : "aborted";
    case "failed":
    case "tripwire":
    case "bailed":
      // failed = run error; tripwire = a guard trip; bailed = an internal
      // early-exit. All three are terminal product errors.
      return "error";
    default: {
      // Exhaustiveness guard: if a future Mastra minor adds an 11th status this
      // throws LOUD instead of projecting a silent `undefined` (review note).
      const exhausted: never = mastraStatus;
      throw new Error(`projectStatus: unmapped Mastra status "${String(exhausted)}"`);
    }
  }
}
