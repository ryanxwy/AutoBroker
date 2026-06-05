/**
 * useRunStream — THE single SSE consumer for a skill run (FRONTEND_LAYOUT §7,
 * §9). One EventSource per run, one reducer; it feeds the turn three-zone view
 * AND the approval/form parts. This hook EXISTS to kill the legacy dual-consumer
 * defect (an imperative streamer + a hook each opened their own EventSource,
 * §9 裁决). A module-level registry enforces "one live consumer per runId" and
 * warns LOUD if a second mount races the same run.
 *
 * Wire facts it mirrors (apps/server):
 *   - stream route: GET /api/skill-runs/:id/stream (routes.ts:176); frames are
 *     `data: <json>\n\n` with NO `event:` line (routes.ts:197) → a single
 *     EventSource.onmessage handler switches on frame.kind.
 *   - envelope: { ts, kind, payload } (runPubSub.ts:79-83).
 *   - replay-on-subscribe: the server re-sends the FULL ordered backlog on every
 *     (re)subscribe, then live frames (runPubSub.ts:33-35). There is NO seq/id
 *     field and NO Last-Event-ID — so a reconnect replays everything and we
 *     DEDUPE by content key `${ts}|${kind}|${JSON.stringify(payload)}`
 *     (§9.2 step 3; the lack of a seq field is recorded in api_findings).
 *   - terminal: exactly one of done|error|aborted ends the stream
 *     (runPubSub.ts:72) → we close the EventSource and do NOT reconnect.
 *
 * Dependency wall: app/ui layer. Imports react, the wire schemas/types, and the
 * browser EventSource only.
 */

import { useEffect, useReducer, useRef } from "react";

import type { SkillRunStatus } from "@autobroker/core";

import {
  isEventKind,
  isTerminalKind,
  SseEventSchema,
  type EventKind,
  type SseEvent,
  type TerminalEventKind,
} from "./wire.js";

/** The hook's exposed state (task B1 surface + the §9.2 projection fields). */
export interface RunStreamState {
  /** The product-projected run status, derived from the frames seen so far.
   *  null until the first frame (the run is unknown to the stream yet). */
  status: SkillRunStatus | null;
  /** The full ordered, de-duplicated event backlog (replay-safe). */
  events: SseEvent[];
  /** The pending awaiting_user suspend payload (decision_id + form spec), or null
   *  when not currently suspended. Cleared when the run advances past it. */
  currentSuspend: AwaitingUserPayload | null;
  /** True once a terminal frame (done|error|aborted) has landed. */
  terminal: boolean;
  /** The terminal kind, once terminal. */
  terminalKind: TerminalEventKind | null;
  /** The init frame's driver_kind (init.payload.driver_kind), or null pre-init. */
  driverKind: string | null;
  /** A surfaced error reason (from an `error` frame payload.reason), or null. */
  error: string | null;
}

/** The awaiting_user payload shape this hook surfaces (intakeRuns.ts:466-474:
 *  awaiting_user{form_kind, spec_inline, decision_id, step}). Fields are read
 *  defensively — the payload is an open record on the wire. */
export interface AwaitingUserPayload {
  decisionId: string | null;
  formKind: string | null;
  step: string | null;
  /** The raw suspend payload (spec_inline) for the form/gate renderer. */
  specInline: Record<string, unknown> | null;
}

interface ReducerState {
  status: SkillRunStatus | null;
  events: SseEvent[];
  seen: Set<string>;
  currentSuspend: AwaitingUserPayload | null;
  terminal: boolean;
  terminalKind: TerminalEventKind | null;
  driverKind: string | null;
  error: string | null;
}

function initialState(): ReducerState {
  return {
    status: null,
    events: [],
    seen: new Set<string>(),
    currentSuspend: null,
    terminal: false,
    terminalKind: null,
    driverKind: null,
    error: null,
  };
}

/** The content key for replay dedupe (§9.2 step 3). No seq on the wire. */
function frameKey(ev: SseEvent): string {
  return `${ev.ts}|${ev.kind}|${JSON.stringify(ev.payload)}`;
}

