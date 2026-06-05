/**
 * useChat — the Zustand store that is the single source of truth for the chat
 * rail's sessions / turns / runs state (FRONTEND_LAYOUT §9.1: "客户端会话状态").
 * The single SSE hook (useRunStream) writes run frames into the active turn via
 * `applyRunFrame`; this store NEVER opens a second EventSource and never calls
 * the network itself — it holds client state only (the API client + the SSE hook
 * own I/O).
 *
 * SCOPE (B1): the store shape + the turn-update reducers the scaffold needs to
 * prove an end-to-end render path (a user turn → an assistant turn fed by the SSE
 * stream). The full chat-rail wiring — server-backed session bootstrap/switch/
 * archive/rename/pin (which need the M2 /api/sessions routes that do NOT exist
 * yet, routes.ts has none) and the @ai-sdk/react part-stream integration — is
 * deferred to M2-run2 (recorded in api_findings / design_notes). No fake session
 * fetch is wired here: a method that hit a missing route would lie.
 *
 * The assistant-turn shape follows §4.1 (three-zone: text / milestones /
 * currentActivity) with the structured awaitingUser part replacing the legacy
 * scattered form* fields (§4.1 设计裁决).
 *
 * Dependency wall: app/ui layer. Imports zustand, core (the status enum), and the
 * SSE wire types only.
 */

import { create } from "zustand";

import type { SkillRunStatus } from "@autobroker/core";

import type { AwaitingUserPayload } from "../api/useRunStream.js";
import type { SseEvent } from "../api/wire.js";

/** One completed tool in an assistant turn's milestones zone (§4.1). */
export interface Milestone {
  toolName: string;
  label: string;
  ok: boolean;
}

/** A user-authored turn. */
export interface UserTurn {
  clientId: string;
  role: "user";
  text: string;
}

/** An assistant turn — the three-zone model (§4.1). `runId` is the stable server
 *  id (the draft key); `clientId` is re-minted per transcript fetch. */
export interface AssistantTurn {
  clientId: string;
  runId: string | null;
  role: "assistant";
  status: SkillRunStatus;
  text: string;
  milestones: Milestone[];
  currentActivity: string | null;
  driverKind: string | null;
  awaitingUser: AwaitingUserPayload | null;
  error: string | null;
}

export type Turn = UserTurn | AssistantTurn;

/** A chat session = one rail = one Mastra Memory thread = one search profile
 *  (FRONTEND_LAYOUT §4). B1 models the client shape; server hydration is M2. */
export interface Session {
  sessionId: string;
  title: string;
  turns: Turn[];
  pinnedProfileId: string | null;
}

interface ChatState {
  sessions: Record<string, Session>;
  activeSessionId: string | null;

  // --- session lifecycle (client-only at B1) ---
  createSession(args?: { sessionId?: string; title?: string }): string;
  switchSession(sessionId: string): void;

  // --- turns ---
  appendUserTurn(text: string): void;
  /** Append a fresh assistant turn (status 'running') bound to a server runId and
   *  return its clientId. */
  appendAssistantTurn(runId: string): string;

  // --- run frame application (the SSE hook calls this) ---
  /** Apply one decoded SSE frame to the assistant turn bound to `runId`. The
   *  single reducer that translates the wire envelope into the three-zone view
   *  + the structured awaitingUser/error parts (§9.3). */
  applyRunFrame(runId: string, ev: SseEvent): void;
  /** Set a turn's projected status directly (e.g. from a GET status poll). */
  setRunStatus(runId: string, status: SkillRunStatus): void;

