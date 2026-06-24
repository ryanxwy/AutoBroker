/**
 * multiprofile/invariants — the Phase-4 metamorphic / property invariants.
 *
 * Phase-4 runs N profile pipelines concurrently. After each interleaved step the
 * harness asserts THESE invariants (properties, not transcripts). Each invariant
 * is a pure function returning a `DeterministicResult` (the FROZEN shared verdict
 * contract from ../verdict.js). The DB-backed ones read an isolated `Db` handle
 * the CALLER owns; the trace/sample-backed ones take typed inputs. `runAllInvariants`
 * folds the applicable checks into a flat `DeterministicResult[]`.
 *
 * READ-ONLY: every SQL statement here is a SELECT (no INSERT/UPDATE/DELETE). The
 * queries run through the `Db` handle's raw client (`$client.prepare(sql).all/get`)
 * — the same wall-legal pattern dbReads uses (we never import better-sqlite3 /
 * drizzle-orm / playwright directly).
 *
 * #9 (budget never leaks) is honored TWICE: the budget invariant scans outbound
 * bodies for the figure AND its own `detail` NEVER echoes the budget number — it
 * names the leaking message_id, not the figure.
 *
 * Dependency wall: harness layer. Imports @autobroker/db (the Db TYPE) + reuses
 * DeterministicResult from ../verdict.js. Never a framework / raw driver / playwright.
 */

import type { Db } from "@autobroker/db";

import type { DeterministicResult } from "../verdict.js";

// ---------------------------------------------------------------------------
// typed inputs (the trace/sample-backed invariants + the aggregator)
// ---------------------------------------------------------------------------

/** Per-run ordered event kinds the L2-gate-before-send invariant reads. */
export interface SendGateTrace {
  runId: string;
  events: ("approval_gate" | "send" | string)[];
}

/** A profile-ASK resolver outcome (the 1/0/2 branch the invariant checks). */
export interface ProfileAskObservation {
  activeCount: number;
  pinned: boolean;
  outcome: "run" | "stop";
}

/** A best-OTD sample over time for one profile (monotonicity invariant). */
export interface OtdSample {
  profileId: string;
  t: number;
  bestOtd: number;
}

export interface MpInvariantInputs {
  /** An isolated read handle (caller owns lifetime). */
  db: Db;
  /** The known/active profile ids in this run. */
  profileIds: string[];
  /** The responsive-cap ceiling (default 10). */
  followupCeiling?: number;
  /** Per-run ordered event kinds (L2-gate-before-send). */
  traces?: SendGateTrace[];
  /** Resolver outcomes to check the 1/0/2 branch. */
  profileAsk?: ProfileAskObservation[];
  /** best-OTD samples over time per profile. */
  otdSeries?: OtdSample[];
}

// ---------------------------------------------------------------------------
// read-only SQL helper (wall-legal: uses the Db handle, never a raw driver import)
// ---------------------------------------------------------------------------

/** Fail-closed: refuse any non-SELECT SQL (mirrors dbReads' guard). */
function assertReadOnly(sql: string): void {
  if (!sql.trimStart().slice(0, 6).toUpperCase().startsWith("SELECT")) {
    throw new Error(`multiprofile/invariants is READ-ONLY — refusing non-SELECT SQL: "${sql.slice(0, 40)}…"`);
  }
}

function readAll<T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []): T[] {
  assertReadOnly(sql);
  return db.$client.prepare(sql).all(...params) as T[];
}

// ---------------------------------------------------------------------------
// 1. dealership exclusivity
// ---------------------------------------------------------------------------

/**
 * dealership_exclusivity. ok iff:
 *  (a) no dealer_id has >1 profile_dealers row with status='bound';
 *  (b) every excluded_conflict row has a non-null, non-empty exclusion_reason
 *      (the conflict is VOICED in the DB);
 *  (c) for every excluded_conflict (profile,dealer): ZERO submitted lead AND ZERO
 *      outbound message (joined through a thread of that profile,dealer) — the
 *      conflicted rooftop produced ZERO web-form AND ZERO email send for the loser.
 * Matches claimDealer's real status semantics (bound | excluded_conflict +
 * exclusion_reason='engaged_by:<holder>').
 */
