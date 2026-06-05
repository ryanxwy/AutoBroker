/**
 * profileView — read the named columns the home/snapshot surfaces need off an
 * open snake_case ProfileRow (wire.ts ProfileRowSchema is a passthrough record;
 * routes.ts:262-275). The SnapshotCard / WhatHappensNext consume these.
 *
 * BUDGET INVARIANT (CLAUDE.md §9 / FRONTEND §8.3): budget_max is INTERNAL_ONLY —
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
    dealerCount: num(row, "dealer_count"),
    threadCount: num(row, "thread_count"),
    bestOtd: num(row, "best_otd"),
  };
}

/** A short "Year Make Model" vehicle label (drops empties). */
export function vehicleLabel(s: ProfileSnapshot): string {
  return [s.year, s.make, s.model, s.trim].filter((p) => p !== null && p !== "").join(" ").trim();
}

/** "city, ST" distillation for a location string (FRONTEND §7 formatLocation). */
export function formatLocation(loc: string | null): string | null {
  if (loc === null) return null;
  const parts = loc.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const stateToken = parts[1]!.split(/\s+/)[0] ?? "";
    return `${parts[0]}, ${stateToken}`;
  }
  return parts[0] ?? null;
}
