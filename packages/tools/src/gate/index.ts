/**
 * L2 in-process gate bridge — the load-bearing layer of the four-layer gate
 * stack. THIS IS THE SINGLE SIDE-EFFECT PATH.
 *
 * Gate stack (revised 2026-06-03 for the Mastra backbone):
 *   L3  native Mastra tool/step approval or suspend — convenience only,
 *                                        api-key lane only.
 *   L2  THIS in-process gate bridge    — LOAD-BEARING, all lanes, fail-CLOSED,
 *                                        single structured path. (Renamed from
 *                                        the legacy `build_sdk_mcp_server`.)
 *   --  fallback-gate suspend          — workflow re-asks the human.
 *
 * The send floor is the per-seam `!isBuyerMode()` mode brake (AUTOBROKER_MODE=
 * "test" resolves every send fake/local), re-asserted at each network boundary;
 * this gate is the always-on approval layer above it. AUTOBROKER_MODE is the
 * sole send-control variable.
 *
 * SAFETY INVARIANTS this file physically enforces:
 *   1. A side effect (gmail.send / browser.submit) is reachable ONLY by calling
 *      gate handlers below. There is no second code path. callers in
 *      gmail.ts / browser.ts MUST funnel mutating ops through `requestApproval`.
 *   2. FAIL-CLOSED on malformed/absent tool calls (#1244): if the structured
 *      gate request is missing or malformed, we DENY. We never fall back to
 *      prose, never regex a function name out of free-text content and execute
 *      it. fail-open == silent-fallback == forbidden.
 *   3. The DENY path returns an explicit decline/cancel verdict with
 *      `autoApprove: false` — the safe default. Approval is never implicit.
 */

/** Categories of irreversible external action that MUST pass the gate. */
export type MutationKind =
  | "gmail_send"
  | "dealer_form_submit";

/** A structured, already-validated request to perform one mutating action. */
export interface GateRequest {
  kind: MutationKind;
  /** Stable id of the skill/run asking, for audit + Decision-table linkage. */
  runId: string;
  /** Human-readable summary surfaced to the approver. Never hidden. */
  summary: string;
  /** Action-specific payload (recipient, form fields, confirm token …). */
  payload: Record<string, unknown>;
}

/** Verdict returned by the gate. `autoApprove` is the unsafe convenience flag;
 *  it defaults false everywhere and is never set true on a deny path. */
export type GateVerdict =
  | { decision: "approved"; autoApprove: boolean }
  | { decision: "declined"; autoApprove: false; reason: string };

/** The human/automated approver the gate consults. In production this is the
 *  dashboard approval UI; in the live harness it is the deny_all poller. */
export interface Approver {
  /** Returns true ONLY on an explicit human/poller approval. Any error or
   *  ambiguity from the approver MUST be treated by the gate as not-approved. */
  decide(req: GateRequest): Promise<boolean>;
}

/**
 * Test-mode block signal. Thrown by a mutating seam (the browser form-submit
 * brake) when AUTOBROKER_MODE is not buyer, so the action is refused before it
 * touches the network. The lead-submit workflow catches this to record a FAKE
 * submission instead of clicking. (Previously the L1-fuse signal; re-homed as
 * the mode brake's refusal now that AUTOBROKER_MODE is the sole send-control.)
 */
export class ExternalMutationsBlockedError extends Error {
  constructor(kind: MutationKind) {
    super(
      `refusing mutating action "${kind}" in test mode (AUTOBROKER_MODE != buyer) before it touches the network.`,
    );
    this.name = "ExternalMutationsBlockedError";
  }
}

/** Thrown when the structured gate request is absent/malformed (#1244). The
 *  gate NEVER recovers by parsing prose; it aborts closed. */
export class MalformedGateRequestError extends Error {
  constructor(detail: string) {
    super(`Malformed gate request — failing CLOSED: ${detail}`);
    this.name = "MalformedGateRequestError";
  }
}

const VALID_KINDS: ReadonlySet<string> = new Set<MutationKind>([
  "gmail_send",
  "dealer_form_submit",
]);

/**
 * Structurally validate an inbound gate request. Returns the request unchanged
 * if well-formed; THROWS (fail-closed) otherwise. This is the #1244 detector at
 * the gate boundary: a side-effect call with no/garbled structured request dies
 * here rather than degrading to free-text execution.
 */
function assertWellFormed(req: unknown): asserts req is GateRequest {
  if (req === null || typeof req !== "object") {
    throw new MalformedGateRequestError("request is not an object");
  }
  const r = req as Record<string, unknown>;
  if (typeof r.kind !== "string" || !VALID_KINDS.has(r.kind)) {
    throw new MalformedGateRequestError(`unknown mutation kind: ${String(r.kind)}`);
  }
  if (typeof r.runId !== "string" || r.runId.length === 0) {
    throw new MalformedGateRequestError("missing runId");
  }
  if (typeof r.summary !== "string") {
    throw new MalformedGateRequestError("missing approver summary");
  }
  // TODO(phase-4): per-kind Zod payload schema from @autobroker/core; reject any
  // payload that fails post-validation (flat, required, explicit-null, enums).
}

/**
 * The single side-effect entry point. Every mutating tool in this package calls
 * this and performs its effect ONLY inside the supplied `commit` callback, and
 * ONLY when this returns an `approved` verdict.
 *
 * Order of defenses, all fail-CLOSED:
 *   (a) structural validation (#1244 detector) — throws on malformed.
 *   (b) approver consult — any non-true / any thrown error => declined.
 */
export async function requestApproval(
  req: unknown,
  approver: Approver,
): Promise<GateVerdict> {
  // (a) fail-closed on malformed/absent structured request.
  assertWellFormed(req);

  // (b) consult the approver; treat ANY error or non-true as NOT approved.
  let approved = false;
  try {
    approved = (await approver.decide(req)) === true;
  } catch {
    approved = false; // fail-closed: an approver that errors is a decline.
  }

  if (!approved) {
    return {
      decision: "declined",
      autoApprove: false,
      reason: `approval not granted for ${req.kind}`,
    };
  }
  // Explicit approval. autoApprove stays false unless an upstream policy opts in
  // — it is never implied by the approval itself.
  return { decision: "approved", autoApprove: false };
}

/**
 * Helper for mutating tools: run `commit` if and only if the gate approves.
 * Tools should never branch on the verdict themselves — funnel through here so
 * the "approved => and only then => commit" rule lives in exactly one place.
 */
export async function withGate<T>(
  req: GateRequest,
  approver: Approver,
  commit: () => Promise<T>,
): Promise<T | GateVerdict> {
  const verdict = await requestApproval(req, approver);
  if (verdict.decision !== "approved") {
    return verdict; // declined — caller surfaces it, no effect.
  }
  // TODO(phase-4): record an audit row (run, kind, approver verdict) here before
  // commit so the audit log can never lag the side effect.
  return commit();
}