/** Map an event kind onto the product status as frames arrive. The authoritative
 *  projection is server-side (statusProjection.ts); this is the wire-driven view
 *  the UI shows BETWEEN status fetches — terminal kinds win, awaiting_user means
 *  awaiting_approval, everything else means running. */
function statusFromKind(kind: EventKind, prev: SkillRunStatus | null): SkillRunStatus | null {
  switch (kind) {
    case "done":
      return "done";
    case "error":
      return "error";
    case "aborted":
      // The wire cannot tell declined from aborted (a decline lands as `aborted`
      // with payload.reason='user_declined', runPubSub.ts:28-31). The status
      // route disambiguates; here we report `aborted` and let a payload reason
      // refine it below in the reducer.
      return "aborted";
    case "awaiting_user":
    case "awaiting_permission":
    case "approval_required":
      return "awaiting_approval";
    case "init":
      return prev ?? "running";
    default:
      return prev === null || prev === "pending" ? "running" : prev;
  }
}

function readAwaitingUser(payload: Record<string, unknown>): AwaitingUserPayload {
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

type Action = { type: "frame"; ev: SseEvent } | { type: "reset" };

function reducer(state: ReducerState, action: Action): ReducerState {
  if (action.type === "reset") return initialState();

  const ev = action.ev;
  const key = frameKey(ev);
  if (state.seen.has(key)) return state; // replay dedupe — idempotent.

  // Unknown kind: keep it in the log (forward-compat) but do not let it drive
  // status. The server guards the kind set (runPubSub.ts:199-201), so this is a
  // defensive belt only.
  const seen = new Set(state.seen);
  seen.add(key);
  const events = [...state.events, ev];

  if (!isEventKind(ev.kind)) {
    return { ...state, seen, events };
  }
  const kind = ev.kind;

  let status = statusFromKind(kind, state.status);
  let currentSuspend = state.currentSuspend;
  let terminal = state.terminal;
  let terminalKind = state.terminalKind;
  let driverKind = state.driverKind;
  let error = state.error;

  if (kind === "init") {
    const dk = ev.payload["driver_kind"];
    if (typeof dk === "string") driverKind = dk;
  } else if (kind === "awaiting_user") {
    currentSuspend = readAwaitingUser(ev.payload);
  } else if (kind === "error") {
    const reason = ev.payload["reason"];
    error = typeof reason === "string" ? reason : "workflow_failed";
  } else if (kind === "aborted") {
    const reason = ev.payload["reason"];
    if (reason === "user_declined") status = "declined";
  }

  if (isTerminalKind(kind)) {
    terminal = true;
    terminalKind = kind;
    currentSuspend = null; // a terminal frame clears any pending suspend.
  } else if (kind === "tool_call" || kind === "tool_result" || kind === "text") {
    // A new in-flight/text frame means we are no longer parked on the old form.
    // (We only clear on the NEXT non-suspend frame — keeps the form visible
    // while the run is parked, matching §9.4 awaiting_approval rendering.)
    currentSuspend = null;
  }

  return {
    status,
    events,
    seen,
    currentSuspend,
    terminal,
    terminalKind,
    driverKind,
    error,
  };
}

// ---------------------------------------------------------------------------
// Module-level single-consumer registry (§7 / §9 裁决: one EventSource per run).
// A second mount for the SAME runId while one is live is the dual-consumer defect
// this hook exists to prevent — we warn LOUD. The registry is keyed by runId and
// counts active subscriptions; StrictMode's mount/unmount/mount is tolerated via
// the cleanup decrementing before the warn would fire on a true second consumer.
// ---------------------------------------------------------------------------

const liveConsumers = new Map<string, number>();

/** Build the EventSource URL for a run's stream (routes.ts:176). */
function streamUrl(runId: string): string {
  return `/api/skill-runs/${encodeURIComponent(runId)}/stream`;
}

/**
 * Options to inject a custom EventSource factory (tests pass a mock; default =
 * the browser global). Keeps the hook unit-testable under happy-dom without a
 * real network.
 */
export interface UseRunStreamOptions {
  eventSourceFactory?: (url: string) => EventSource;
  /** Reconnect delay (ms) after a non-terminal drop. Default 1000. */
  reconnectDelayMs?: number;
}

/**
 * Subscribe to a run's SSE stream. Pass `null` to disable (no run yet). Returns
 * the live RunStreamState; re-renders as frames arrive. Reconnects on a
 * non-terminal drop (replay + dedupe makes this idempotent); closes for good on
 * a terminal frame.
 */
export function useRunStream(
  runId: string | null,
  options: UseRunStreamOptions = {},
): RunStreamState {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const terminalRef = useRef(false);
  terminalRef.current = state.terminal;

  // Pin the factory/delay so changing the options object identity does not
  // tear down a live stream mid-run.
  const factoryRef = useRef(options.eventSourceFactory);
  factoryRef.current = options.eventSourceFactory;
  const delayRef = useRef(options.reconnectDelayMs ?? 1000);
  delayRef.current = options.reconnectDelayMs ?? 1000;

  useEffect(() => {
    if (runId === null) return;

    // Reset reducer state when the run changes (new backlog from scratch).
    dispatch({ type: "reset" });
    terminalRef.current = false;

    // ---- single-consumer registry -----------------------------------------
    const prior = liveConsumers.get(runId) ?? 0;
    if (prior > 0) {
      console.warn(
        `useRunStream: a second consumer mounted for run '${runId}' while one is ` +
          `already live — this is the dual-EventSource defect this hook exists to ` +
          `prevent. Render exactly one useRunStream per run.`,
      );
    }
    liveConsumers.set(runId, prior + 1);

    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const makeEs = factoryRef.current ?? ((url: string) => new EventSource(url));

    const connect = (): void => {
      if (disposed || terminalRef.current) return;
      es = makeEs(streamUrl(runId));

      es.onmessage = (msg: MessageEvent): void => {
        let raw: unknown;
        try {
          raw = JSON.parse(msg.data as string);
        } catch {
          return; // a malformed/comment frame — ignore (heartbeats are comments).
        }
        const parsed = SseEventSchema.safeParse(raw);
        if (!parsed.success) return; // not our envelope — ignore defensively.
        dispatch({ type: "frame", ev: parsed.data });
        if (isTerminalKind(parsed.data.kind)) {
          // Terminal: close for good, never reconnect.
          terminalRef.current = true;
          es?.close();
          es = null;
        }
      };

      es.onerror = (): void => {
        // EventSource auto-reconnects on transient drops; but if WE consider the
        // run terminal we must hard-close. Otherwise schedule a manual reconnect
        // only when the browser gave up (readyState CLOSED) — the replay snapshot
        // + content dedupe make a re-subscribe idempotent.
        if (disposed || terminalRef.current) {
          es?.close();
          es = null;
          return;
        }
        if (es !== null && es.readyState === EventSource.CLOSED) {
          es = null;
          if (reconnectTimer === null) {
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              connect();
            }, delayRef.current);
          }
        }
        // readyState CONNECTING → let the browser's native retry run.
      };
    };

    connect();

    return (): void => {
      disposed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      es?.close();
      const n = (liveConsumers.get(runId) ?? 1) - 1;
      if (n <= 0) liveConsumers.delete(runId);
      else liveConsumers.set(runId, n);
    };
    // Only re-run when the runId changes — options are pinned via refs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  return {
    status: state.status,
    events: state.events,
    currentSuspend: state.currentSuspend,
    terminal: state.terminal,
    terminalKind: state.terminalKind,
    driverKind: state.driverKind,
    error: state.error,
  };
}

/** Test-only: clear the live-consumer registry between isolated cases. */
export function __resetRunStreamRegistryForTests(): void {
  liveConsumers.clear();
}
