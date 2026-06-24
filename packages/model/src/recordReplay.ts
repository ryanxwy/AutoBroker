/**
 * Record/Replay model seam (Layer 2) — deterministic LLM replays for the
 * Phase-4 multi-profile harness lane.
 *
 * The SUT talks to DeepSeek through the AI SDK; `resolveModel(alias)` is the
 * single function returning the `LanguageModelV3`. This module supplies:
 *   - `recordingModel`  — Proxy-wraps a real model, TEES every doGenerate/doStream
 *                         call to a JSONL transcript sink while still handing the
 *                         caller a live result/stream (the wrap is identity-
 *                         preserving, the same idiom as registry.ts's
 *                         wrapWithGenerateFault).
 *   - `replayModel`     — a synthesized v3 model (NO real provider) that returns
 *                         the recorded calls token-for-token, keyed by a stable
 *                         prompt hash, with per-eventType cursors.
 * Both fail LOUD: replay exhaustion and prompt-hash mismatch throw typed errors
 * (never a silent pass/fail), mirroring the project-wide fail-closed posture.
 *
 * The host-side install (swapping these in via `resolveModel` with the registry
 * DI seam) is a separate task; this module owns only the record/replay machinery.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";

// --- Transcript shapes ------------------------------------------------------

/** One recorded LLM call. Flat, all-required (no optional fields). */
export interface TranscriptEvent {
  runId: string;
  eventType: "doGenerate" | "doStream";
  /** The ModelAlias resolveModel was called with (recording context). */
  alias: string;
  /** The real model's modelId — for ReplayModel identity + pricing. */
  modelId: string;
  /** hashPrompt(callOptions) — the replay key. */
  promptHash: string;
  /**
   * doGenerate: the LanguageModelV3GenerateResult.
   * doStream:  the ordered LanguageModelV3StreamPart[].
   */
  result: unknown;
}

/** Append-only transcript collector (an in-memory array or a JSONL file). */
export interface TranscriptSink {
  append(ev: TranscriptEvent): void;
}

// --- Stable prompt hashing --------------------------------------------------

/**
 * JSON.stringify with deterministically SORTED object keys, so two structurally
 * equal values always serialize to the same string regardless of key order.
 * Arrays preserve order (order is meaningful for messages/parts).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${entries.join(",")}}`;
}

/**
 * STABLE hash of the prompt-determining fields of a v3 call. Same prompt → same
 * hash; a changed prompt → a different hash. Excludes non-deterministic /
 * transport fields (abortSignal, headers) so they never perturb the key.
 */
export function hashPrompt(options: LanguageModelV3CallOptions): string {
  const canon = stableStringify({
    prompt: options.prompt,
    tools: options.tools ?? null,
    responseFormat: options.responseFormat ?? null,
    temperature: options.temperature ?? null,
    topP: options.topP ?? null,
    seed: options.seed ?? null,
  });
  return createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

// --- JSONL serialization ----------------------------------------------------

/** Serialize one event to a single JSON line (no embedded newlines). */
export function serializeTranscriptEvent(ev: TranscriptEvent): string {
  return JSON.stringify(ev);
}

/**
 * Parse a JSONL transcript: split on newlines, ignore blank lines, JSON.parse
 * each. Throws a clear error on a malformed line (fail loud).
 */
export function parseTranscriptJsonl(text: string): TranscriptEvent[] {
  const out: TranscriptEvent[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line === undefined || line === "") continue;
    try {
      out.push(JSON.parse(line) as TranscriptEvent);
    } catch (err) {
      throw new Error(
        `parseTranscriptJsonl: malformed JSON on line ${i + 1}: ${(err as Error).message}`,
      );
    }
  }
  return out;
}

/** Append-only JSONL transcript file sink (creates the parent dir if missing). */
export class JsonlFileSink implements TranscriptSink {
  constructor(private readonly path: string) {}

  append(ev: TranscriptEvent): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, serializeTranscriptEvent(ev) + "\n");
  }
}

// --- Recording model (TEE wrap) ---------------------------------------------

/**
 * Proxy-wrap `real` so every doGenerate/doStream call is recorded to `sink`
 * while the caller still gets a live result/stream. The Proxy preserves the
 * real model's prototype, getters, and identity fields (modelId/provider/
 * specificationVersion/supportedUrls) — only doGenerate/doStream are intercepted;
 * everything else delegates to the real target with methods bound to it. This is
 * the same identity-preserving idiom as registry.ts's wrapWithGenerateFault.
 */
