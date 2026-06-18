/**
 * Shared field readers for the dealer surfaces (DealerTiles + DealerDetailModal).
 * Each reads a named column off the open dealer record by key, narrowing to a
 * usable value (or null when absent/blank). Lifted from the two copies that were
 * byte-identical in both components.
 */

import type { DealerRow } from "../api/wire.js";

/** Read a named string column off the open dealer record (null when absent/blank). */
export function str(row: DealerRow, key: string): string | null {
  const v = row[key];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Read a named numeric column off the open dealer record (null when absent). */
export function num(row: DealerRow, key: string): number | null {
  const v = row[key];
  return typeof v === "number" ? v : null;
}
