/**
 * gateModel — classify an awaiting_user suspend payload (spec_inline) into the
 * typed gate variant the UI renders. intake has ONE form
 * suspend (data_collection) plus three SEMANTIC suspends, all on the same SSE
 * awaiting_user channel, discriminated by `spec_inline.kind`
 * (searchProfileIntake.ts suspend payloads):
 *
 *   - data_collection   → the IntakeForm. {kind, form_kind, spec_hint,
 *                         seed_fields, prose} — seed_fields prefill the form; the
 *                         optional `prose` is a verbal ask (a freeform launch
 *                         still missing a required trim) rendered as the form
 *                         gate's lead-in question. Null/absent → no lead-in.
 *   - intake_confirm    → the unconditional end-of-intake buyer confirmation of
 *                         the resolved vehicle. {kind, year, make, model, trim}.
 *                         resume {action:'accept'} | {action:'edit'} |
 *                         {action:'decline'}. Display + human-affirm only (no LLM
 *                         re-validation); shows only the vehicle (no PII/budget).
 *   - ambiguous_location→ multi-candidate ask-pick OR geocode FAILURE
 *                         (coordinate-resolution invariant: coordinates must be
 *                         resolved before persist; geocode failure suspends,
 *                         never silently passes).
 *                         {kind, candidates:[{index,label}], failure_reason,
 *                         stored_candidates, effective_query}. When `candidates`
 *                         is empty AND `failure_reason` is set → the location
 *                         re-fill branch (location flagged + reason + retry).
 *                         resume {action:'pick',picked_index} |
 *                         {action:'retry',retry_query} | {action:'decline'}.
 *
 * The classification is structural (reads named keys defensively off the open
 * wire record) — never regexes a function name out of prose.
 */

export interface LocationCandidate {
  index: number;
  label: string;
}

export interface TrimCandidate {
  index: number;
  name: string;
  summary: string;
}

export type GateModel =
  | { kind: "data_collection"; seedFields: Record<string, unknown> | null; prose: string | null }
  // unconditional end-of-intake buyer confirmation of the resolved vehicle.
  | { kind: "intake_confirm"; year: number | null; make: string; model: string; trim: string }
  // web-grounded trim picker (pre-collect): the buyer gave make+model+year but no
  // trim; pick one, enter it manually (skip), refine the search (retry), or cancel.
  | {
      kind: "trim_suggestion";
      make: string;
      model: string;
      year: number | null;
      candidates: TrimCandidate[];
    }
  | {
      kind: "ambiguous_location";
      candidates: LocationCandidate[];
      effectiveQuery: string | null;
    }
  // location-failure branch (coordinate-resolution invariant): geocode
  // parse/no-result/retry-exhausted → re-fill the form, location field flagged,
  // failure reason shown, user retries (resume retry_query).
  | { kind: "location_failure"; failureReason: string; effectiveQuery: string | null }
  | { kind: "unknown"; raw: Record<string, unknown> | null };

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Classify a spec_inline payload into a typed gate model. */
export function classifyGate(specInline: Record<string, unknown> | null): GateModel {
  if (specInline === null) return { kind: "unknown", raw: null };
  const kind = specInline["kind"];

  if (kind === "data_collection") {
    const seed = specInline["seed_fields"];
    return {
      kind: "data_collection",
      seedFields: seed !== null && typeof seed === "object" ? (seed as Record<string, unknown>) : null,
      // Optional verbal ask (freeform launch still missing a required trim). Any
      // non-string (absent/null) → null → no lead-in renders (slash path).
      prose: str(specInline["prose"]),
    };
  }

  if (kind === "intake_confirm") {
    return {
      kind: "intake_confirm",
      year: num(specInline["year"]),
      make: str(specInline["make"]) ?? "",
      model: str(specInline["model"]) ?? "",
      trim: str(specInline["trim"]) ?? "",
    };
  }

  if (kind === "ambiguous_location") {
    const rawCandidates = specInline["candidates"];
    const candidates: LocationCandidate[] = Array.isArray(rawCandidates)
      ? rawCandidates.flatMap((c) => {
          if (c === null || typeof c !== "object") return [];
          const rec = c as Record<string, unknown>;
          const index = rec["index"];
          const label = str(rec["label"]);
          if (typeof index !== "number" || label === null) return [];
          return [{ index, label }];
        })
      : [];
    const failureReason = str(specInline["failure_reason"]);
    const effectiveQuery = str(specInline["effective_query"]);
    // location-failure split: no candidates + a failure reason → the re-fill branch.
    if (candidates.length === 0 && failureReason !== null) {
      return { kind: "location_failure", failureReason, effectiveQuery };
    }
    return { kind: "ambiguous_location", candidates, effectiveQuery };
  }

  if (kind === "trim_suggestion") {
    const rawCandidates = specInline["candidates"];
    const candidates: TrimCandidate[] = Array.isArray(rawCandidates)
      ? rawCandidates.flatMap((c) => {
          if (c === null || typeof c !== "object") return [];
          const rec = c as Record<string, unknown>;
          const index = rec["index"];
          const name = str(rec["name"]);
          if (typeof index !== "number" || name === null) return [];
          return [{ index, name, summary: str(rec["summary"]) ?? "" }];
        })
      : [];
    return {
      kind: "trim_suggestion",
      make: str(specInline["make"]) ?? "",
      model: str(specInline["model"]) ?? "",
      year: num(specInline["year"]),
      candidates,
    };
  }

  return { kind: "unknown", raw: specInline };
}
