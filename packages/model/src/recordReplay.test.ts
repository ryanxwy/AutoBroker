/**
 * L1 unit tests — the record/replay model seam (Phase-4 multi-profile harness).
 *
 * Freezes that `recordingModel` TEES every LLM call to a transcript sink while
 * still handing the caller a live result/stream, and that `replayModel` returns
 * those recorded calls token-for-token with NO provider. The TraceIndex keeps a
 * per-eventType cursor and fails LOUD on exhaustion / prompt-hash mismatch — it
 * never silently passes or fails. The DI seam in registry.ts lets the harness
 * swap a wrapper in via resolveModel without touching @autobroker/workflows; it
 * is test-guarded and a no-op (byte-identical) in production.
 *
 * No live LLM anywhere: the "real" models are the deterministic v3 fakes from
 * testSupport (makeStaticToolCallModel / makeStructuredObjectModel).
 */
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetHarnessModelWrapper,
  __setHarnessModelWrapper,
  hashPrompt,
  JsonlFileSink,
  parseTranscriptJsonl,
  recordingModel,
  ReplayExhaustedError,
  ReplayPromptMismatchError,
  replayModel,
  resolveModel,
  serializeTranscriptEvent,
  TraceIndex,
  type TranscriptEvent,
  type TranscriptSink,
} from "./index.js";
import { makeStaticToolCallModel, makeStructuredObjectModel } from "./testSupport.js";

afterEach(() => __resetHarnessModelWrapper());

/** In-memory sink: collects events so a test can build a TraceIndex from them. */
function memSink(): TranscriptSink & { events: TranscriptEvent[] } {
  const events: TranscriptEvent[] = [];
  return { events, append: (ev) => events.push(ev) };
}

/** A minimal, valid v3 call-options object around a single user message. */
function opts(text: string): LanguageModelV3CallOptions {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text }] }],
  };
}

/** Drain a v3 stream to an ordered array of parts. */
async function drain(
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<LanguageModelV3StreamPart[]> {
  const out: LanguageModelV3StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("recordReplay — round-trip", () => {
  it("doGenerate replays token-for-token (content, finishReason, usage identical)", async () => {
    const real = makeStaticToolCallModel({
      toolName: "emit_result",
      args: { ok: true },
    }) as LanguageModelV3;
    const sink = memSink();
    const recorder = recordingModel(real, sink, { runId: "r1", alias: "deepseek.cheap" });

    const o = opts("hello");
    const recorded = (await recorder.doGenerate(o)) as LanguageModelV3GenerateResult;

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.eventType).toBe("doGenerate");
    expect(sink.events[0]?.alias).toBe("deepseek.cheap");
    expect(sink.events[0]?.modelId).toBe(real.modelId);

    const index = new TraceIndex(sink.events);
    const replay = replayModel(index, { alias: "deepseek.cheap", modelId: real.modelId });
    const replayed = (await replay.doGenerate(o)) as LanguageModelV3GenerateResult;

    expect(replayed).toEqual(recorded);
    expect(replay.modelId).toBe(real.modelId);
    expect(replay.provider).toBe("autobroker-replay");
  });

  it("doStream replays token-for-token AND the recorder still yields a live stream (tee)", async () => {
    const real = makeStructuredObjectModel({ object: { quote: 30000 } }) as LanguageModelV3;
    const sink = memSink();
    const recorder = recordingModel(real, sink, { runId: "r1", alias: "deepseek.cheap" });

    const o = opts("stream me");
    const live = await recorder.doStream(o);
    const liveParts = await drain(live.stream);

    // Tee: the recorder handed the caller a real, complete live stream.
    expect(liveParts.length).toBeGreaterThan(0);
    expect(liveParts.some((p) => p.type === "text-delta")).toBe(true);

    // ...and recorded the same ordered parts.
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.eventType).toBe("doStream");
    const recordedParts = sink.events[0]?.result as LanguageModelV3StreamPart[];
    expect(recordedParts).toEqual(liveParts);

    const index = new TraceIndex(sink.events);
    const replay = replayModel(index, { alias: "deepseek.cheap", modelId: real.modelId });
    const replayResult = await replay.doStream(o);
    const replayedParts = await drain(replayResult.stream);

    expect(replayedParts).toEqual(liveParts);
  });

  it("records the COMPLETE doStream event even when the caller cancels the teed stream early", async () => {
    // Establish the full expected part sequence by fully draining the SAME fake model
    // once (a deterministic v3 fake with several parts: stream-start, text-*, finish).
    const ref = makeStructuredObjectModel({ object: { quote: 30000 } }) as LanguageModelV3;
    const fullParts = await drain((await ref.doStream(opts("cancel me"))).stream);
    expect(fullParts.length).toBeGreaterThan(1); // more than one chunk → early cancel skips some

    const real = makeStructuredObjectModel({ object: { quote: 30000 } }) as LanguageModelV3;
    const sink = memSink();
    const recorder = recordingModel(real, sink, { runId: "r1", alias: "deepseek.cheap" });

    const live = await recorder.doStream(opts("cancel me"));
    // Read ONLY the first chunk, then cancel the caller's branch (simulating an
    // AbortSignal / Mastra stopWhen / maxSteps early stop) — the source is NOT drained
    // by the caller.
    const reader = live.stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();
    reader.releaseLock();

    // Let the background record-branch drain run to completion.
    await vi.waitFor(() => {
      expect(sink.events).toHaveLength(1);
    });

    // Despite the early caller-cancel, the recorded doStream event holds ALL parts.
    expect(sink.events[0]?.eventType).toBe("doStream");
    const recorded = sink.events[0]?.result as LanguageModelV3StreamPart[];
    expect(recorded).toEqual(fullParts);

    // And the complete recording replays token-for-token.
    const index = new TraceIndex(sink.events);
    const replay = replayModel(index, { alias: "deepseek.cheap", modelId: real.modelId });
    const replayed = await drain((await replay.doStream(opts("cancel me"))).stream);
    expect(replayed).toEqual(fullParts);
  });
});

