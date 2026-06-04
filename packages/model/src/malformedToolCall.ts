/**
 * #1244 malformed-tool-call detector (Layer 2, loop-level).
 *
 * DeepSeek (and V4-Pro) intermittently emit a tool call as PLAIN TEXT in the
 * content block instead of a structured tool_call. If the loop treats that as
 * "no tool call → final prose", an approval gate that was supposed to fire never
 * does — a W-A class silent degradation, and it happens on the 3 irreversible
 * mutation skills. (currentTruth §"#1244"; risks §2; safetyInvariants §2.)
 *
 * Policy — ALWAYS FAIL-CLOSED:
 *   - finish_reason != "tool_calls"  → suspect
 *   - tool_calls empty/absent        → suspect
 *   - a tool-shaped blob in content  → suspect
 *   Any one ⇒ under HITL: SUSPEND ({reason: "malformed_tool_call"}); with no
 *   HITL: HARD-ABORT (throw typed MalformedToolCallAbort).
 *
 * HARD RULE: NEVER regex-extract a function name from content and execute it.
 * fail-open == silent-fallback, which is forbidden. This detector runs at the
 * loop level, ahead of any "render the prose" path.
 *
 * STUB: the heuristic shell is real (it must be, it is a safety boundary); the
 * exact provider response field plumbing is TODO until the Mastra agent loop is
 * wired in Phase 0.
 *
 * Layer note: this file imports `ai` types only (Layer 2 is the AI SDK layer).
 */

/** Reason codes the loop suspends/aborts with. */
export const MALFORMED_TOOL_CALL_REASON = "malformed_tool_call" as const;

/** Typed abort thrown when there is no human-in-the-loop to suspend to. */
export class MalformedToolCallAbort extends Error {
  readonly reason = MALFORMED_TOOL_CALL_REASON;
  /** Which signal(s) tripped the detector — for trace spans / test_run_records. */
  readonly signals: ReadonlyArray<MalformedSignal>;
  constructor(signals: ReadonlyArray<MalformedSignal>) {
    super(
      `Malformed tool call (#1244 fail-closed): ${signals.join(", ")}. ` +
        `Refusing to regex-extract or fall through to prose.`,
    );
    this.name = "MalformedToolCallAbort";
    this.signals = signals;
  }
}

/** The individual fail-closed triggers. */
export type MalformedSignal =
  | "finish_reason_not_tool_calls"
  | "empty_tool_calls"
  | "tool_shaped_blob_in_content";

/**
 * The minimal slice of a model step the detector inspects. Kept structural so it
 * does not couple to one provider's exact response object.
 */
export interface ToolTurnView {
  /** The step's finish/stop reason as reported by the provider. */
  finishReason: string;
  /** Whether the step intended to call at least one tool (per provider parse). */
  expectsToolCall: boolean;
  /** Number of structured tool calls actually parsed out of the step. */
  toolCallCount: number;
  /** The assistant text content of the step (untrusted; never executed). */
  content: string;
}

/**
 * Heuristic: does `content` look like a tool call was dumped as text?
 *
 * Intentionally conservative + read-only — it ONLY decides "suspect: yes/no".
 * It NEVER parses out a name/args to run. (safetyInvariants §2.)
 *
 * TODO: tune against real DeepSeek #1244 captures from the harness corpus; the
 * COMPANION cites ~11% on an uncontrolled baseline. Add JSON-with-"name"+
 * "arguments", XML-ish <invoke>/<tool_call>, and ```json fenced-blob shapes.
 */
export function looksLikeToolShapedBlob(content: string): boolean {
  if (content.length === 0) return false;
  const trimmed = content.trim();
  // Cheap structural tells; deliberately not a parser.
  const hasJsonToolShape =
    /"(name|tool|function|tool_name)"\s*:/.test(trimmed) &&
    /"(arguments|args|parameters|input)"\s*:/.test(trimmed);
  const hasXmlToolShape = /<\/?(invoke|tool_call|function_calls?|tool_use)\b/i.test(trimmed);
  return hasJsonToolShape || hasXmlToolShape;
  // TODO: broaden once we have labelled #1244 samples; keep it precision-first to
  // avoid false suspends on legitimate prose that merely mentions JSON.
}

/**
 * Inspect a tool turn and return the list of fail-closed signals (empty = clean).
 * Pure + side-effect-free so it is trivially unit-testable at L1.
 */
export function detectMalformedToolCall(turn: ToolTurnView): MalformedSignal[] {
  const signals: MalformedSignal[] = [];
  if (turn.expectsToolCall && turn.finishReason !== "tool_calls") {
    signals.push("finish_reason_not_tool_calls");
  }
  if (turn.expectsToolCall && turn.toolCallCount === 0) {
    signals.push("empty_tool_calls");
  }
  if (looksLikeToolShapedBlob(turn.content)) {
    signals.push("tool_shaped_blob_in_content");
  }
  return signals;
}

/**
 * Enforcement entry point the loop calls after each tool-expecting step.
 *
 * - clean → returns (loop proceeds).
 * - suspect + HITL available → caller SUSPENDS with MALFORMED_TOOL_CALL_REASON.
 * - suspect + no HITL → throws MalformedToolCallAbort.
 *
 * We signal "must suspend" via the return value rather than reaching into the
 * workflow layer (that would invert the dependency direction). The Mastra
 * workflow/agent integration owns the suspend vs. abort decision using
 * `hitlAvailable`.
 */
export function assertToolTurnOrFailClosed(
  turn: ToolTurnView,
  hitlAvailable: boolean,
): { ok: true } | { ok: false; suspend: true; reason: typeof MALFORMED_TOOL_CALL_REASON; signals: MalformedSignal[] } {
  const signals = detectMalformedToolCall(turn);
  if (signals.length === 0) return { ok: true };
  if (!hitlAvailable) {
    throw new MalformedToolCallAbort(signals);
  }
  return { ok: false, suspend: true, reason: MALFORMED_TOOL_CALL_REASON, signals };
  // NEVER: extract a name from `turn.content` and execute it.
}