export function assertDealershipExclusivity(db: Db): DeterministicResult {
  const id = "dealership_exclusivity";

  // (a) a dealer bound to >1 profile.
  const doubleBound = readAll<{ dealer_id: string; n: number }>(
    db,
    `SELECT dealer_id, COUNT(*) AS n FROM profile_dealers WHERE status = 'bound' GROUP BY dealer_id HAVING COUNT(*) > 1`,
  );
  if (doubleBound.length > 0) {
    const d = doubleBound[0]!;
    return fail(id, `dealer ${d.dealer_id} is bound to ${d.n} profiles (exclusivity broken)`);
  }

  // (b) an excluded_conflict with no voiced reason.
  const unvoiced = readAll<{ search_profile_id: string; dealer_id: string }>(
    db,
    `SELECT search_profile_id, dealer_id FROM profile_dealers
      WHERE status = 'excluded_conflict'
        AND (exclusion_reason IS NULL OR TRIM(exclusion_reason) = '')`,
  );
  if (unvoiced.length > 0) {
    const u = unvoiced[0]!;
    return fail(id, `excluded_conflict (profile ${u.search_profile_id}, dealer ${u.dealer_id}) has no exclusion_reason (conflict not voiced)`);
  }

  // (c1) the loser still produced a submitted lead.
  const leaked = readAll<{ search_profile_id: string; dealer_id: string }>(
    db,
    `SELECT pd.search_profile_id, pd.dealer_id
       FROM profile_dealers pd
       JOIN lead_submissions ls
         ON ls.search_profile_id = pd.search_profile_id
        AND ls.dealer_id = pd.dealer_id
        AND ls.outcome = 'submitted'
      WHERE pd.status = 'excluded_conflict'`,
  );
  if (leaked.length > 0) {
    const l = leaked[0]!;
    return fail(id, `conflict loser (profile ${l.search_profile_id}, dealer ${l.dealer_id}) produced a submitted lead`);
  }

  // (c2) the loser still produced an outbound message (via a thread of that profile,dealer).
  const outbound = readAll<{ search_profile_id: string; dealer_id: string; message_id: string }>(
    db,
    `SELECT pd.search_profile_id, pd.dealer_id, m.message_id
       FROM profile_dealers pd
       JOIN threads t
         ON t.search_profile_id = pd.search_profile_id
        AND t.dealer_id = pd.dealer_id
       JOIN messages m
         ON m.thread_id = t.thread_id
        AND m.direction = 'outbound'
      WHERE pd.status = 'excluded_conflict'`,
  );
  if (outbound.length > 0) {
    const o = outbound[0]!;
    return fail(id, `conflict loser (profile ${o.search_profile_id}, dealer ${o.dealer_id}) sent outbound message ${o.message_id}`);
  }

  return ok(id, "no double-bound dealer; every conflict voiced + silent for the loser");
}

// ---------------------------------------------------------------------------
// 2. no cross-profile bleed
// ---------------------------------------------------------------------------

/** The NOT-NULL-search_profile_id tables every row must scope to a known profile. */
const PROFILE_SCOPED_TABLES = [
  "profile_dealers",
  "dealer_quotes",
  "inventory_listings",
  "dealer_inventory_sources",
  "quote_audits",
  "thread_routing",
] as const;

/**
 * no_cross_profile_bleed. For each NOT-NULL-search_profile_id table, every row's
 * search_profile_id ∈ profileIds. `detail` lists the first stray row.
 */
export function assertNoCrossProfileBleed(db: Db, profileIds: string[]): DeterministicResult {
  const id = "no_cross_profile_bleed";
  const known = new Set(profileIds);
  for (const table of PROFILE_SCOPED_TABLES) {
    // Read distinct profile ids present in the table; the table name is a fixed
    // literal from PROFILE_SCOPED_TABLES (never user input) — no injection surface.
    const rows = readAll<{ search_profile_id: string | null }>(
      db,
      `SELECT DISTINCT search_profile_id FROM ${table}`,
    );
    for (const row of rows) {
      const spid = row.search_profile_id;
      if (spid === null || !known.has(spid)) {
        return fail(id, `${table} has a row scoped to unknown profile "${spid ?? "∅"}"`);
      }
    }
  }
  return ok(id, "every profile-scoped row belongs to a known profile");
}

// ---------------------------------------------------------------------------
// 3. budget never leaks (#9)
// ---------------------------------------------------------------------------

/** Every plausible rendering of a budget figure to scan for (38000, 38,000,
 *  $38,000, $38000, 38k). Lowercased so the k-form matches case-insensitively. */