describe("recordReplay — per-event-type cursors", () => {
  it("interleaved doGenerate/doStream replays advance independent cursors", async () => {
    const gen = makeStaticToolCallModel({ toolName: "t", args: { n: 1 } }) as LanguageModelV3;
    const str = makeStructuredObjectModel({ object: { n: 2 } }) as LanguageModelV3;
    const sink = memSink();
    const genRec = recordingModel(gen, sink, { runId: "r1", alias: "a" });
    const strRec = recordingModel(str, sink, { runId: "r1", alias: "a" });

    const oG = opts("gen");
    const oS = opts("str");
    // Record order: doGenerate, doStream, doGenerate.
    const rec0 = (await genRec.doGenerate(oG)) as LanguageModelV3GenerateResult;
    const recStreamParts = await drain((await strRec.doStream(oS)).stream);
    const rec1 = (await genRec.doGenerate(oG)) as LanguageModelV3GenerateResult;
    expect(sink.events).toHaveLength(3);

    // Capture the recorded results from the sink so we can deep-equal each replay
    // against its recorded counterpart (the recorded order is gen, stream, gen).
    const recordedDoGenerate = sink.events
      .filter((e) => e.eventType === "doGenerate")
      .map((e) => e.result as LanguageModelV3GenerateResult);
    const recordedDoStream = sink.events
      .filter((e) => e.eventType === "doStream")
      .map((e) => e.result as LanguageModelV3StreamPart[]);
    expect(recordedDoGenerate).toEqual([rec0, rec1]);
    expect(recordedDoStream).toEqual([recStreamParts]);

    const index = new TraceIndex(sink.events);
    const genReplay = replayModel(index, { alias: "a", modelId: gen.modelId });
    const strReplay = replayModel(index, { alias: "a", modelId: str.modelId });

    // Replay in the same order; each type advances its own cursor independently.
    const rep0 = (await genReplay.doGenerate(oG)) as LanguageModelV3GenerateResult; // doGenerate 0 -> 1
    const repStreamParts = await drain((await strReplay.doStream(oS)).stream); // doStream 0 -> 1
    const rep1 = (await genReplay.doGenerate(oG)) as LanguageModelV3GenerateResult; // doGenerate 1 -> 2

    // The 1st doGenerate replay equals the 1st recorded doGenerate, the 2nd equals
    // the 2nd — proving the doGenerate cursor advanced INDEPENDENTLY of the doStream
    // cursor consumed between them (else rep1 would not match the 2nd recorded gen).
    expect(rep0).toEqual(recordedDoGenerate[0]);
    expect(rep1).toEqual(recordedDoGenerate[1]);
    expect(repStreamParts).toEqual(recordedDoStream[0]);
  });
});

