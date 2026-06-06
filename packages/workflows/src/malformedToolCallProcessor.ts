/**
 * #1244 fail-closed detector as a Mastra OUTPUT PROCESSOR (Layer 3 adapter).
 *
 * The pure detection logic lives in @autobroker/model (detectMalformedToolCall
 * over a ToolTurnView) — this file is ONLY the Mastra-shaped shell: run on
 * `processOutputStep`
 * (i.e. BEFORE tool execution), and on any signal fail CLOSED via the
 * processor `abort()` (TripWire) — NEVER regex a function name out of content
 * and execute it, and NEVER route through the AI SDK's
 * `experimental_repairToolCall` auto-repair path (we never set that option;
 * this processor never passes `retry: true`, which would feed the malformed
 * step back to the model — auto-repair by another name).
 *
 * Suspend-vs-abort mapping: a processor can only stop the run (TripWire). The
 * HITL decision happens where the agent call is wrapped: the workflow step
 * catches the TripWire and — using the `hitlAvailable` + signals carried in
 * the TripWire metadata — either suspends the run (HITL) or rethrows as the
 * typed MalformedToolCallAbort (no HITL). See @autobroker/model harness notes.
 *
 * finishReason normalization: the AI SDK v5/Mastra step reports `tool-calls`
 * (hyphen); the detector's ToolTurnView speaks `tool_calls` (provider-raw).
 * Normalizing is THIS adapter's job, so the pure detector stays
 * provider-structural.
 */

import type { Processor, ProcessOutputStepArgs } from "@mastra/core/processors";
import {
  detectMalformedToolCall,
  MALFORMED_TOOL_CALL_REASON,
  type MalformedSignal,
  type ToolTurnView,
} from "@autobroker/model";

/** Metadata carried on the TripWire so the workflow wrapper can map it to
 *  suspend (HITL) or a typed MalformedToolCallAbort (no HITL). */
export interface MalformedToolCallTripMetadata {
  reason: typeof MALFORMED_TOOL_CALL_REASON;
  signals: MalformedSignal[];
  hitlAvailable: boolean;
}

export interface MalformedToolCallProcessorOptions {
  /** Whether a human is available to suspend to. Carried into the TripWire
   *  metadata; the workflow wrapper makes the suspend/abort call. */
  hitlAvailable: boolean;
  /**
   * Whether the CURRENT step is tool-expecting, from the LOOP's own state
   * (tools registered, terminal emit_result not fired yet) — NEVER derived
   * from the provider's parse (see ToolTurnView.expectsToolCall).
   *
   * Default: () => true — correct for the emit_result single-tool discipline,
   * where every step until emit_result fires is tool-expecting. Override only
   * for lanes with a legitimate prose finish. Defaulting to true over-trips
   * (fail-closed) rather than under-trips (fail-open).
   */
  expectsToolCall?: (args: ProcessOutputStepArgs<MalformedToolCallTripMetadata>) => boolean;
}

/** AI SDK v5 / Mastra hyphenated finish reason → detector's provider-raw token. */
function normalizeFinishReason(finishReason: string | undefined): string {
  if (finishReason === undefined) return "";
  return finishReason === "tool-calls" ? "tool_calls" : finishReason;
}

/**
 * Build the Mastra output processor. Attach via the agent's / call's
 * `outputProcessors: [malformedToolCallProcessor({hitlAvailable})]`.
 */
export function malformedToolCallProcessor(
  options: MalformedToolCallProcessorOptions,
): Processor<"autobroker-1244-fail-closed", MalformedToolCallTripMetadata> {
  const expectsToolCall = options.expectsToolCall ?? (() => true);

  return {
    id: "autobroker-1244-fail-closed",
    name: "AutoBroker #1244 fail-closed detector",

    processOutputStep(args) {
      const turn: ToolTurnView = {
        finishReason: normalizeFinishReason(args.finishReason),
        expectsToolCall: expectsToolCall(args),
        toolCallCount: args.toolCalls?.length ?? 0,
        content: args.text ?? "",
      };

      const signals = detectMalformedToolCall(turn);
      if (signals.length > 0) {
        // Fail CLOSED. retry stays false/absent ALWAYS — retry:true would feed
        // the malformed step back to the model, i.e. framework auto-repair.
        args.abort(
          `${MALFORMED_TOOL_CALL_REASON}: ${signals.join(", ")} (step ${args.stepNumber})`,
          {
            metadata: {
              reason: MALFORMED_TOOL_CALL_REASON,
              signals,
              hitlAvailable: options.hitlAvailable,
            },
          },
        );
      }

      // Clean turn: pass messages through untouched.
      return args.messages;
    },
  };
}
