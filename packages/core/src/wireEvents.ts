/**
 * wireEvents — the ONE definition of the SSE wire-event vocabulary shared by
 * every layer: the server emitter (runPubSub), the UI decoder, and the harness
 * detail normalizer all read this single source instead of hand-copying the
 * kind list. Pure data + guards; no framework (core layer).
 *
 * THE SSE ENVELOPE every frame carries is { ts, kind, payload }; `kind` is one of
 * EVENT_KINDS. A run's stream ends after exactly ONE terminal kind
 * (TERMINAL_EVENT_KINDS): done | error | aborted. `declined` is a STATUS
 * projection of an `aborted{user_declined}` frame, NOT a wire kind.
 */

/**
 * The closed EVENT_KINDS set. A skill emits a subset; the full set is declared so
 * an unknown kind can be rejected (no drift). browser.* and the SDK-only
 * approval/permission kinds are listed for completeness but not emitted by every
 * skill.
 */
export const EVENT_KINDS = [
  "init",
  "text",
  "tool_call",
  "tool_result",
  "awaiting_user",
  "awaiting_permission",
  "approval_required",
  "approval_response",
  "reasoning_full",
  "reasoning_summary",
  "refusal",
  "browser.opened",
  "browser.action",
  "browser.error",
  "browser.closed",
  // browser.acquire.progress — a NON-terminal pulse fired only on the cold path
  // where the Playwright browser binary is absent and is being installed before
  // the first launch. Payload { message:string, progress?:number } (progress is
  // a 0..1 fraction when known) drives an install bar in the UI. NOT terminal.
  "browser.acquire.progress",
  // data.changed — a NON-terminal "a write landed" pulse the UI uses for
  // fresh-by-default auto-refresh: payload {profile_id, kinds:string[]} names
  // the data families a just-completed skill touched (e.g. ["dealers"]). It
  // rides the RUN channel (no per-resource stream) and is emitted BEFORE the
  // terminal `done` (after `done` the single-terminal invariant would discard
  // it). NOT terminal.
  "data.changed",
  "done",
  "error",
  "aborted",
  "runs.list_changed",
  "runs.run_updated",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** The three terminal wire kinds. A run's stream ends after exactly one. */
export const TERMINAL_EVENT_KINDS = ["done", "error", "aborted"] as const;
export type TerminalEventKind = (typeof TERMINAL_EVENT_KINDS)[number];

const EVENT_KIND_SET = new Set<string>(EVENT_KINDS);
const TERMINAL_SET = new Set<string>(TERMINAL_EVENT_KINDS);

export function isEventKind(k: string): k is EventKind {
  return EVENT_KIND_SET.has(k);
}
export function isTerminalKind(k: string): k is TerminalEventKind {
  return TERMINAL_SET.has(k);
}
