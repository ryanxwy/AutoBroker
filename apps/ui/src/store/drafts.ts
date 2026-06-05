/**
 * drafts — the intake form-draft store (FRONTEND_LAYOUT §5.6). A thin localStorage
 * wrapper keyed by the STABLE server runId (NOT the per-fetch clientId — the
 * clientId re-mints on every transcript fetch, the runId survives a refresh, so a
 * mid-form reload recovers the draft; followups §6b / legacy
 * ChatRail.intake.test.tsx:215-243). Three load-bearing disciplines:
 *
 *   1. 24h TTL — a draft older than DRAFT_TTL_MS is treated as absent (and
 *      proactively cleared on read).
 *   2. PII + raw-text STRIP before persist — INTAKE_PII_FIELDS (follow_up_email /
 *      follow_up_phone / trade_in_description) and any freeform raw text NEVER
 *      enter the persisted snapshot (CLAUDE.md §9; FRONTEND §5.6). On restore the
 *      stripped fields come back EMPTY — the UI shows them cleared with a hint.
 *   3. budget_max (INTERNAL_ONLY) is collected and MAY persist locally (it is a
 *      buyer-context value, not PII) but never reaches a dealer surface — that is
 *      enforced at the render layer, not here.
 *
 * This module is framework-thin (no React) so it is trivially unit-testable; the
 * SchemaForm calls it with a debounce. Imports core (the field-meta) + nothing
 * below the app layer.
 */

import { INTAKE_FIELD_META, type IntakeFieldName } from "@autobroker/core";

/** 24h time-to-live for a persisted draft (FRONTEND §5.6). */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/** The localStorage namespace for drafts (one key per runId). */
const DRAFT_PREFIX = "autobroker:draft:";

/** A persisted draft snapshot — PII already stripped before it reaches here. */
export interface DraftSnapshot {
  /** PII-stripped, raw-text-free field values. */
  values: Record<string, unknown>;
  /** Epoch ms at save time (drives the "5m ago" resume banner + TTL). */
  savedAt: number;
}

/** The PII field names to strip before persist (sensitivity === 'pii'). Derived
 *  from the single source (INTAKE_FIELD_META) so a meta change can't drift this. */
export const INTAKE_PII_FIELDS: IntakeFieldName[] = (
  Object.keys(INTAKE_FIELD_META) as IntakeFieldName[]
).filter((name) => INTAKE_FIELD_META[name].sensitivity === "pii");

const PII_SET = new Set<string>(INTAKE_PII_FIELDS);

function keyFor(runId: string): string {
  return `${DRAFT_PREFIX}${runId}`;
}

/** Read localStorage defensively (SSR / disabled storage → null). */
function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Strip PII fields and any raw freeform text from a values map before persist.
 * The PII keys are dropped entirely (not nulled) so the snapshot carries no PII;
 * a known `__rawText`/freeform carrier is also dropped (defensive — the form
 * never stores raw prose in values, but a future prefill carrier must not leak).
 */
export function stripForPersist(values: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (PII_SET.has(k)) continue; // PII — never persist.
    if (k === "__rawText" || k === "freeform_text" || k === "raw_text") continue; // raw prose.
    safe[k] = v;
  }
  return safe;
}

/** Persist a draft for `runId` (debounced by the caller). Strips PII + raw text
 *  FIRST, then writes the snapshot with a fresh savedAt. */
export function saveDraft(runId: string, values: Record<string, unknown>): void {
  const store = storage();
  if (store === null) return;
  const snapshot: DraftSnapshot = { values: stripForPersist(values), savedAt: Date.now() };
  try {
    store.setItem(keyFor(runId), JSON.stringify(snapshot));
  } catch {
    // Quota / private-mode — a lost draft is acceptable, never throw into render.
  }
}

/**
 * Load a draft for `runId`. Returns null when absent, malformed, or older than
 * the 24h TTL (an expired draft is proactively cleared). The returned values are
 * already PII-free (they were stripped at save time) — the form treats the PII
 * inputs as empty and shows a "cleared for privacy" hint.
 */
export function loadDraft(runId: string): DraftSnapshot | null {
  const store = storage();
  if (store === null) return null;
  const raw = store.getItem(keyFor(runId));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    store.removeItem(keyFor(runId));
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof (parsed as DraftSnapshot).savedAt !== "number" ||
    typeof (parsed as DraftSnapshot).values !== "object"
  ) {
    store.removeItem(keyFor(runId));
    return null;
  }
  const snapshot = parsed as DraftSnapshot;
  if (Date.now() - snapshot.savedAt > DRAFT_TTL_MS) {
    store.removeItem(keyFor(runId)); // TTL expired — treat as absent.
    return null;
  }
  return snapshot;
}

/** Drop a draft (after submit/decline, or "Start fresh"). Idempotent. */
export function clearDraft(runId: string): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(keyFor(runId));
  } catch {
    /* ignore */
  }
}