export function recordingModel(
  real: LanguageModelV3,
  sink: TranscriptSink,
  ctx: { runId: string; alias: string },
): LanguageModelV3 {
  const recordGenerate: LanguageModelV3["doGenerate"] = async (options) => {
    const r = await real.doGenerate(options);
    sink.append({
      runId: ctx.runId,
      eventType: "doGenerate",
      alias: ctx.alias,
      modelId: real.modelId,
      promptHash: hashPrompt(options),
      result: r,
    });
    return r;
  };

  const recordStream: LanguageModelV3["doStream"] = async (options) => {
    const { stream, ...rest } = await real.doStream(options);
    const collected: LanguageModelV3StreamPart[] = [];
    // TEE: record each chunk while re-emitting it through a passthrough stream so
    // the caller still consumes a live, complete stream. The sink append fires
    // when the SOURCE closes (flush), so the recorded result is the full ordered
    // sequence even if the caller cancels early.
    const teed = stream.pipeThrough(
      new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
        transform(chunk, controller) {
          collected.push(chunk);
          controller.enqueue(chunk);
        },
        flush() {
          sink.append({
            runId: ctx.runId,
            eventType: "doStream",
            alias: ctx.alias,
            modelId: real.modelId,
            promptHash: hashPrompt(options),
            result: collected,
          });
        },
      }),
    );
    return { stream: teed, ...rest };
  };

  return new Proxy(real, {
    get(target, prop) {
      if (prop === "doGenerate") return recordGenerate;
      if (prop === "doStream") return recordStream;
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// --- Replay errors (fail loud) ----------------------------------------------

/** Thrown when a replay reads past the last recorded event of its eventType. */
export class ReplayExhaustedError extends Error {
  constructor(
    public readonly eventType: TranscriptEvent["eventType"],
    public readonly cursorIndex: number,
  ) {
    super(
      `ReplayExhaustedError: no more recorded "${eventType}" events ` +
        `(cursor ${cursorIndex} past the last recorded event of this type)`,
    );
    this.name = "ReplayExhaustedError";
  }
}

/**
 * Thrown when the next recorded event's promptHash does not match the replay
 * request — the recorded trace no longer matches the SUT's prompts. `needsReRecord`
 * is always true: the fix is to re-record, not to silently pass or fail.
 */
export class ReplayPromptMismatchError extends Error {
  public readonly needsReRecord = true;
  constructor(
    public readonly eventType: TranscriptEvent["eventType"],
    public readonly expectedHash: string,
    public readonly observedHash: string,
  ) {
    super(
      `ReplayPromptMismatchError: "${eventType}" prompt hash mismatch ` +
        `(recorded ${expectedHash}, observed ${observedHash}) — needs re-record`,
    );
    this.name = "ReplayPromptMismatchError";
  }
}

// --- Trace index (per-eventType cursors) ------------------------------------

/**
 * Holds the recorded events and advances an INDEPENDENT cursor per eventType.
 * Interleaved doGenerate/doStream replays each consume from their own ordered
 * subsequence, so the replay order of one type never depends on the other.
 */
export class TraceIndex {
  private readonly byType: Record<TranscriptEvent["eventType"], TranscriptEvent[]> = {
    doGenerate: [],
    doStream: [],
  };
  private readonly cursors: Record<TranscriptEvent["eventType"], number> = {
    doGenerate: 0,
    doStream: 0,
  };

  constructor(events: TranscriptEvent[]) {
    for (const ev of events) {
      this.byType[ev.eventType].push(ev);
    }
  }

  /**
   * Return the next recorded event of `eventType` whose promptHash matches.
   * Exhaustion or a hash mismatch fail LOUD (typed throw); a mismatch does NOT
   * advance the cursor so the recorded event stays reachable for diagnosis.
   */
  next(eventType: TranscriptEvent["eventType"], promptHash: string): TranscriptEvent {
    const cursor = this.cursors[eventType];
    const events = this.byType[eventType];
    if (cursor >= events.length) {
      throw new ReplayExhaustedError(eventType, cursor);
    }
    const event = events[cursor]!;
    if (event.promptHash !== promptHash) {
      throw new ReplayPromptMismatchError(eventType, event.promptHash, promptHash);
    }
    this.cursors[eventType] = cursor + 1;
    return event;
  }
}

// --- Replay model (no provider) ---------------------------------------------

/**
 * A synthesized v3 model (NO real provider) that returns recorded calls
 * token-for-token, keyed by hashPrompt and consumed via the TraceIndex cursors.
 * Built the same way as testSupport's makeStaticModel.
 */
export function replayModel(
  index: TraceIndex,
  ctx: { alias: string; modelId: string },
): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "autobroker-replay",
    modelId: ctx.modelId,
    supportedUrls: {},
    // `async` so a synchronous index.next() throw (exhaustion / hash mismatch)
    // surfaces as a rejected promise, matching the LanguageModelV3 PromiseLike
    // contract — never an uncaught synchronous throw.
    doGenerate: async (options) => {
      const ev = index.next("doGenerate", hashPrompt(options));
      return ev.result as LanguageModelV3GenerateResult;
    },
    doStream: async (options) => {
      const ev = index.next("doStream", hashPrompt(options));
      const parts = ev.result as LanguageModelV3StreamPart[];
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const part of parts) {
              controller.enqueue(part);
            }
            controller.close();
          },
        }),
      };
    },
  };
}
