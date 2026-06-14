/**
 * hygiene detect — the THREE deterministic, GLOBAL read queries that compute the
 * dealer-hygiene cleanup candidate sets, plus the idempotent already-suppressed
 * pre-filter. Zero LLM: candidacy is pure set membership + structural SQL.
 *
 * SOFT SCOPE (load-bearing): every query is GLOBAL. The optional `profileId` is
 * recorded as provenance (the trace sink) but is NEVER a WHERE filter — hygiene
 * sweeps the whole mailbox regardless of which search is pinned. This is the
 * deliberate divergence from the profile-scoped scan skills.
 *
 * The three candidate sets:
 *   - findOrphanThreads   — `threads` rows with ZERO `messages`, whose
 *                           gmail_thread_id is actually a real
 *                           messages.gmail_message_id (a message-id mis-saved as
 *                           a thread record). These are the only HARD-DELETE
 *                           candidates (no provenance, no messages).
 *   - findCrmOnlyThreads  — inbound-only threads (no `offers` row), where the
 *                           same dealer has ANOTHER outbound thread, state is not
 *                           'agreed', AND the current message_analysis.intent is
 *                           in the suppressible CRM-noise set. SUPPRESS candidates.
 *   - findCrmPlatformContacts — dealer_contacts flagged is_crm_platform_sender,
 *                           NOT the primary reply target, owning ZERO dealer_quotes
 *                           (via their messages). DEMOTE (soft) candidates.
 *
 * KEEP BIAS: a thread with ANY offer row, or an intent in the value class
 * {quote, pricing, qualification}, NEVER surfaces (filtered here, re-asserted as a
 * throwing guard in the writer). A contact owning any quote NEVER surfaces.
 *
 * SQLITE INVARIANT: raw better-sqlite3 handle (db.$client) only — no drizzle-orm.
 *
 * Dependency wall: imports @autobroker/db (the Db handle type) + the pure
 * classifier only.
 */

import type { Db } from "@autobroker/db";

import { isSuppressibleIntent, SUPPRESSIBLE_INTENTS, VALUE_INTENTS } from "./classify.js";

// SQL `IN (...)` literal lists built ONCE from the closed intent sets in
// classify.ts (the single source of truth). The set members are static internal
// constants (never user input), so inlining them as quoted literals is safe.
const SUPPRESSIBLE_IN_LIST = [...SUPPRESSIBLE_INTENTS].map((i) => `'${i}'`).join(", ");
const VALUE_IN_LIST = [...VALUE_INTENTS].map((i) => `'${i}'`).join(", ");

// ---------------------------------------------------------------------------
// soft-scope provenance trace (the pin is LOGGED, never a WHERE filter)
// ---------------------------------------------------------------------------

/** The narrow trace sink the soft profile scope is recorded on. Default writes
 *  one structured line; tests inject a spy to assert the provenance fired. */
export type HygieneScopeTrace = (record: {
  event: "hygiene_global_scope";
  query: string;
  profileId: string | null;
}) => void;

const defaultScopeTrace: HygieneScopeTrace = (record) => {
  console.info(JSON.stringify({ trace: "hygiene", ...record }));
};

// ---------------------------------------------------------------------------
// candidate row shapes
// ---------------------------------------------------------------------------

export interface OrphanThreadCandidate {
  thread_id: string;
  dealer_name: string;
  /** The thread's stored gmail_thread_id — actually a real message_id. The
   *  RED-LINE value the writer DELETEs the row over but NEVER suppresses. */
  gmail_thread_id: string;
  reason: string;
}

export interface CrmThreadCandidate {
  thread_id: string;
  dealer_name: string;
  subject: string | null;
  intent: string;
  reason: string;
}