describe("recordReplay — fail loud", () => {
  it("exhaustion throws ReplayExhaustedError (one more doGenerate than recorded)", async () => {
    const gen = makeStaticToolCallModel({ toolName: "t", args: {} }) as LanguageModelV3;
    const sink = memSink();
    const rec = recordingModel(gen, sink, { runId: "r1", alias: "a" });
    const o = opts("once");
    await rec.doGenerate(o);

    const index = new TraceIndex(sink.events);
    const replay = replayModel(index, { alias: "a", modelId: gen.modelId });
    await replay.doGenerate(o); // consumes the single recorded event
    await expect(replay.doGenerate(o)).rejects.toThrow(ReplayExhaustedError);
  });

  it("prompt-hash mismatch throws ReplayPromptMismatchError with needsReRecord=true", async () => {
    const gen = makeStaticToolCallModel({ toolName: "t", args: {} }) as LanguageModelV3;
    const sink = memSink();
    const rec = recordingModel(gen, sink, { runId: "r1", alias: "a" });
    await rec.doGenerate(opts("recorded prompt"));

    const index = new TraceIndex(sink.events);
    const replay = replayModel(index, { alias: "a", modelId: gen.modelId });

    let caught: unknown;
    try {
      await replay.doGenerate(opts("DIFFERENT prompt")); // different hash than recorded
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ReplayPromptMismatchError);
    const e = caught as ReplayPromptMismatchError;
    expect(e.needsReRecord).toBe(true);
    expect(e.eventType).toBe("doGenerate");
    expect(e.expectedHash).not.toBe(e.observedHash);
  });

  it("a mismatch does NOT advance the cursor (the recorded event is still reachable)", async () => {
    const gen = makeStaticToolCallModel({ toolName: "t", args: {} }) as LanguageModelV3;
    const sink = memSink();
    const rec = recordingModel(gen, sink, { runId: "r1", alias: "a" });
    const o = opts("recorded prompt");
    await rec.doGenerate(o);

    const index = new TraceIndex(sink.events);
    expect(() => index.next("doGenerate", "wronghash")).toThrow(ReplayPromptMismatchError);
    // Cursor un-advanced: the real hash still resolves.
    expect(() => index.next("doGenerate", hashPrompt(o))).not.toThrow();
  });
});

describe("hashPrompt — stability", () => {
  it("same options → same hash", () => {
    expect(hashPrompt(opts("x"))).toBe(hashPrompt(opts("x")));
  });

  it("options differing only in abortSignal/headers → SAME hash", () => {
    const base = opts("x");
    const withTransport: LanguageModelV3CallOptions = {
      ...base,
      abortSignal: new AbortController().signal,
      headers: { authorization: "secret" },
    };
    expect(hashPrompt(withTransport)).toBe(hashPrompt(base));
  });

  it("a different prompt → DIFFERENT hash", () => {
    expect(hashPrompt(opts("x"))).not.toBe(hashPrompt(opts("y")));
  });

  it("a different temperature → DIFFERENT hash", () => {
    const a: LanguageModelV3CallOptions = { ...opts("x"), temperature: 0 };
    const b: LanguageModelV3CallOptions = { ...opts("x"), temperature: 1 };
    expect(hashPrompt(a)).not.toBe(hashPrompt(b));
  });
});

