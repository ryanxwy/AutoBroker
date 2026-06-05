/**
 * driverKind — the R2 two-place lock-step self-check (HARNESS_FRAMEWORK §11 / §4.3
 * gate ⑦). The single most dangerous porting trap: the run-init SSE emitter and the
 * evaluator's driver_kind expectation are two SEPARATE word lists coupled only by
 * convention; changing one without the other SILENTLY breaks the anchor. So BEFORE
 * any scoring, the runner probes ONE run-init frame and asserts
 * init.payload.driver_kind === the case expectation. A mismatch fails the run LOUD
 * up front (not as a buried anchor false-PASS/FAIL).
 *
 * COST: the probe starts a run and reads ONLY the init frame, then DECLINES the
 * first (data_collection) suspend so NO LLM call fires (the first harness.generate
 * is at trimVerify, AFTER collect — a decline at collect short-circuits to a
 * zero-write declined terminal). So the self-check is FREE of provider spend.
 *
 * Dependency wall: harness layer. Uses fetch + the detail SSE drain only. No DB, no
 * provider call, no @mastra/@ai-sdk/playwright.
 */

import type { HarnessDriverKind } from "@autobroker/core";

import type { SseEnvelope } from "./detail.js";

export class DriverKindSelfCheckError extends Error {
  constructor(message: string) {
    super(`driver_kind self-check FAILED (two-place lock-step §11): ${message}`);
    this.name = "DriverKindSelfCheckError";
  }
}

/** Start a probe run, read its init frame's driver_kind, then decline to avoid any
 *  LLM spend. Asserts the emitted driver_kind equals `expect`. */
export async function assertDriverKindLockStep(
  apiBase: string,
  expect: HarnessDriverKind,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = apiBase.replace(/\/$/, "");

  // Start a slash run (no freeform → no prefill LLM call; the first suspend is the
  // data_collection form, reached with zero model calls).
  const startRes = await fetchImpl(`${base}/api/skill-runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skill: "search_profile_intake", input_mode: "slash", freeform_text: null, seed_fields: null }),
  });
  if (!startRes.ok) {
    throw new DriverKindSelfCheckError(`POST /api/skill-runs returned HTTP ${startRes.status}`);
  }
  const started = (await startRes.json()) as { run_id?: string };
  const runId = started.run_id;
  if (typeof runId !== "string") {
    throw new DriverKindSelfCheckError("start response missing run_id");
  }

  // Drain the stream to the first awaiting_user (or terminal) and read init.
  const events = await drainProbe(`${base}/api/skill-runs/${encodeURIComponent(runId)}/stream`, fetchImpl);
  const init = events.find((e) => e.kind === "init");
  const observed = init?.payload["driver_kind"];

  // Decline the pending suspend so the run ends declined (zero write, zero spend).
  await declinePending(base, runId, events, fetchImpl).catch(() => {});

  if (observed !== expect) {
    throw new DriverKindSelfCheckError(
      `init.payload.driver_kind="${String(observed)}" but case expects "${expect}" — the emitter and the anchor expect are out of lock-step`,
    );
  }
}

/** Drain only until the init + first awaiting_user/terminal frame is seen (the probe
 *  does not need the whole run). Reuses drainSse but a short-circuit is unnecessary:
 *  the run suspends at collect, so drainSse returns once the awaiting_user fan-out
 *  reaches the connection. To avoid hanging on a suspended (non-terminal) run we
 *  read with a hard timeout. */
async function drainProbe(streamUrl: string, fetchImpl: typeof fetch): Promise<SseEnvelope[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    // A suspended run never sends a terminal frame, so drainSse would block; we read
    // the replay snapshot (init + awaiting_user) which is delivered immediately on
    // subscribe, then abort.
    return await readReplaySnapshot(streamUrl, fetchImpl, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Read just the replay-on-subscribe snapshot (everything already buffered) without
 *  waiting for a terminal frame. We collect frames until a short idle gap, then stop. */
async function readReplaySnapshot(streamUrl: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<SseEnvelope[]> {
  const res = await fetchImpl(streamUrl, { method: "GET", headers: { Accept: "text/event-stream" }, signal });
  if (!res.ok || res.body === null) throw new DriverKindSelfCheckError(`GET stream → HTTP ${res.status}`);
  const events: SseEnvelope[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const handleLine = (line: string): void => {
    const t = line.replace(/\r$/, "");
    if (!t.startsWith("data:")) return;
    const json = t.slice(5).trim();
    if (json.length === 0) return;
    try {
      events.push(JSON.parse(json) as SseEnvelope);
    } catch {
      /* skip non-JSON */
    }
  };
  try {
    // Read one chunk: the replay snapshot (init + awaiting_user) arrives together.
    const { value } = await reader.read();
    if (value !== undefined) {
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    if (buf.length > 0) handleLine(buf);
  } finally {
    await reader.cancel().catch(() => {});
  }
  return events;
}

/** Decline the pending suspend (read its decision_id off the awaiting_user frame). */
async function declinePending(base: string, runId: string, events: SseEnvelope[], fetchImpl: typeof fetch): Promise<void> {
  const await_ = [...events].reverse().find((e) => e.kind === "awaiting_user");
  const decisionId = await_?.payload["decision_id"];
  if (typeof decisionId !== "string") return;
  await fetchImpl(`${base}/api/skill-runs/${encodeURIComponent(runId)}/form-decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision_id: decisionId, decision: { action: "decline" } }),
  });
}