  /** Test-only reset. */
  __reset(): void;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** Find the active session + the assistant turn bound to `runId`, returning a
 *  shallow-cloned session with the turn replaced by `update(turn)`. Returns null
 *  when no such turn exists (the frame is dropped — no silent new turn). */
function withAssistantTurn(
  sessions: Record<string, Session>,
  runId: string,
  update: (turn: AssistantTurn) => AssistantTurn,
): Record<string, Session> | null {
  for (const [sid, session] of Object.entries(sessions)) {
    const idx = session.turns.findIndex(
      (t): t is AssistantTurn => t.role === "assistant" && t.runId === runId,
    );
    if (idx === -1) continue;
    const turns = session.turns.slice();
    turns[idx] = update(turns[idx] as AssistantTurn);
    return { ...sessions, [sid]: { ...session, turns } };
  }
  return null;
}

/** The wire-frame → three-zone reducer (one assistant turn). Mirrors the kinds
 *  the intake run emits (runPubSub EVENT_KINDS; intakeRuns translate). */
function reduceFrame(turn: AssistantTurn, ev: SseEvent): AssistantTurn {
  switch (ev.kind) {
    case "init": {
      const dk = ev.payload["driver_kind"];
      return { ...turn, driverKind: typeof dk === "string" ? dk : turn.driverKind };
    }
    case "text": {
      const t = ev.payload["text"];
      return {
        ...turn,
        text: turn.text + (typeof t === "string" ? t : ""),
        currentActivity: null,
      };
    }
    case "tool_call": {
      const label = ev.payload["label"];
      return {
        ...turn,
        currentActivity: typeof label === "string" ? label : "Working…",
      };
    }
    case "tool_result": {
      const toolName = ev.payload["tool_name"];
      const label = ev.payload["label"];
      const ok = ev.payload["ok"];
      return {
        ...turn,
        milestones: [
          ...turn.milestones,
          {
            toolName: typeof toolName === "string" ? toolName : "tool",
            label: typeof label === "string" ? label : "",
            ok: ok !== false,
          },
        ],
        currentActivity: null,
      };
    }
    case "awaiting_user": {
      const decisionId = ev.payload["decision_id"];
      const formKind = ev.payload["form_kind"];
      const step = ev.payload["step"];
      const specInline = ev.payload["spec_inline"];
      return {
        ...turn,
        status: "awaiting_approval",
        currentActivity: null,
        awaitingUser: {
          decisionId: typeof decisionId === "string" ? decisionId : null,
          formKind: typeof formKind === "string" ? formKind : null,
          step: typeof step === "string" ? step : null,
          specInline:
            specInline !== null && typeof specInline === "object"
              ? (specInline as Record<string, unknown>)
              : null,
        },
      };
    }
    case "done":
      return { ...turn, status: "done", currentActivity: null, awaitingUser: null };
    case "error": {
      const reason = ev.payload["reason"];
      return {
        ...turn,
        status: "error",
        currentActivity: null,
        awaitingUser: null,
        error: typeof reason === "string" ? reason : "workflow_failed",
      };
    }
    case "aborted": {
      const reason = ev.payload["reason"];
      return {
        ...turn,
        status: reason === "user_declined" ? "declined" : "aborted",
        currentActivity: null,
        awaitingUser: null,
      };
    }
    default:
      return turn;
  }
}

export const useChat = create<ChatState>()((set, get) => ({
  sessions: {},
  activeSessionId: null,

  createSession(args = {}) {
    const sessionId = args.sessionId ?? nextId("session");
    const session: Session = {
      sessionId,
      title: args.title ?? "New search",
      turns: [],
      pinnedProfileId: null,
    };
    set((s) => ({
      sessions: { ...s.sessions, [sessionId]: session },
      activeSessionId: sessionId,
    }));
    return sessionId;
  },

  switchSession(sessionId) {
    if (get().sessions[sessionId] === undefined) return;
    set({ activeSessionId: sessionId });
  },

  appendUserTurn(text) {
    const sid = get().activeSessionId;
    if (sid === null) return;
    const turn: UserTurn = { clientId: nextId("turn"), role: "user", text };
    set((s) => {
      const session = s.sessions[sid];
      if (session === undefined) return s;
      return {
        sessions: { ...s.sessions, [sid]: { ...session, turns: [...session.turns, turn] } },
      };
    });
  },

  appendAssistantTurn(runId) {
    const sid = get().activeSessionId;
    const clientId = nextId("turn");
    if (sid === null) return clientId;
    const turn: AssistantTurn = {
      clientId,
      runId,
      role: "assistant",
      status: "running",
      text: "",
      milestones: [],
      currentActivity: null,
      driverKind: null,
      awaitingUser: null,
      error: null,
    };
    set((s) => {
      const session = s.sessions[sid];
      if (session === undefined) return s;
      return {
        sessions: { ...s.sessions, [sid]: { ...session, turns: [...session.turns, turn] } },
      };
    });
    return clientId;
  },

  applyRunFrame(runId, ev) {
    set((s) => {
      const next = withAssistantTurn(s.sessions, runId, (turn) => reduceFrame(turn, ev));
      return next === null ? s : { sessions: next };
    });
  },

  setRunStatus(runId, status) {
    set((s) => {
      const next = withAssistantTurn(s.sessions, runId, (turn) => ({ ...turn, status }));
      return next === null ? s : { sessions: next };
    });
  },

  __reset() {
    set({ sessions: {}, activeSessionId: null });
  },
}));