describe("JSONL serialization", () => {
  it("serialize → parse round-trips to the original events", () => {
    const events: TranscriptEvent[] = [
      {
        runId: "r1",
        eventType: "doGenerate",
        alias: "deepseek.cheap",
        modelId: "deepseek-v4-flash",
        promptHash: "abc123",
        result: { content: [{ type: "text", text: "hi" }] },
      },
      {
        runId: "r1",
        eventType: "doStream",
        alias: "deepseek.cheap",
        modelId: "deepseek-v4-flash",
        promptHash: "def456",
        result: [{ type: "stream-start", warnings: [] }],
      },
    ];
    const jsonl = events.map(serializeTranscriptEvent).join("\n") + "\n";
    expect(parseTranscriptJsonl(jsonl)).toEqual(events);
  });

  it("a single line is newline-free", () => {
    const line = serializeTranscriptEvent({
      runId: "r1",
      eventType: "doGenerate",
      alias: "a",
      modelId: "m",
      promptHash: "h",
      result: { a: 1 },
    });
    expect(line).not.toContain("\n");
  });

  it("blank lines are ignored", () => {
    const ev: TranscriptEvent = {
      runId: "r1",
      eventType: "doGenerate",
      alias: "a",
      modelId: "m",
      promptHash: "h",
      result: { a: 1 },
    };
    const text = `\n${serializeTranscriptEvent(ev)}\n\n`;
    expect(parseTranscriptJsonl(text)).toEqual([ev]);
  });

  it("a malformed line throws (fail loud)", () => {
    expect(() => parseTranscriptJsonl("{not json")).toThrow();
  });
});

describe("JsonlFileSink", () => {
  it("appends one JSON line per event and round-trips via parse", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-sink-"));
    const file = path.join(dir, "nested", "trace.jsonl"); // nested → parent dir created
    try {
      const sink = new JsonlFileSink(file);
      const ev: TranscriptEvent = {
        runId: "r1",
        eventType: "doGenerate",
        alias: "a",
        modelId: "m",
        promptHash: "h",
        result: { a: 1 },
      };
      sink.append(ev);
      sink.append({ ...ev, eventType: "doStream", result: [] });
      const text = fs.readFileSync(file, "utf8");
      expect(parseTranscriptJsonl(text)).toEqual([ev, { ...ev, eventType: "doStream", result: [] }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("registry DI seam — __setHarnessModelWrapper", () => {
  it("wraps resolveModel output; reset restores the real model", () => {
    const tag = { tagged: true } as unknown as LanguageModelV3;
    __setHarnessModelWrapper(() => tag);
    expect(resolveModel("deepseek.cheap")).toBe(tag);
    __resetHarnessModelWrapper();
    const real = resolveModel("deepseek.cheap") as LanguageModelV3;
    expect(real.modelId).toBe("deepseek-v4-flash");
  });

  it("the wrapper receives the resolved model and the alias", () => {
    let seenAlias: string | undefined;
    let seenModelId: string | undefined;
    __setHarnessModelWrapper((m, alias) => {
      seenAlias = alias;
      seenModelId = (m as LanguageModelV3).modelId;
      return m;
    });
    resolveModel("deepseek.cheap");
    expect(seenAlias).toBe("deepseek.cheap");
    expect(seenModelId).toBe("deepseek-v4-flash");
  });

  it("guard: the setter refuses outside a test runner", () => {
    const vitest = process.env["VITEST"];
    const nodeEnv = process.env["NODE_ENV"];
    delete process.env["VITEST"];
    process.env["NODE_ENV"] = "production";
    try {
      expect(() => __setHarnessModelWrapper((m) => m)).toThrow(/test-only seam/);
    } finally {
      if (vitest !== undefined) process.env["VITEST"] = vitest;
      else delete process.env["VITEST"];
      if (nodeEnv !== undefined) process.env["NODE_ENV"] = nodeEnv;
      else delete process.env["NODE_ENV"];
    }
  });
});
