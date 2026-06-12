/**
 * messageModel — the RunUIMessage shape (the app's UIMessage specialization)
 * and the message→turn projection the rail renders from. ONE assistant message
 * = ONE skill run; the message id IS the server runId (the /stream-v2 start
 * chunk binds it), so drafts/forms keep their stable runId key.
 *
 * The projection walks message.parts IN ORDER and reproduces the legacy
 * three-zone reducer semantics exactly:
 *   - text parts accumulate prose and clear the in-flight activity + any
 *     pending gate (the run moved past it).
 *   - data-frame parts carry the wire frames through verbatim:
 *     init → driverKind; tool_call → currentActivity; tool_result → milestone;
 *     done|error|aborted → the terminal status (aborted{user_declined} projects
 *     to 'declined' — the declined-vs-aborted distinction).
 *   - data-gate parts surface the pending suspend (status awaiting_approval);
 *     a later text/tool/terminal part clears it. Reconcile-by-id is the stream
 *     processor's (same gate id updates in place, never duplicates).
 *   - data-browser parts are TRANSIENT (delivered via onData, never persisted)
 *     — they never appear in message.parts and are merged by the App shell.
 *
 * The view field names match the legacy store turn shape, so the AssistantTurn
 * renderer's DOM contract (testids, zone order) is unchanged.
 *
 * Dependency wall: app/ui layer. Imports core (status enum) + the ai types.
 */

import type { UIMessage } from "ai";

import type { SkillRunStatus } from "@autobroker/core";

/** The data-part vocabulary /stream-v2 emits (streamV2.ts mapping). */
export interface RunDataParts {
  /** awaiting_user payload {form_kind, spec_inline, decision_id, step} — open
   *  record on the wire, read defensively. */
  gate: Record<string, unknown>;
  /** browser.* activity {kind, payload} — transient, live-only. */
  browser: { kind: string; payload: Record<string, unknown> };
  /** Any other wire frame carried through verbatim {kind, payload}. */
  frame: { kind: string; payload: Record<string, unknown> };
  [key: string]: unknown;
}

/** The app's UIMessage specialization. */
export type RunUIMessage = UIMessage<unknown, RunDataParts>;

/** The pending-suspend payload surfaced to the gate/form renderers (field
 *  names mirror the wire payload; spec_inline drives gateModel.classifyGate). */
export interface AwaitingUserPayload {
  decisionId: string | null;
  formKind: string | null;
  step: string | null;
  specInline: Record<string, unknown> | null;
}

/** One completed tool in the milestones zone. */
export interface Milestone {
  toolName: string;
  label: string;
  ok: boolean;
}

/** The assistant turn view the rail renders (legacy three-zone shape). */
export interface AssistantTurnView {
  runId: string | null;
  /** The skill id off the init frame (the STOP-card picker re-launches it). */
  skill: string | null;
  status: SkillRunStatus;
  text: string;
  milestones: Milestone[];
  currentActivity: string | null;
  driverKind: string | null;
  awaitingUser: AwaitingUserPayload | null;
  error: string | null;
  /** The error frame's typed identity (Mastra flat step error name/code) —
   *  drives the STOP-card dispatch; null for untyped failures. */
  errorName: string | null;
  errorCode: string | null;
  /** Profile-resolution provenance off the terminal text frame's metadata
   *  (pinned | inferred_newest), or null when the skill carries none. */
  resolution: string | null;
}

/** A rendered turn: a user message or a projected assistant run. */
export type TurnView =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; turn: AssistantTurnView };

/** Read an awaiting_user payload defensively off the open wire record. */
export function readAwaitingUser(payload: Record<string, unknown>): AwaitingUserPayload {
  const decisionId = payload["decision_id"];
  const formKind = payload["form_kind"];
  const step = payload["step"];
  const specInline = payload["spec_inline"];
  return {
    decisionId: typeof decisionId === "string" ? decisionId : null,
    formKind: typeof formKind === "string" ? formKind : null,
    step: typeof step === "string" ? step : null,
    specInline:
      specInline !== null && typeof specInline === "object"
        ? (specInline as Record<string, unknown>)
        : null,
  };
}

function frameData(part: unknown): { kind: string; payload: Record<string, unknown> } | null {
  const d = (part as { data?: unknown }).data;
  if (d === null || typeof d !== "object") return null;
  const kind = (d as { kind?: unknown }).kind;
  const payload = (d as { payload?: unknown }).payload;
  return {
    kind: typeof kind === "string" ? kind : "",
    payload:
      payload !== null && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : {},
  };
}

