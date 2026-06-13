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
}

/** The single mutable scenario (flipped by setScenario / a fixture state). */
export const scenario: Scenario = { location: "resolved", trimValid: true };

/** Apply a partial scenario (a fixture state's `scenario` block, or a control
 *  route flip). Unspecified fields keep their current value. */
export function setScenario(partial: Partial<Scenario> | undefined | null): void {
  if (partial == null) return;
  if (partial.location !== undefined) scenario.location = partial.location;
  if (partial.trimValid !== undefined) scenario.trimValid = partial.trimValid;
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

/** resolveLocation stub: returns the current scenario's outcome (NO live geocode). */
export const resolveLocationStub = async (): Promise<unknown> => {
  switch (scenario.location) {
    case "ambiguous":
      return AMBIGUOUS;
    case "failed":
      return FAILED;
    default:
      return RESOLVED;
  }
};

/** harnessGenerate stub: a trim_verify verdict from scenario.trimValid; a fixed
 *  freeform-prefill seed otherwise (NO live LLM). */
export const harnessGenerateStub = async (input: { useCase: string }): Promise<unknown> => {
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
