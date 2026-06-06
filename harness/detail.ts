/**
 * detail — normalize the SUT's SSE stream (+ status projection) into one RunDetail
 * shape the evaluator scores. Like the legacy mode_a_transcript.py, this normalizes
 * any provider's event stream into one detail shape — here the source is the backend's
 * SSE envelope { ts, kind, payload } (data:-only frames, replay-on-subscribe), so
 * one EventSource-style drain gives the full 0→terminal sequence even after the run
 * already finished.
 *
 * TWO READS, one detail (the load-bearing wire facts, harvested from the committed
 * runPubSub.ts + intakeRuns.ts + statusProjection.ts):
 *   1. GET /api/skill-runs/:id/stream — the ordered SSE frames. The init frame
 *      carries payload.driver_kind ('deepseek_apikey'); terminal wire kinds are
 *      EXACTLY done|error|aborted.
 *   2. GET /api/skill-runs/:id — the STATUS PROJECTION. A user DECLINE lands on the
 *      wire as `aborted{reason:'user_declined'}` but the product status is
 *      `declined` (runPubSub + statusProjection). So terminalStatus is read
 *      from the projected status (which distinguishes declined from aborted), not
 *      from the bare wire kind. run_status anchor depends on this.
 *
 * COST/TIME: the intake `done` frame payload is EMPTY ({}) — usage is NOT on the
 * wire. Per-LLM-call usage is written to test_run_records by the SUT's harness.generate
 * (one row per call, keyed by runId). So RunDetail.usage is left null here; the
 * cost_and_time anchor reads the ledger rows for runId via the read-only DB channel
 * (evaluator.ts), NOT from the SSE stream. (Live-observed: the done frame is empty.)
 *
 * Dependency wall: harness layer. Uses global fetch only; no DB handle, no provider
 * call, no @mastra/@ai-sdk/playwright import.
 */

import type { HarnessDriverKind } from "@autobroker/core";

/** One SSE frame, mirroring the backend SseEvent shape (runPubSub.ts). */
export interface SseEnvelope {
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
}

/** The product terminal statuses the run_status anchor compares against. Mirrors
 *  the projected core SkillRunStatus terminal subset (statusProjection.ts). */
export type TerminalStatus = "done" | "error" | "declined" | "aborted" | null;

/** Usage/timing for the cost_and_time anchor. Left null off the SSE stream (intake
 *  `done` carries no usage); the evaluator fills these from test_run_records. */
export interface RunUsage {
  costUsd: number | null;
  durationMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  pricingSource: "computed" | "unavailable";
}

/** The normalized run detail — the single shape evalAnchor scores. */
export interface RunDetail {
  runId: string;
  terminalStatus: TerminalStatus;
  driverKind: HarnessDriverKind | null;
  events: SseEnvelope[];
  sawBrowserActivity: boolean;
  sawApprovalGate: boolean;
  /** gate-before-prose: true when an awaiting_user/approval frame precedes the
   *  FIRST prose `text` frame (assert_gate_before_prose). */
  gateBeforeProse: boolean;
  sawMalformedToolCall: boolean;
  usage: RunUsage;
}

/** SSE kinds that count as an approval/HITL gate render (approval_gate anchor). */
const APPROVAL_KINDS = new Set(["awaiting_user", "awaiting_permission", "approval_required"]);

/** Terminal WIRE kinds (runPubSub TERMINAL_EVENT_KINDS). `declined` is NOT here —
 *  it is a status projection of an `aborted{user_declined}` frame. */
const TERMINAL_WIRE_KINDS = new Set(["done", "error", "aborted"]);

/** A browser.* frame or a tool_call whose name matches a browser driver (browser_activity anchor). */
function isBrowserEvent(ev: SseEnvelope): boolean {
  if (ev.kind.startsWith("browser.")) return true;
  if (ev.kind === "tool_call") {
    const name = String(ev.payload["name"] ?? ev.payload["tool"] ?? "");
    return /chrome-devtools|playwright|browser_/i.test(name);
  }
  return false;
}

/** A #1244 malformed-tool-call signal on the wire (§6.2). The SUT surfaces it as
 *  an awaiting_user/error frame whose payload mentions the malformed kind/reason,
 *  or a MalformedToolCallAbort. We trust STRUCTURED payload fields, never a regex
 *  over free-text prose (invariant #4). */
function isMalformedSignal(ev: SseEnvelope): boolean {
  const p = ev.payload;
  const formKind = String(p["form_kind"] ?? "");
  if (formKind === "malformed_tool_call") return true;
  const specKind = ((p["spec_inline"] as { kind?: unknown } | undefined)?.kind ?? "") as string;
  if (specKind === "malformed_tool_call") return true;
  const reason = String(p["reason"] ?? "");
  if (reason === "malformed_tool_call" || reason === "MalformedToolCallAbort") return true;
  return false;
}

/** Read the driver_kind off the init frame payload (the two-place lock-step value). */
function driverKindOf(events: SseEnvelope[]): HarnessDriverKind | null {
  const init = events.find((e) => e.kind === "init");
  const dk = init?.payload["driver_kind"];
  return typeof dk === "string" ? (dk as HarnessDriverKind) : null;
}

