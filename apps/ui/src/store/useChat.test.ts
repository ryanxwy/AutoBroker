/**
 * useChat.test — the Zustand chat store's turn reducers. Pure (node env): the
 * store is plain state, no DOM. Covers the wire-frame → three-zone projection
 * the SSE hook drives via applyRunFrame.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { useChat, type AssistantTurn } from "./useChat.js";
import type { SseEvent } from "../api/wire.js";

function frame(kind: string, payload: Record<string, unknown>): SseEvent {
  return { ts: new Date().toISOString(), kind, payload };
}

function activeAssistantTurn(runId: string): AssistantTurn {
  const { sessions, activeSessionId } = useChat.getState();
  const session = sessions[activeSessionId!]!;
  return session.turns.find(
    (t): t is AssistantTurn => t.role === "assistant" && t.runId === runId,
  )!;
}

beforeEach(() => {
  useChat.getState().__reset();
});

describe("useChat — sessions + turns", () => {
  it("createSession sets the active session; appendUserTurn lands a user turn", () => {
    const sid = useChat.getState().createSession({ sessionId: "s1" });
    expect(useChat.getState().activeSessionId).toBe(sid);
    useChat.getState().appendUserTurn("hello");
    const turns = useChat.getState().sessions["s1"]!.turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ role: "user", text: "hello" });
  });

  it("appendAssistantTurn binds a running turn to the runId", () => {
    useChat.getState().createSession({ sessionId: "s1" });
    useChat.getState().appendAssistantTurn("run-1");
    expect(activeAssistantTurn("run-1").status).toBe("running");
  });
});

describe("useChat — applyRunFrame three-zone reducer", () => {
  beforeEach(() => {
    useChat.getState().createSession({ sessionId: "s1" });
    useChat.getState().appendAssistantTurn("run-1");
  });

  it("init sets driverKind; text accumulates into the text zone", () => {
    useChat.getState().applyRunFrame("run-1", frame("init", { driver_kind: "deepseek_apikey" }));
    useChat.getState().applyRunFrame("run-1", frame("text", { text: "Created " }));
    useChat.getState().applyRunFrame("run-1", frame("text", { text: "profile." }));
    const t = activeAssistantTurn("run-1");
    expect(t.driverKind).toBe("deepseek_apikey");
    expect(t.text).toBe("Created profile.");
  });

  it("tool_call sets currentActivity; tool_result records a milestone and clears it", () => {
    useChat.getState().applyRunFrame("run-1", frame("tool_call", { label: "Resolving location…" }));
    expect(activeAssistantTurn("run-1").currentActivity).toBe("Resolving location…");
    useChat.getState().applyRunFrame("run-1", frame("tool_result", { tool_name: "goplaces", label: "Resolved", ok: true }));
    const t = activeAssistantTurn("run-1");
    expect(t.currentActivity).toBeNull();
    expect(t.milestones).toEqual([{ toolName: "goplaces", label: "Resolved", ok: true }]);
  });

  it("awaiting_user surfaces the structured part and flips status to awaiting_approval", () => {
    useChat.getState().applyRunFrame(
      "run-1",
      frame("awaiting_user", { decision_id: "d1", form_kind: "data_collection", step: "collect", spec_inline: { a: 1 } }),
    );
    const t = activeAssistantTurn("run-1");
    expect(t.status).toBe("awaiting_approval");
    expect(t.awaitingUser).toEqual({
      decisionId: "d1",
      formKind: "data_collection",
      step: "collect",
      specInline: { a: 1 },
    });
  });

  it("done clears the form and flips to done; aborted{user_declined} → declined", () => {
    useChat.getState().applyRunFrame("run-1", frame("awaiting_user", { decision_id: "d1", step: "collect" }));
    useChat.getState().applyRunFrame("run-1", frame("done", {}));
    let t = activeAssistantTurn("run-1");
    expect(t.status).toBe("done");
    expect(t.awaitingUser).toBeNull();

    // a fresh turn for the decline path
    useChat.getState().appendAssistantTurn("run-2");
    useChat.getState().applyRunFrame("run-2", frame("aborted", { reason: "user_declined" }));
    t = activeAssistantTurn("run-2");
    expect(t.status).toBe("declined");
  });

  it("a frame for an unknown runId is dropped (no silent new turn)", () => {
    const before = useChat.getState().sessions["s1"]!.turns.length;
    useChat.getState().applyRunFrame("ghost", frame("text", { text: "x" }));
    expect(useChat.getState().sessions["s1"]!.turns).toHaveLength(before);
  });
});
