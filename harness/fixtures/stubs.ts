/**
 * stubs — the deterministic DI stubs the FUNCTIONAL lane injects into the SUT
 * (through @autobroker/workflows' test-guarded __setIntakeDepsForTests seam) so a
 * functional case runs with ZERO live LLM and ZERO live geocode. The two external
 * collaborators the intake workflow reaches are replaced:
 *
 *   - resolveLocation — the geocoder. Returns one of three fixed outcomes
 *     (resolved / ambiguous / failed) selected by the mutable scenario.
 *   - harnessGenerate — the model harness. Returns a fixed trim_verify verdict
 *     (driven by scenario.trimValid) or a fixed freeform-prefill seed.
 *
 * A single mutable `scenario` drives both stubs; the stubs read it per-call, so
 * one long-lived host process serves every functional case deterministically (a
 * fixture state flips it via setScenario). The usage meter is always EMPTY — the
 * functional lane records no cost (no model call ever happens).
 *
 * Dependency wall: harness layer. Pure data + closures; imports nothing.
 */

/** The geocode outcome a functional scenario selects. */
export type ScenarioLocation = "resolved" | "ambiguous" | "failed";

/** The mutable scenario both stubs read per-call. */
export interface Scenario {
  /** Which geocode outcome resolveLocationStub returns. */
  location: ScenarioLocation;
  /** The trim_verify verdict harnessGenerateStub returns. */
  trimValid: boolean;
  /** When true, the intake_trim_verify generate call fail-closes with a #1244
   *  malformed_tool_call HarnessSuspend (the deterministic twin of a real DeepSeek
   *  malformed/text-dumped tool call that the LIVE lane cannot stage). Default
   *  false — every other case runs clean. */
  llmMalformed: boolean;
  /** A deterministic injectable fault for the func lane (T4-U2). "tool_timeout"
   *  makes resolveLocationStub reject on the NEXT TICK (not a wall-clock hang →
   *  no flaky timer in the gate), exercising fail-closed on a transient tool fault.
   *  Default "none". */
  fault: "none" | "tool_timeout";
}

/** The single mutable scenario (flipped by setScenario / a fixture state). */
export const scenario: Scenario = { location: "resolved", trimValid: true, llmMalformed: false, fault: "none" };

/** Apply a partial scenario (a fixture state's `scenario` block, or a control
 *  route flip). Unspecified fields keep their current value. */
export function setScenario(partial: Partial<Scenario> | undefined | null): void {
  if (partial == null) return;
  if (partial.location !== undefined) scenario.location = partial.location;
  if (partial.trimValid !== undefined) scenario.trimValid = partial.trimValid;
  if (partial.llmMalformed !== undefined) scenario.llmMalformed = partial.llmMalformed;
  if (partial.fault !== undefined) scenario.fault = partial.fault;
}

/** No model call ever fires through these stubs, so every usage meter is empty —
 *  the functional lane records no cost. */
const NO_USAGE = {
  costUsd: null,
  durationMs: 0,
  pricingSource: "unavailable" as const,
  promptTokens: null,
  completionTokens: null,
};

const RESOLVED = {
  kind: "resolved",
  location: {
    lat: 33.6695,
    lng: -117.7669,
    formattedAddress: "Irvine, CA 92602, USA",
    postalCode: "92602",
  },
  traceSpans: [],
};

const AMBIGUOUS = {
  kind: "ambiguous",
  candidates: [
    { lat: 31.7619, lng: -106.485, formattedAddress: "El Paso, TX, USA", postalCode: "79901" },
    { lat: 33.0801, lng: -83.2321, formattedAddress: "El Paso, GA, USA", postalCode: "31097" },
  ],
  traceSpans: [],
};

const FAILED = {
  kind: "failed",
  reason: "no_result",
  detail: "ZERO_RESULTS (functional stub)",
  traceSpans: [],
};

/** resolveLocation stub: returns the current scenario's outcome (NO live geocode).
 *  When scenario.fault==="tool_timeout" (T4-U2), reject on the next tick — a
 *  transient tool fault the intake geocode step must fail CLOSED on (no fabricated
 *  coords, no NULL-coords persist), NEVER a hallucinated "resolved". */
export const resolveLocationStub = async (): Promise<unknown> => {
  if (scenario.fault === "tool_timeout") {
    await Promise.resolve(); // settle on the next microtask — deterministic, no timer.
    throw new Error("tool_timeout (injected fault: geocode, func lane)");
  }
  switch (scenario.location) {
    case "ambiguous":
      return AMBIGUOUS;
    case "failed":
      return FAILED;
    default:
      return RESOLVED;
  }
};

/** fetchTrimSources stub: NEVER hit the real web in the func lane. {kind:'none'}
 *  makes the trimSuggestion step pass straight through to the data_collection form
 *  (no trim_suggestion suspend), so the existing intake func cases stay identical. */
export const fetchTrimSourcesStub = async (): Promise<unknown> => ({ kind: "none" });

/** harnessGenerate stub: a trim_verify verdict from scenario.trimValid; a fixed
 *  freeform-prefill seed otherwise (NO live LLM). */
export const harnessGenerateStub = async (input: { useCase: string }): Promise<unknown> => {
  // #1244 fail-closed injection: the deterministic twin of a real DeepSeek
  // malformed/text-dumped tool call. The intake LLM step (trimVerify) treats a
  // HarnessSuspend as a malformed_tool_call suspend (fail-closed to the human) —
  // signals member of MalformedSignal[] (model/malformedToolCall.ts).
  if (scenario.llmMalformed && input.useCase === "intake_trim_verify") {
    return { suspended: true, reason: "malformed_tool_call", signals: ["finish_reason_not_tool_calls"] };
  }
  if (input.useCase === "intake_trim_verify") {
    return {
      object: {
        valid: scenario.trimValid,
        attestation: scenario.trimValid ? "trim exists" : "trim not found in catalog",
        suggested_trims: scenario.trimValid ? [] : ["SE", "Limited"],
      },
      usage: NO_USAGE,
    };
  }
  // intake_trim_lookup — defensive: with fetchTrimSourcesStub returning {none} the
  // trimSuggestion step never reaches this call, but keep a valid empty extraction
  // so a future scenario can't get a prefill-shaped object back here.
  if (input.useCase === "intake_trim_lookup") {
    return { object: { trim_names: [], trim_summaries: [] }, usage: NO_USAGE };
  }
  // intake_freeform_prefill — a fixed nullable subset seed (PII/budget absent).
  return {
    object: {
      make: "Hyundai",
      model: "Tucson",
      year: 2026,
      trim: null,
      location_query: "Irvine, CA",
      search_radius_miles: null,
      financing_preference: "finance",
    },
    usage: NO_USAGE,
  };
};
