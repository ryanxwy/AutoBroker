/**
 * recordCap — the single source of truth for the per-dealer record cap
 * constants and the runtime resolver that reads the configurable env var.
 *
 * Both the envConfigStore descriptor and the workflow reference these exports —
 * no literals are duplicated elsewhere.
 */

/** Default number of listings recorded per dealer website per scan. */
export const PER_DEALER_RECORD_CAP_DEFAULT = 20;

/** Minimum allowed value (at least one listing must be recordable). */
export const PER_DEALER_RECORD_CAP_MIN = 1;

/**
 * Maximum allowed value — matches CARD_COLLECT_MAX in inventorySiteScan.ts.
 * Recording more listings than are collected is meaningless.
 */
export const PER_DEALER_RECORD_CAP_MAX = 80;

/**
 * Resolve the effective per-dealer record cap at call time from
 * process.env.AUTOBROKER_PER_DEALER_RECORD_CAP.
 *
 * Falls back to PER_DEALER_RECORD_CAP_DEFAULT when the env var is absent,
 * empty, or not a valid integer; clamps to [MIN, MAX] for any value outside
 * the permitted range. Tools reading process.env at call time is the
 * established pattern (browser.ts does it for AUTOBROKER_CHROME_HEADLESS) —
 * the workflow must NOT read process.env directly.
 */
export function resolvePerDealerRecordCap(): number {
  const raw = process.env.AUTOBROKER_PER_DEALER_RECORD_CAP;
  if (raw === undefined || raw.length === 0) return PER_DEALER_RECORD_CAP_DEFAULT;
  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || isNaN(parsed)) return PER_DEALER_RECORD_CAP_DEFAULT;
  if (parsed < PER_DEALER_RECORD_CAP_MIN) return PER_DEALER_RECORD_CAP_MIN;
  if (parsed > PER_DEALER_RECORD_CAP_MAX) return PER_DEALER_RECORD_CAP_MAX;
  return parsed;
}
