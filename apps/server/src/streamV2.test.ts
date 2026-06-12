/**
 * streamV2.test — the frame→chunk mapping contract (pure translator).
 * Locks the protocol shape the client transport decodes: runId as messageId,
 * text triples, gate reconcile-by-decision_id, transient browser parts, the
 * verbatim data-frame carry-through (init.driver_kind, tool milestones), and
 * the three terminal mappings incl. the declined-vs-aborted reason.
 */

import { describe, expect, it } from "vitest";

import type { SseEvent } from "./runPubSub.js";
import { UiStreamTranslator, chunkFrame, streamV2Enabled } from "./streamV2.js";

function ev(kind: SseEvent["kind"], payload: Record<string, unknown> = {}): SseEvent {
  return { ts: "2026-06-12T00:00:00.000Z", kind, payload };
}

describe("UiStreamTranslator — frame→chunk mapping", () => {
  it("start binds the assistant message id to the runId", () => {
    const t = new UiStreamTranslator();
    expect(t.start("run-1")).toEqual([{ type: "start", messageId: "run-1" }]);
  });

  it("text → text-start/delta/end with a stable per-frame id", () => {
    const t = new UiStreamTranslator();
    expect(t.translate(ev("text", { text: "Created profile." }))).toEqual([
      { type: "text-start", id: "text-0" },
      { type: "text-delta", id: "text-0", delta: "Created profile." },
      { type: "text-end", id: "text-0" },
    ]);
  });

  it("awaiting_user → data-gate keyed by decision_id (reconcile-by-id, not append)", () => {
    const t = new UiStreamTranslator();
    const payload = {
      form_kind: "data_collection",
      spec_inline: { kind: "data_collection" },
      decision_id: "d1",
      step: "collect",
    };
    const chunks = t.translate(ev("awaiting_user", payload));
    expect(chunks).toEqual([{ type: "data-gate", id: "d1", data: payload }]);
    // A re-emitted gate (same decision_id) keeps the SAME part id → the client
    // reconciles in place instead of appending a duplicate card.
    const again = t.translate(ev("awaiting_user", payload));
    expect(again[0]).toMatchObject({ type: "data-gate", id: "d1" });
  });

  it("browser.* → transient data-browser (never persisted into history)", () => {
    const t = new UiStreamTranslator();
    const chunks = t.translate(ev("browser.action", { type: "goto", target: "https://x" }));
    expect(chunks).toEqual([
      {
        type: "data-browser",
        data: { kind: "browser.action", payload: { type: "goto", target: "https://x" } },
        transient: true,
      },
    ]);
  });

  it("init / tool_call / tool_result carry through VERBATIM as data-frame parts", () => {
    const t = new UiStreamTranslator();
    const init = t.translate(
      ev("init", { run_id: "r", skill: "search_profile_intake", driver_kind: "deepseek_apikey" }),
    );
    expect(init).toEqual([
      {
        type: "data-frame",
        id: "frame-0",
        data: {
          kind: "init",
          payload: { run_id: "r", skill: "search_profile_intake", driver_kind: "deepseek_apikey" },
        },
      },
    ]);
    const call = t.translate(ev("tool_call", { label: "Resolving location…" }));
    expect(call[0]).toMatchObject({
      type: "data-frame",
      id: "frame-1",
      data: { kind: "tool_call" },
    });
    const result = t.translate(ev("tool_result", { tool_name: "goplaces", label: "ok", ok: true }));
    expect(result[0]).toMatchObject({
      type: "data-frame",
      id: "frame-2",
      data: { kind: "tool_result", payload: { tool_name: "goplaces", ok: true } },
    });
  });

  it("done → data-frame + finish", () => {
    const t = new UiStreamTranslator();
    expect(t.translate(ev("done"))).toEqual([
      { type: "data-frame", id: "frame-0", data: { kind: "done", payload: {} } },
      { type: "finish" },
    ]);
  });

  it("error → data-frame (reason persisted) + error{errorText}", () => {
    const t = new UiStreamTranslator();
    expect(t.translate(ev("error", { reason: "workflow_failed" }))).toEqual([
      {
        type: "data-frame",
        id: "frame-0",
        data: { kind: "error", payload: { reason: "workflow_failed" } },
      },
      { type: "error", errorText: "workflow_failed" },
    ]);
  });

  it("aborted{user_declined} → data-frame carrying the decline reason + abort", () => {
    const t = new UiStreamTranslator();
    expect(t.translate(ev("aborted", { reason: "user_declined" }))).toEqual([
      {
        type: "data-frame",
        id: "frame-0",
        data: { kind: "aborted", payload: { reason: "user_declined" } },
      },
      { type: "abort", reason: "user_declined" },
    ]);
  });

  it("replay determinism: two translators over the same backlog emit identical ids", () => {
    const backlog: SseEvent[] = [
      ev("init", { driver_kind: "deepseek_apikey" }),
      ev("text", { text: "a" }),
      ev("awaiting_user", { decision_id: "d9", step: "collect" }),
      ev("done"),
    ];
    const a = new UiStreamTranslator();
    const b = new UiStreamTranslator();
    const chunksA = backlog.flatMap((e) => a.translate(e));
    const chunksB = backlog.flatMap((e) => b.translate(e));
    expect(chunksA).toEqual(chunksB);
  });
});

describe("chunkFrame / flag", () => {
  it("serializes one chunk as a data: SSE frame", () => {
    expect(chunkFrame({ type: "finish" })).toBe('data: {"type":"finish"}\n\n');
  });

  it("streamV2Enabled reads AUTOBROKER_STREAM_V2=1 (default off — legacy /stream stays default)", () => {
    const prior = process.env.AUTOBROKER_STREAM_V2;
    try {
      delete process.env.AUTOBROKER_STREAM_V2;
      expect(streamV2Enabled()).toBe(false);
      process.env.AUTOBROKER_STREAM_V2 = "1";
      expect(streamV2Enabled()).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.AUTOBROKER_STREAM_V2;
      else process.env.AUTOBROKER_STREAM_V2 = prior;
    }
  });
});