export interface CrmContactCandidate {
  contact_id: string;
  display_name: string | null;
  normalized_email: string;
  dealer_name: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// 5a — orphan threads (the only hard-delete candidate set)
// ---------------------------------------------------------------------------

// A thread is an orphan when: it has ZERO messages, AND its gmail_thread_id is
// non-null AND that value exists as a real messages.gmail_message_id (a
// message-id mis-saved as a thread record). The dealer name is joined for the
// review label.
const SELECT_ORPHANS =
  "SELECT t.thread_id AS thread_id, t.gmail_thread_id AS gmail_thread_id, " +
  "COALESCE(d.name, '(unknown dealer)') AS dealer_name " +
  "FROM threads t " +
  "LEFT JOIN dealers d ON d.dealer_id = t.dealer_id " +
  "WHERE t.gmail_thread_id IS NOT NULL " +
  "AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.thread_id) " +
  "AND EXISTS (SELECT 1 FROM messages m2 WHERE m2.gmail_message_id = t.gmail_thread_id) " +
  "ORDER BY t.thread_id";

/** Find the orphan-thread cleanup candidates (GLOBAL; profileId logged only). */
export function findOrphanThreads(
  db: Db,
  profileId: string | null,
  trace: HygieneScopeTrace = defaultScopeTrace,
): OrphanThreadCandidate[] {
  trace({ event: "hygiene_global_scope", query: "findOrphanThreads", profileId });
  const rows = db.$client.prepare(SELECT_ORPHANS).all() as Array<{
    thread_id: string;
    gmail_thread_id: string;
    dealer_name: string;
  }>;
  return rows.map((r) => ({
    thread_id: r.thread_id,
    dealer_name: r.dealer_name,
    gmail_thread_id: r.gmail_thread_id,
    reason: "empty record — no messages, id is a stray message-id",
  }));
}

// ---------------------------------------------------------------------------
// 5b — CRM-only threads (suppress candidates)
// ---------------------------------------------------------------------------

// An inbound-only thread (no offers row) whose dealer ALSO has another OUTBOUND
// thread (a real conversation exists), state is not 'agreed', joined to its
// CURRENT message_analysis intent.
//
// MIXED-INTENT RED-LINE (load-bearing): a thread with MULTIPLE current analyses
// (e.g. one 'nurture' + one 'quote') must NEVER surface — under GROUP BY the
// bare `ma.intent` is an arbitrary row, so a thread that also carries a
// value-class intent could leak through and then be rejected by the write
// guard, rolling back the whole all-or-nothing run. So we gate on the thread's
// WHOLE current-intent set:
//   - NONE may be value-class {quote, pricing, qualification}, AND
//   - at least ONE must be suppressible CRM-noise.
// Both lists are derived from classify.ts (the single source of truth). The JS
// `isSuppressibleIntent` filter on the surfaced intent stays as the last line of
// defense; the write guard remains the final backstop.
const SELECT_CRM_THREADS =
  "SELECT t.thread_id AS thread_id, t.subject AS subject, " +
  "COALESCE(d.name, '(unknown dealer)') AS dealer_name, " +
  "ma.intent AS intent " +
  "FROM threads t " +
  "LEFT JOIN dealers d ON d.dealer_id = t.dealer_id " +
  // the thread's current analysis intent (via its messages → current analysis)
  "JOIN messages m ON m.thread_id = t.thread_id " +
  "JOIN message_analysis ma ON ma.message_id = m.message_id AND ma.is_current = 1 " +
  "WHERE (t.state IS NULL OR t.state <> 'agreed') " +
  // inbound-only: no offers row references this thread
  "AND NOT EXISTS (SELECT 1 FROM offers o WHERE o.thread_id = t.thread_id) " +
  // the same dealer has ANOTHER outbound thread (a real conversation exists)
  "AND EXISTS (" +
  "  SELECT 1 FROM messages mo " +
  "  JOIN threads t2 ON t2.thread_id = mo.thread_id " +
  "  WHERE t2.dealer_id = t.dealer_id AND t2.thread_id <> t.thread_id " +
  "  AND mo.direction = 'outbound'" +
  ") " +
  // mixed-intent red-line: NO current intent may be value-class …
  "AND NOT EXISTS (" +
  "  SELECT 1 FROM messages mv " +
  "  JOIN message_analysis mav ON mav.message_id = mv.message_id AND mav.is_current = 1 " +
  `  WHERE mv.thread_id = t.thread_id AND mav.intent IN (${VALUE_IN_LIST})` +
  ") " +
  // … and at least ONE current intent must be suppressible CRM-noise.
  "AND EXISTS (" +
  "  SELECT 1 FROM messages ms " +
  "  JOIN message_analysis mas ON mas.message_id = ms.message_id AND mas.is_current = 1 " +
  `  WHERE ms.thread_id = t.thread_id AND mas.intent IN (${SUPPRESSIBLE_IN_LIST})` +
  ") " +
  "GROUP BY t.thread_id " +
  "ORDER BY t.thread_id";

/** Find the CRM-noise inbound-only thread suppression candidates (GLOBAL;
 *  profileId logged only). KEEP-biased: only suppressible intents survive. */
export function findCrmOnlyThreads(
  db: Db,
  profileId: string | null,
  trace: HygieneScopeTrace = defaultScopeTrace,
): CrmThreadCandidate[] {
  trace({ event: "hygiene_global_scope", query: "findCrmOnlyThreads", profileId });
  const rows = db.$client.prepare(SELECT_CRM_THREADS).all() as Array<{
    thread_id: string;
    subject: string | null;
    dealer_name: string;
    intent: string | null;
  }>;
  const out: CrmThreadCandidate[] = [];
  for (const r of rows) {
    if (!isSuppressibleIntent(r.intent)) continue; // KEEP everything else.
    out.push({
      thread_id: r.thread_id,
      dealer_name: r.dealer_name,
      subject: r.subject,
      intent: r.intent!.trim().toLowerCase(),
      reason: `${r.intent!.trim().toLowerCase()} follow-up, no quote`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5c — CRM platform contacts (soft-demote candidates)
// ---------------------------------------------------------------------------

// A contact flagged as a CRM-platform sender, NOT the primary reply target, and
// owning ZERO dealer_quotes (no dealer_quotes row references any message this
// contact sent). quotes_owned = 0 is the structural KEEP gate.
// A demoted contact is recorded with a contact-scope cleanup suppression row (no
// new column / no migration). Excluding those here is what makes a re-run a
// no-op even though is_crm_platform_sender stays 1 (the detection signal and the
// flip target are the same column — the suppression row is the idempotent gate).
const SELECT_CRM_CONTACTS =
  "SELECT dc.contact_id AS contact_id, dc.display_name AS display_name, " +
  "dc.normalized_email AS normalized_email, " +
  "COALESCE(d.name, '(unknown dealer)') AS dealer_name " +
  "FROM dealer_contacts dc " +
  "LEFT JOIN dealers d ON d.dealer_id = dc.dealer_id " +
  "WHERE dc.is_crm_platform_sender = 1 " +
  "AND COALESCE(dc.is_primary_reply_target, 0) = 0 " +
  "AND NOT EXISTS (" +
  "  SELECT 1 FROM dealer_quotes dq " +
  "  JOIN messages m ON m.message_id = dq.message_id " +
  "  WHERE m.contact_id = dc.contact_id" +
  ") " +
  "AND NOT EXISTS (" +
  "  SELECT 1 FROM thread_suppression ts " +
  "  WHERE ts.contact_id = dc.contact_id AND ts.scope = 'contact' AND ts.action = 'cleanup'" +
  ") " +
  "ORDER BY dc.contact_id";

/** Find the CRM-platform contact soft-demote candidates (GLOBAL; profileId
 *  logged only). Owning any quote excludes the contact (quotes_owned = 0 gate). */
export function findCrmPlatformContacts(
  db: Db,
  profileId: string | null,
  trace: HygieneScopeTrace = defaultScopeTrace,
): CrmContactCandidate[] {
  trace({ event: "hygiene_global_scope", query: "findCrmPlatformContacts", profileId });
  const rows = db.$client.prepare(SELECT_CRM_CONTACTS).all() as Array<{
    contact_id: string;
    display_name: string | null;
    normalized_email: string;
    dealer_name: string;
  }>;
  return rows.map((r) => ({
    contact_id: r.contact_id,
    display_name: r.display_name,
    normalized_email: r.normalized_email,
    dealer_name: r.dealer_name,
    reason: "auto-sender (lead platform), no quote, not primary contact",
  }));
}

// ---------------------------------------------------------------------------
// idempotent pre-filter — the threads already suppressed (cleanup scope)
// ---------------------------------------------------------------------------

/** The set of thread_ids already suppressed with the hygiene cleanup action —
 *  the detection caller pre-filters these so a re-run after a clean surfaces
 *  nothing (idempotent no-op). Read-only. */
export function listSuppressions(db: Db): Set<string> {
  const rows = db.$client
    .prepare(
      "SELECT DISTINCT thread_id AS id FROM thread_suppression " +
        "WHERE thread_id IS NOT NULL AND action = 'cleanup'",
    )
    .all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}