/** Project one assistant message's parts onto the three-zone turn view. */
export function projectAssistantTurn(message: RunUIMessage): AssistantTurnView {
  let skill: string | null = null;
  let status: SkillRunStatus = "running";
  let text = "";
  const milestones: Milestone[] = [];
  let currentActivity: string | null = null;
  let driverKind: string | null = null;
  let awaitingUser: AwaitingUserPayload | null = null;
  let error: string | null = null;
  let errorName: string | null = null;
  let errorCode: string | null = null;
  let resolution: string | null = null;

  for (const part of message.parts) {
    if (part.type === "text") {
      text += part.text;
      currentActivity = null;
      awaitingUser = null;
      continue;
    }

    if (part.type === "data-gate") {
      const data = part.data;
      awaitingUser = readAwaitingUser(
        data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {},
      );
      status = "awaiting_approval";
      currentActivity = null;
      continue;
    }

    if (part.type !== "data-frame") continue;
    const frame = frameData(part);
    if (frame === null) continue;
    const { kind, payload } = frame;

    switch (kind) {
      case "init": {
        const dk = payload["driver_kind"];
        if (typeof dk === "string") driverKind = dk;
        const sk = payload["skill"];
        if (typeof sk === "string") skill = sk;
        break;
      }
      case "text": {
        // The terminal text frame's METADATA rides a data-frame (the prose
        // itself arrives as protocol text parts) — `resolution` is the
        // profile-resolution provenance.
        const res = payload["resolution"];
        if (res === "pinned" || res === "inferred_newest") resolution = res;
        break;
      }
      case "tool_call": {
        const label = payload["label"];
        currentActivity = typeof label === "string" ? label : "Working…";
        break;
      }
      case "tool_result": {
        const toolName = payload["tool_name"];
        const label = payload["label"];
        milestones.push({
          toolName: typeof toolName === "string" ? toolName : "tool",
          label: typeof label === "string" ? label : "",
          ok: payload["ok"] !== false,
        });
        currentActivity = null;
        awaitingUser = null;
        break;
      }
      case "done": {
        status = "done";
        currentActivity = null;
        awaitingUser = null;
        break;
      }
      case "error": {
        const reason = payload["reason"];
        const name = payload["name"];
        const code = payload["code"];
        status = "error";
        error = typeof reason === "string" ? reason : "workflow_failed";
        errorName = typeof name === "string" ? name : null;
        errorCode = typeof code === "string" ? code : null;
        currentActivity = null;
        awaitingUser = null;
        break;
      }
      case "aborted": {
        status = payload["reason"] === "user_declined" ? "declined" : "aborted";
        currentActivity = null;
        awaitingUser = null;
        break;
      }
      default:
        // awaiting_permission / approval_* / reasoning_* / refusal / runs.* —
        // carried through but not rendered by the three-zone view (yet).
        break;
    }
  }

  return {
    runId: message.id,
    skill,
    status,
    text,
    milestones,
    currentActivity,
    driverKind,
    awaitingUser,
    error,
    errorName,
    errorCode,
    resolution,
  };
}

// ---------------------------------------------------------------------------
// typed STOP classification (the profile-guard error cards)
// ---------------------------------------------------------------------------

/** The geosearch profile-resolution STOP codes — a client-side restatement of
 *  the workflow's GeosearchStopCode union (the wire owns it; UI never imports
 *  the workflows package). */
export const GEOSEARCH_STOP_CODES = [
  "no_active_profile",
  "multiple_active_profiles",
  "profile_missing_fields",
] as const;
export type GeosearchStopCode = (typeof GEOSEARCH_STOP_CODES)[number];

/**
 * Classify a failed turn as a typed geosearch STOP. Dispatch keys on the error
 * NAME plus the stop-code allowlist — the code alone is NOT discriminating
 * (native errors like SqliteError also carry a `code`). Returns null for every
 * non-STOP failure (the generic error line renders instead).
 */
export function geosearchStopCode(turn: AssistantTurnView): GeosearchStopCode | null {
  if (turn.status !== "error") return null;
  if (turn.errorName !== "DealerGeosearchStopError") return null;
  const code = turn.errorCode;
  return code !== null && (GEOSEARCH_STOP_CODES as readonly string[]).includes(code)
    ? (code as GeosearchStopCode)
    : null;
}

/** Concatenate a message's text parts (the user-turn rendering). */
function messageText(message: RunUIMessage): string {
  let text = "";
  for (const part of message.parts) {
    if (part.type === "text") text += part.text;
  }
  return text;
}

/** Project the chat's messages onto rendered turns. A user message with no
 *  text (the silent carrier a button launch sends) renders nothing. */
export function projectTurns(messages: RunUIMessage[]): TurnView[] {
  const turns: TurnView[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = messageText(message);
      if (text !== "") turns.push({ kind: "user", id: message.id, text });
    } else if (message.role === "assistant") {
      turns.push({ kind: "assistant", id: message.id, turn: projectAssistantTurn(message) });
    }
  }
  return turns;
}