/** Whether an approval/gate frame precedes the first prose `text` frame. A run
 *  with no prose at all but a gate frame still counts as gate-before-prose (the
 *  gate rendered; nothing prose-ish ever beat it). */
function computeGateBeforeProse(events: SseEnvelope[]): boolean {
  const firstGateIdx = events.findIndex((e) => APPROVAL_KINDS.has(e.kind));
  if (firstGateIdx === -1) return false;
  const firstProseIdx = events.findIndex((e) => e.kind === "text");
  if (firstProseIdx === -1) return true;
  return firstGateIdx < firstProseIdx;
}

/**
 * Drain the SSE stream to its terminal frame and return the full ordered frame
 * list. Replay-on-subscribe means a late subscribe still yields 0→terminal. We
 * parse `data: <json>` lines; comment (`: heartbeat`) lines are ignored. The drain
 * ends when a terminal wire kind lands OR the connection closes.
 */
export async function drainSse(
  streamUrl: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<SseEnvelope[]> {
  const res = await fetchImpl(streamUrl, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || res.body === null) {
    throw new Error(`drainSse: GET ${streamUrl} → HTTP ${res.status}`);
  }

  const events: SseEnvelope[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let terminal = false;

  const handleLine = (line: string): void => {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.startsWith("data:")) return; // comments / blank lines ignored.
    const json = trimmed.slice("data:".length).trim();
    if (json.length === 0) return;
    let ev: SseEnvelope;
    try {
      ev = JSON.parse(json) as SseEnvelope;
    } catch {
      return; // a non-JSON data line is not a frame we score.
    }
    events.push(ev);
    if (TERMINAL_WIRE_KINDS.has(ev.kind)) terminal = true;
  };

  try {
    while (!terminal) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
  } finally {
    // Drop the live connection once terminal (replay already gave us everything).
    await reader.cancel().catch(() => {});
  }
  // Flush any trailing buffered line.
  if (buf.length > 0) handleLine(buf);
  return events;
}

/** Read the projected product status for the run (distinguishes declined). Returns
 *  null when the run is unknown to the SUT (404). */
async function fetchProjectedStatus(
  apiBase: string,
  runId: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const url = `${apiBase.replace(/\/$/, "")}/api/skill-runs/${encodeURIComponent(runId)}`;
  const res = await fetchImpl(url, { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  const body = (await res.json()) as { status?: unknown };
  return typeof body.status === "string" ? body.status : null;
}

/** Map a projected product status string onto the TerminalStatus union (only the
 *  terminal four matter to run_status; in-flight statuses → null). */
function asTerminalStatus(projected: string | null, events: SseEnvelope[]): TerminalStatus {
  if (projected === "done" || projected === "error" || projected === "declined" || projected === "aborted") {
    return projected;
  }
  // Fallback to the last terminal WIRE frame if the projection is in-flight/absent.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]!;
    if (ev.kind === "done") return "done";
    if (ev.kind === "error") return "error";
    if (ev.kind === "aborted") {
      return ev.payload["reason"] === "user_declined" ? "declined" : "aborted";
    }
  }
  return null;
}

/**
 * Build the RunDetail: drain the SSE stream, read the projected status, derive the
 * model-agnostic signals. usage is left null (intake `done` has no usage); the
 * evaluator fills cost/time from test_run_records.
 */
export async function buildRunDetail(
  apiBase: string,
  runId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RunDetail> {
  const base = apiBase.replace(/\/$/, "");
  const streamUrl = `${base}/api/skill-runs/${encodeURIComponent(runId)}/stream`;
  const events = await drainSse(streamUrl, fetchImpl);
  const projected = await fetchProjectedStatus(base, runId, fetchImpl);

  return {
    runId,
    terminalStatus: asTerminalStatus(projected, events),
    driverKind: driverKindOf(events),
    events,
    sawBrowserActivity: events.some(isBrowserEvent),
    sawApprovalGate: events.some((e) => APPROVAL_KINDS.has(e.kind)),
    gateBeforeProse: computeGateBeforeProse(events),
    sawMalformedToolCall: events.some(isMalformedSignal),
    usage: {
      costUsd: null,
      durationMs: null,
      promptTokens: null,
      completionTokens: null,
      pricingSource: "unavailable",
    },
  };
}

/**
 * Build a RunDetail from a pre-captured frame list + projected status — the OFFLINE
 * path the evaluator unit tests use (fixtures synthesized from the real wire shapes)
 * and the dry-run path uses. No network. usage may be supplied by the caller (the
 * cost_and_time fixture) or left null.
 */
export function buildRunDetailFromEvents(
  runId: string,
  events: SseEnvelope[],
  projectedStatus: string | null,
  usage?: Partial<RunUsage>,
): RunDetail {
  return {
    runId,
    terminalStatus: asTerminalStatus(projectedStatus, events),
    driverKind: driverKindOf(events),
    events,
    sawBrowserActivity: events.some(isBrowserEvent),
    sawApprovalGate: events.some((e) => APPROVAL_KINDS.has(e.kind)),
    gateBeforeProse: computeGateBeforeProse(events),
    sawMalformedToolCall: events.some(isMalformedSignal),
    usage: {
      costUsd: usage?.costUsd ?? null,
      durationMs: usage?.durationMs ?? null,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      pricingSource: usage?.pricingSource ?? "unavailable",
    },
  };
}