function budgetRenderings(budget: number): string[] {
  const n = Math.round(budget);
  const plain = String(n);
  const commas = n.toLocaleString("en-US"); // e.g. 38,000
  const k = n % 1000 === 0 ? `${n / 1000}k` : null;
  const out = [plain, commas, `$${commas}`, `$${plain}`];
  if (k !== null) out.push(k);
  return out.map((s) => s.toLowerCase());
}

/**
 * budget_no_leak (#9). For each profile read budget_max; if set, scan that
 * profile's OUTBOUND messages' body_text for the budget number in any plausible
 * rendering. ZERO matches. `detail` names the leaking message_id — NEVER the
 * budget figure (#9 honored in the produced output too).
 */
export function assertBudgetNeverLeaks(db: Db, profileIds: string[]): DeterministicResult {
  const id = "budget_no_leak";
  for (const profileId of profileIds) {
    const prof = readAll<{ budget_max: number | null }>(
      db,
      `SELECT budget_max FROM search_profiles WHERE search_profile_id = ?`,
      [profileId],
    )[0];
    const budget = prof?.budget_max;
    if (budget === undefined || budget === null) continue;
    const renderings = budgetRenderings(budget);
    const msgs = readAll<{ message_id: string; body_text: string | null }>(
      db,
      `SELECT message_id, body_text FROM messages WHERE direction = 'outbound' AND search_profile_id = ?`,
      [profileId],
    );
    for (const m of msgs) {
      const body = (m.body_text ?? "").toLowerCase();
      if (renderings.some((r) => body.includes(r))) {
        // #9: name the message, NOT the figure.
        return fail(id, `budget number leaked into outbound message ${m.message_id} (profile ${profileId})`);
      }
    }
  }
  return ok(id, "no outbound message echoes the budget figure");
}

// ---------------------------------------------------------------------------
// 4. history-id no skip (every inbound message attributed)
// ---------------------------------------------------------------------------

/**
 * history_id_no_skip. Every inbound message is ATTRIBUTED to a known profile
 * (non-null search_profile_id ∈ profileIds). A skipped historyId surfaces as an
 * inbound message with a null/foreign search_profile_id. `detail` names the
 * orphaned message.
 */
export function assertHistoryIdNoSkip(db: Db, profileIds: string[]): DeterministicResult {
  const id = "history_id_no_skip";
  const known = new Set(profileIds);
  const inbound = readAll<{ message_id: string; search_profile_id: string | null }>(
    db,
    `SELECT message_id, search_profile_id FROM messages WHERE direction = 'inbound'`,
  );
  for (const m of inbound) {
    const spid = m.search_profile_id;
    if (spid === null || !known.has(spid)) {
      return fail(id, `inbound message ${m.message_id} is unattributed (search_profile_id="${spid ?? "∅"}")`);
    }
  }
  return ok(id, "every inbound message is attributed to a known profile");
}

// ---------------------------------------------------------------------------
// 5. followup cap
// ---------------------------------------------------------------------------

/**
 * followup_cap. Per thread, the count of consecutive TRAILING outbound (un-replied)
 * messages ≤ ceiling (default 10). Order by rowid (not received_at). `detail` names
 * the over-cap thread.
 */
export function assertFollowupCap(db: Db, profileIds: string[], ceiling = 10): DeterministicResult {
  const id = "followup_cap";
  const known = new Set(profileIds);
  // All messages ordered by thread then rowid; we walk trailing outbound per thread.
  const rows = readAll<{ thread_id: string; direction: string }>(
    db,
    `SELECT m.thread_id, m.direction
       FROM messages m
       JOIN threads t ON t.thread_id = m.thread_id
      WHERE t.search_profile_id IN (${placeholders(profileIds.length)})
      ORDER BY m.thread_id ASC, m.rowid ASC`,
    profileIds,
  );
  // Tally trailing-outbound run per thread (reset on any inbound).
  const trailing = new Map<string, number>();
  for (const r of rows) {
    if (r.direction === "outbound") trailing.set(r.thread_id, (trailing.get(r.thread_id) ?? 0) + 1);
    else trailing.set(r.thread_id, 0);
  }
  for (const [threadId, count] of trailing) {
    if (count > ceiling) {
      return fail(id, `thread ${threadId} has ${count} consecutive trailing outbound (cap ${ceiling})`);
    }
  }
  void known; // profileIds already constrain the join; kept for signature parity.
  return ok(id, `every thread's trailing-outbound run is within the cap (${ceiling})`);
}

function placeholders(n: number): string {
  return n === 0 ? "''" : new Array(n).fill("?").join(", ");
}

// ---------------------------------------------------------------------------
// 6. L2 gate before send (trace-backed)
// ---------------------------------------------------------------------------

