/**
 * messageModel.test — the message-parts → three-zone projection. Ports the
 * legacy reducer's semantic assertions onto the new source of truth: text
 * accumulates, tool frames drive activity/milestones, a data-gate part flips
 * to awaiting_approval (and clears on the next progress part), the terminal
 * data-frames project done / error / declined-vs-aborted, and the message id
 * is the runId.
 */

import { describe, expect, it } from "vitest";

import {
  projectAssistantTurn,
  projectTurns,
  type RunUIMessage,
} from "./messageModel.js";

type Part = RunUIMessage["parts"][number];

function assistant(parts: Part[], id = "run-1"): RunUIMessage {
  return { id, role: "assistant", parts };
}

function frame(kind: string, payload: Record<string, unknown> = {}): Part {
  return { type: "data-frame", id: `f-${kind}`, data: { kind, payload } } as Part;
}

describe("projectAssistantTurn — three-zone projection", () => {
  it("binds runId to the message id; init sets driverKind; text accumulates", () => {
    const turn = projectAssistantTurn(
      assistant([
        frame("init", { driver_kind: "deepseek_apikey" }),
        { type: "text", text: "Created " },
        { type: "text", text: "profile." },
      ]),
    );
    expect(turn.runId).toBe("run-1");
    expect(turn.driverKind).toBe("deepseek_apikey");
    expect(turn.text).toBe("Created profile.");
    expect(turn.status).toBe("running");
  });

  it("tool_call sets currentActivity; tool_result records a milestone and clears it", () => {
    const mid = projectAssistantTurn(assistant([frame("tool_call", { label: "Resolving location…" })]));
    expect(mid.currentActivity).toBe("Resolving location…");

    const turn = projectAssistantTurn(
      assistant([
        frame("tool_call", { label: "Resolving location…" }),
        frame("tool_result", { tool_name: "goplaces", label: "Resolved", ok: true }),
      ]),
    );
    expect(turn.currentActivity).toBeNull();
    expect(turn.milestones).toEqual([{ toolName: "goplaces", label: "Resolved", ok: true }]);
  });

  it("a data-gate part surfaces the structured suspend and flips status to awaiting_approval", () => {
    const turn = projectAssistantTurn(
      assistant([
        {
          type: "data-gate",
          id: "d1",
          data: { decision_id: "d1", form_kind: "data_collection", step: "collect", spec_inline: { a: 1 } },
        } as Part,
      ]),
    );
    expect(turn.status).toBe("awaiting_approval");
    expect(turn.awaitingUser).toEqual({
      decisionId: "d1",
      formKind: "data_collection",
      step: "collect",
      specInline: { a: 1 },
    });
  });

  it("done clears the gate and flips to done; aborted{user_declined} → declined", () => {
    const done = projectAssistantTurn(
      assistant([
        { type: "data-gate", id: "d1", data: { decision_id: "d1", step: "collect" } } as Part,
        frame("done"),
      ]),
    );
    expect(done.status).toBe("done");
    expect(done.awaitingUser).toBeNull();

    const declined = projectAssistantTurn(
      assistant([frame("aborted", { reason: "user_declined" })], "run-2"),
    );
    expect(declined.status).toBe("declined");

    const aborted = projectAssistantTurn(
      assistant([frame("aborted", { reason: "canceled" })], "run-3"),
    );
    expect(aborted.status).toBe("aborted");
  });

  it("an error data-frame projects status error with the persisted reason", () => {
    const turn = projectAssistantTurn(assistant([frame("error", { reason: "workflow_failed" })]));
    expect(turn.status).toBe("error");
    expect(turn.error).toBe("workflow_failed");
  });

  it("a later text part clears a pending gate (the run moved past it)", () => {
    const turn = projectAssistantTurn(
      assistant([
        { type: "data-gate", id: "d1", data: { decision_id: "d1", step: "collect" } } as Part,
        { type: "text", text: "moving on" },
      ]),
    );
    expect(turn.awaitingUser).toBeNull();
  });
});

describe("projectTurns — the rendered turn list", () => {
  it("user messages render their text; a silent (part-less) carrier renders nothing", () => {
    const turns = projectTurns([
      { id: "u1", role: "user", parts: [{ type: "text", text: "/dealer_geosearch" }] },
      { id: "u2", role: "user", parts: [] },
      assistant([frame("done")], "run-9"),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ kind: "user", id: "u1", text: "/dealer_geosearch" });
    expect(turns[1]).toMatchObject({ kind: "assistant", id: "run-9" });
  });
});
