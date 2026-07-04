/**
 * profileView — read the named columns the home/snapshot surfaces need off an
 * open snake_case ProfileRow (wire.ts ProfileRowSchema is a passthrough record;
 * routes.ts:262-275). The SnapshotCard / Canvas profile card consume these.
 *
 * BUDGET INVARIANT (budget red-line, see CLAUDE.md): budget_max is INTERNAL_ONLY —
 * it is DELIBERATELY not read here. This module is the only profile-projection
 * the dealer-facing summary surfaces use, and it has no budget accessor, so a
 * summary/preview physically cannot render budget. INTAKE_INTERNAL_ONLY_FIELDS is
 * the audit anchor for which keys are excluded.
 */

import { INTAKE_INTERNAL_ONLY_FIELDS } from "@autobroker/core";

import type { ProfileRow } from "../api/wire.js";

function str(row: ProfileRow, key: string): string | null {
  const v = row[key];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}
function num(row: ProfileRow, key: string): number | null {
  const v = row[key];
  return typeof v === "number" ? v : null;
}

/** The dealer-safe snapshot projection — NO budget, ever. */
export interface ProfileSnapshot {
  id: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  location: string | null;
  /** Postal/ZIP code (postal_code column) — used for the rail pinned-search title. */
  postalCode: string | null;
  searchRadiusMiles: number | null;
  financingPreference: string | null;
  phonePolicy: string | null;
  /** Lifecycle status ('active' | 'closed' | 'superseded' | null) — the
   *  Closed-searches group reads this; the active list is filtered server-side. */
  status: string | null;
  dealerCount: number | null;
  threadCount: number | null;
  bestOtd: number | null;
}

/** Keys excluded from every summary/preview surface (the budget guard, audited). */
export const SUMMARY_EXCLUDED_KEYS: ReadonlyArray<string> = INTAKE_INTERNAL_ONLY_FIELDS;

export function toSnapshot(row: ProfileRow): ProfileSnapshot {
  return {
    id: str(row, "search_profile_id"),
    year: num(row, "year"),
    make: str(row, "make"),
    model: str(row, "model"),
    trim: str(row, "trim"),
    location: str(row, "location_query") ?? str(row, "location"),
    postalCode: str(row, "postal_code"),
    searchRadiusMiles: num(row, "search_radius_miles"),
    financingPreference: str(row, "financing_preference"),
    phonePolicy: str(row, "phone_policy"),
    status: str(row, "status"),
    dealerCount: num(row, "dealer_count"),
    threadCount: num(row, "thread_count"),
    bestOtd: num(row, "best_otd"),
  };
}

/** A short "Year Make Model" vehicle label (drops empties). */
export function vehicleLabel(s: ProfileSnapshot): string {
  return [s.year, s.make, s.model, s.trim].filter((p) => p !== null && p !== "").join(" ").trim();
}

/** The search's 5-digit ZIP for the rail pinned-search title: the explicit
 *  postal_code column when it starts with a ZIP (a +4 suffix is dropped), else a
 *  ZIP at the END of the freeform location_query (which intake shapes as
 *  "City, ST 92614"). Anchoring to the end avoids grabbing a leading street
 *  number. Null when neither yields one. */
export function zipOf(s: ProfileSnapshot): string | null {
  const fromColumn = s.postalCode?.trim().match(/^(\d{5})(?:-\d{4})?$/)?.[1] ?? null;
  if (fromColumn !== null) return fromColumn;
  return s.location?.match(/(\d{5})(?:-\d{4})?\s*$/)?.[1] ?? null;
}

/** "city, ST" distillation for a location string. */
export function formatLocation(loc: string | null): string | null {
  if (loc === null) return null;
  const parts = loc.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const stateToken = parts[1]!.split(/\s+/)[0] ?? "";
    return `${parts[0]}, ${stateToken}`;
  }
  return parts[0] ?? null;
}