/**
 * l2_gate_before_send. ok iff in every trace, every "send" is preceded (earlier
 * index) by an "approval_gate" with no intervening reset. We model the gate as a
 * one-shot consumed by the next send: an "approval_gate" arms a pending gate; a
 * "send" must find one armed (and consumes it). A send with no armed gate fails.
 */
export function assertL2GateBeforeSend(traces: SendGateTrace[]): DeterministicResult {
  const id = "l2_gate_before_send";
  for (const trace of traces) {
    let armed = 0;
    for (const ev of trace.events) {
      if (ev === "approval_gate") armed += 1;
      else if (ev === "send") {
        if (armed <= 0) {
          return fail(id, `run ${trace.runId}: a "send" had no preceding "approval_gate"`);
        }
        armed -= 1;
      }
    }
  }
  return ok(id, "every send is preceded by an approval gate");
}

// ---------------------------------------------------------------------------
// 7. profile-ASK branch (observation-backed)
// ---------------------------------------------------------------------------

/**
 * profile_ask_branch. ok iff: pinned→run; else activeCount===1→run;
 * activeCount===0→stop; activeCount>=2→stop. `detail` names the violating
 * observation.
 */
export function assertProfileAskBranch(observations: ProfileAskObservation[]): DeterministicResult {
  const id = "profile_ask_branch";
  for (const o of observations) {
    const expected: "run" | "stop" = o.pinned ? "run" : o.activeCount === 1 ? "run" : "stop";
    if (o.outcome !== expected) {
      return fail(
        id,
        `profile-ASK branch violated: pinned=${o.pinned} activeCount=${o.activeCount} expected=${expected} got=${o.outcome}`,
      );
    }
  }
  return ok(id, "every resolver outcome matches the 1/0/2 + pinned branch");
}

// ---------------------------------------------------------------------------
// 8. monotonic best OTD (sample-backed)
// ---------------------------------------------------------------------------

/**
 * monotonic_best_otd. Per profile, sorted by t, bestOtd is non-increasing (a
 * search never gets a WORSE best deal over time). `detail` names the regression.
 */
export function assertMonotonicBestOtd(series: OtdSample[]): DeterministicResult {
  const id = "monotonic_best_otd";
  const byProfile = new Map<string, OtdSample[]>();
  for (const s of series) {
    const arr = byProfile.get(s.profileId) ?? [];
    arr.push(s);
    byProfile.set(s.profileId, arr);
  }
  for (const [profileId, samples] of byProfile) {
    const sorted = [...samples].sort((a, b) => a.t - b.t);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (cur.bestOtd > prev.bestOtd) {
        return fail(
          id,
          `profile ${profileId}: best OTD regressed from ${prev.bestOtd} (t=${prev.t}) to ${cur.bestOtd} (t=${cur.t})`,
        );
      }
    }
  }
  return ok(id, "best OTD is non-increasing over time for every profile");
}

// ---------------------------------------------------------------------------
// aggregator
// ---------------------------------------------------------------------------

/**
 * Run every applicable invariant: the DB ones ALWAYS; the trace/sample ones only
 * when their input array is provided. Returns the flat DeterministicResult[].
 */
export function runAllInvariants(inputs: MpInvariantInputs): DeterministicResult[] {
  const results: DeterministicResult[] = [
    assertDealershipExclusivity(inputs.db),
    assertNoCrossProfileBleed(inputs.db, inputs.profileIds),
    assertBudgetNeverLeaks(inputs.db, inputs.profileIds),
    assertHistoryIdNoSkip(inputs.db, inputs.profileIds),
    assertFollowupCap(inputs.db, inputs.profileIds, inputs.followupCeiling ?? 10),
  ];
  if (inputs.traces !== undefined) results.push(assertL2GateBeforeSend(inputs.traces));
  if (inputs.profileAsk !== undefined) results.push(assertProfileAskBranch(inputs.profileAsk));
  if (inputs.otdSeries !== undefined) results.push(assertMonotonicBestOtd(inputs.otdSeries));
  return results;
}

// ---------------------------------------------------------------------------
// result helpers (DeterministicResult requires expected + observed)
// ---------------------------------------------------------------------------

function ok(assertionId: string, observed: string): DeterministicResult {
  return { assertionId, ok: true, expected: "invariant holds", observed };
}

function fail(assertionId: string, detail: string): DeterministicResult {
  return { assertionId, ok: false, expected: "invariant holds", observed: "violated", detail };
}
