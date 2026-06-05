// @vitest-environment happy-dom
/**
 * AssistantTurn.test — the gate-before-prose structural invariant (FRONTEND_LAYOUT
 * §4.1 / §8). Even when a `text` frame arrived BEFORE the `awaiting_user` frame in
 * the stream, the gate zone must render structurally ABOVE the text zone — the
 * zones are fixed JSX positions, never sorted by timestamp. Also: the gate hosts
 * the IntakeForm (data_collection) and a decline dispatches action 'decline'.
 */

import { describe, expect, it, vi } from "vitest";

import { AssistantTurn } from "./AssistantTurn.js";
import { click, render } from "../test/render.js";
import type { AssistantTurn as AssistantTurnState } from "../store/useChat.js";

function turnState(overrides: Partial<AssistantTurnState>): AssistantTurnState {
  return {
    clientId: "c1",
    runId: "run-1",
    role: "assistant",
    status: "awaiting_approval",
    text: "",
    milestones: [],
    currentActivity: null,
    driverKind: "deepseek_apikey",
    awaitingUser: null,
    error: null,
    ...overrides,
  };
}

describe("AssistantTurn — gate-before-prose ordering", () => {
  it("renders the gate zone structurally before the text zone, even with prose set first", () => {
    // Simulate the out-of-order case: prose text already accumulated AND a pending
    // suspend. The store reduced both; the component must still place the gate
    // above the prose by structure.
    const turn = turnState({
      text: "Here is some streamed prose that arrived before the form.",
      status: "awaiting_approval",
      awaitingUser: {
        decisionId: "d1",
        formKind: "data_collection",
        step: "collect",
        specInline: { kind: "data_collection", form_kind: "intake", seed_fields: null },
      },
    });
    const r = render(<AssistantTurn turn={turn} submitting={false} onDecision={() => {}} />);

    const gate = r.get("turn-zone-gate");
    const text = r.get("turn-zone-text");
    // compareDocumentPosition: gate precedes text → DOCUMENT_POSITION_FOLLOWING bit.
    const rel = gate.compareDocumentPosition(text);
    expect(rel & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rel & Node.DOCUMENT_POSITION_PRECEDING).toBeFalsy();
    r.unmount();
  });

  it("the gate hosts the intake form; decline dispatches action 'decline'", () => {
    const onDecision = vi.fn();
    const turn = turnState({
      awaitingUser: {
        decisionId: "d1",
        formKind: "data_collection",
        step: "collect",
        specInline: { kind: "data_collection", form_kind: "intake", seed_fields: null },
      },
    });
    const r = render(<AssistantTurn turn={turn} submitting={false} onDecision={onDecision} />);
    expect(r.query("intake-form")).not.toBeNull();
    click(r.get("intake-decline"));
    expect(onDecision).toHaveBeenCalledWith("decline");
    r.unmount();
  });

  it("does NOT render the gate once the run is done (form collapsed)", () => {
    const turn = turnState({ status: "done", awaitingUser: null, text: "Created profile." });
    const r = render(<AssistantTurn turn={turn} submitting={false} onDecision={() => {}} />);
    expect(r.query("turn-zone-gate")).toBeNull();
    expect(r.get("turn-zone-text").textContent).toContain("Created profile.");
    r.unmount();
  });
});
