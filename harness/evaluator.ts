/**
 * evaluator — the deterministic 6+1 anchor checker and
 * the verdict.json assembler + four-tier judgement. The single most
 * reusable asset: ONE pure-ish evalAnchor(spec, detail, db, ctx) per the spec,
 * provider-neutral, scoring on observable behaviour only (terminal state,
 * profile-scoped DB delta, gate render, absence of forbidden mutations, ledger
 * usage) — NEVER a golden text (live-only, no fixtures, no replay).
 *
 * THE 6+1 ANCHORS (intake instance):
 *   run_status            terminalStatus ∈ expect (model-agnostic)
 *   driver_kind           detail.driverKind === expect ('deepseek_apikey')  (per-lane)
 *   browser_activity      sawBrowserActivity === true (N/A for intake — declared
 *                         per-case, not a default; goplaces is HTTP not a browser)
 *   approval_gate         sawApprovalGate / gate-before-prose (force-override only)
 *   table_min_rows        profile-scoped after-before delta vs the spec bound
 *   no_external_mutation  KEYSTONE, tolerance 0: DB scan + SSE event scan
 *   cost_and_time         usage present → ledger rows exist; NULL-not-$0 honored
 *   latency_budget        framework-new: every ledger row latencyMs <= maxMs;
 *                         NULL ignored; vacuous-pass on no row; waivable
 *   resolution            profile-resolution provenance on the terminal text
 *                         frame: pinned | inferred_newest (profile-scoped skills)
 *
 * N/A anchors: browser_activity + approval_gate are CASE-DECLARED for intake,
 * not in the default GREEN subset. A case that does not list them does not score
 * them (they are absent from the anchors array). The spec marks them "N/A" by
 * simply not declaring the anchor — there is no separate "skipped" verdict.
 *
 * COST/TIME source: the intake `done` frame carries NO usage; the SUT writes one
 * test_run_records row per harness.generate call (keyed by runId). So cost_and_time
 * reads the LEDGER ROWS for runId through the read-only DB channel (dbReads), not
 * the SSE stream. "usage present" == at least one ledger row exists for the run AND
 * none is the silent-$0 shape; NULL-not-$0 is satisfied when a row with
 * pricing_source='unavailable' carries cost_usd=NULL (the honest "no usage" record).
 *
 * Dependency wall: harness layer. Imports @autobroker/db (the Db TYPE + the
 * read-only helpers via dbReads) and @autobroker/core (HarnessDriverKind) — NEVER
 * better-sqlite3/drizzle-orm directly, NEVER a provider client.
 */

import type { Db } from "@autobroker/db";
import type { HarnessDriverKind } from "@autobroker/core";

import type { RunDetail } from "./detail.js";
import {
  countAuditRows,
  externalMutationDbCount,
  readLedgerRowsForRun,
  type TableCounts,
} from "./dbReads.js";

// ---------------------------------------------------------------------------
// anchor spec union (parsed from the case TOML)
// ---------------------------------------------------------------------------

export type AnchorSpec =
  | { kind: "run_status"; expect: string[] }
  | { kind: "driver_kind"; expect: HarnessDriverKind }
  | {
      /** Default ("present"): browser.* frames must have flowed. "absent"
       *  asserts ZERO browser activity (a batch decline must never navigate). */
      kind: "browser_activity";
      expect?: "present" | "absent";
    }
  | {
      /** Default ("present"): an approval/HITL gate must have rendered.
       *  "absent" asserts ZERO gate frames — the behavioral no-re-ask proof
       *  (e.g. a registry-remembered source must not re-fire the
       *  first-encounter approval on a second run). */
      kind: "approval_gate";
      expect?: "present" | "absent";
      gateBeforeProse?: boolean;
    }
  | {
      kind: "table_min_rows";
      table: string;
      scope: "profile" | "global";
      deltaMin?: number;
      min?: number;
      exact?: boolean;
      /** For audit_log delta: only count rows with this action. */
      action?: string;
    }
  | { kind: "no_external_mutation"; allowFakeOutbound?: boolean }
  | {
      kind: "cost_and_time";
      /** The step's happy path is ZERO-LLM by design (e.g. geosearch's
       *  evaluate-extract path): an empty ledger is then the valid "no model
       *  call happened" outcome, not RED. Rows that DO exist are still held to
       *  NULL-not-$0. */
      optional?: boolean;
    }
  | {
      /** Asserts the max per-call wall-clock latency: every test_run_records row
       *  for the run must have latencyMs <= maxMs. NULL latency is ignored (a
       *  usage-missing row legitimately carries no timing). With no ledger row
       *  the anchor PASSES vacuously (no model call happened) — pair with
       *  cost_and_time to require a call exist. Read-only; reuses
       *  readLedgerRowsForRun. Non-functional (waivable), never in NON_WAIVABLE. */
      kind: "latency_budget";
      maxMs: number;
    }
  | {
      /** Profile-resolution provenance: the run's terminal TEXT frame must
       *  carry payload.resolution === expect (pinned = explicit pin honored;
       *  inferred_newest = the logged single-active inference). Error-terminal
       *  runs never carry resolution (the 0/2+ STOPs throw before it exists) —
       *  STOP assertions use run_status + the stop ui_checks instead. */
      kind: "resolution";
      expect: "pinned" | "inferred_newest";
    }
  | {
      /** The per-site aggregator-scan contribution proof (F9/visor round): the
       *  run's terminal TEXT frame must carry payload.per_site (the workflow
       *  result's [{site_id, status, listing_count, error}] tally, copied through
       *  the same skill-agnostic text-frame channel `resolution` rides). PASS iff
       *  an entry for `site` exists with status="scanned" and
       *  listing_count >= minListings. Fail-closed: a missing per_site payload,
       *  a missing site entry, a non-"scanned" status, or a below-floor count all
       *  FAIL with a detail naming what was absent. */
      kind: "site_contribution";
      site: string;
      minListings: number;
    }
  | {
      /** A pure-DOM assertion against a widget by its stable data-testid. This
       *  anchor is NOT scored by evalAnchor — the evaluator has no live page.
       *  The UI-lane driver runs the assertion live and records a UiCheck the
       *  verdict carries through its ui_checks channel; the case grammar parses
       *  + validates the spec here only. */
      kind: "dom_state";
      testid: string;
      expect: "visible" | "absent" | "text" | "count" | "disabled";
      /** How the testid matches the DOM. "exact" (default) targets one specific
       *  widget; "prefix" targets a dynamic-id family (data-testid^=) — used to
       *  count or assert the absence of a row family like searches-row-<id>. */
      match?: "exact" | "prefix";
      /** expect="text": the substring the widget's text must carry. */
      value?: string;
      /** expect="count": how many matching widgets must be present. */
      count?: number;
    }
  | {
      /** The site_scan→aggregator AUTO-CHAIN proof (UI lane only). This anchor is
       *  NOT scored by evalAnchor — it is driven by the runner after the PARENT
       *  step (inventory_site_scan) reaches its terminal: the runner discovers the
       *  sibling aggregator run id off the parent stream's `chained_run` announce
       *  frame, waits for that sibling's own assistant turn to reach done (its own
       *  bounded budget), and asserts the sibling wrote ≥ deltaMin rows into the
       *  profile-scoped `table`. Each fact is recorded as a UiCheck the verdict
       *  carries through its ui_checks channel (a failing chain check → RED). */
      kind: "chained_run";
      /** The skill the auto-chain must start as a sibling top-level run
       *  (inventory_aggregator_scan). */
      skill: string;
      /** The sibling run's OWN wall-clock budget (seconds) to reach done — the
       *  aggregator browse+extract is a fresh long run, independent of the parent
       *  step's budget. */
      maxSeconds: number;
      /** The profile-scoped table the sibling aggregator run must grow (the
       *  aggregator's own writes prove the chain fired end-to-end). */
      table: string;
      /** The minimum profile-scoped delta the sibling must write to `table`. */
      deltaMin: number;
    };

export interface AnchorResult {
  kind: string;
  ok: boolean;
  expected: unknown;
  observed: unknown;
  detail?: string;
}

/** Evaluation context: the run's resolved profile id (null before persist), the
 *  before/after table-count snapshots, and the run window for time-bounded scans. */
export interface EvalContext {
  profileId: string | null;
  before: TableCounts;
  after: TableCounts;
  runWindow: { from: string; to: string };
  /** The keystone external-mutation DB scan total captured BEFORE the run (the
   *  pre-existing world's submitted leads / send-audit rows / real outbound
   *  messages). The no_external_mutation anchor subtracts it so the keystone
   *  measures the RUN's delta — a fixture that already carries a submitted lead
   *  (dealer_inbox_check's required discovery anchor) must not read as a fresh
   *  mutation. Omitted (undefined) → treated as 0 (the absolute-count behavior,
   *  unchanged for steps that never seed pre-existing mutation rows). */
  externalMutationBaseline?: number;
}

// ---------------------------------------------------------------------------
// the single anchor scorer — pure given (detail, db reads, ctx)
// ---------------------------------------------------------------------------

/**
 * Score ONE anchor. db is used READ-ONLY (the dbReads helpers guard that). The
 * function never writes, never calls a provider; it is deterministic given the
 * detail + the DB snapshot.
 */
export function evalAnchor(
  spec: AnchorSpec,
  detail: RunDetail,
  db: Db,
  ctx: EvalContext,
): AnchorResult {
  switch (spec.kind) {
    case "run_status": {
      const observed = detail.terminalStatus;
      const ok = observed !== null && spec.expect.includes(observed);
      return { kind: "run_status", ok, expected: spec.expect, observed };
    }

    case "driver_kind": {
      const observed = detail.driverKind;
      const ok = observed === spec.expect;
      return {
        kind: "driver_kind",
        ok,
        expected: spec.expect,
        observed,
        ...(ok ? {} : { detail: "init.payload.driver_kind mismatch (two-place lock-step §11)" }),
      };
    }

    case "browser_activity": {
      if (spec.expect === "absent") {
        const ok = detail.sawBrowserActivity === false;
        return {
          kind: "browser_activity",
          ok,
          expected: "absent (zero browser frames)",
          observed: detail.sawBrowserActivity,
          ...(ok ? {} : { detail: "browser activity flowed on a step that must never navigate" }),
        };
      }
      const ok = detail.sawBrowserActivity === true;
      return { kind: "browser_activity", ok, expected: true, observed: detail.sawBrowserActivity };
    }

    case "approval_gate": {
      // Default: a gate rendered at all. "absent" asserts the inverse (the
      // behavioral no-re-ask proof — mirrors browser_activity's absent arm).
      // When gateBeforeProse is requested, also require the gate frame to
      // PRECEDE the first prose text frame.
      const gateRendered = detail.sawApprovalGate === true;
      if (spec.expect === "absent") {
        const ok = !gateRendered;
        return {
          kind: "approval_gate",
          ok,
          expected: "absent (zero gate frames)",
          observed: gateRendered,
          ...(ok ? {} : { detail: "an approval gate rendered on a step that must never ask" }),
        };
      }
      if (spec.gateBeforeProse === true) {
        const ok = gateRendered && detail.gateBeforeProse;
        return {
          kind: "approval_gate",
          ok,
          expected: "gate frame before first prose text",
          observed: { sawApprovalGate: gateRendered, gateBeforeProse: detail.gateBeforeProse },
        };
      }
      return { kind: "approval_gate", ok: gateRendered, expected: true, observed: gateRendered };
    }

    case "table_min_rows": {
      return evalTableMinRows(spec, db, ctx);
    }

    case "no_external_mutation": {
      return evalNoExternalMutation(spec, detail, db, ctx.externalMutationBaseline ?? 0);
    }

    case "cost_and_time": {
      return evalCostAndTime(spec, detail, db);
    }

    case "resolution": {
      // The provenance rides the terminal text frame's payload (the SUT copies
      // the workflow output's resolution there); the LAST carrying frame wins.
      let observed: string | null = null;
      for (const ev of detail.events) {
        if (ev.kind !== "text") continue;
        const res = ev.payload["resolution"];
        if (typeof res === "string") observed = res;
      }
      const ok = observed === spec.expect;
      return {
        kind: "resolution",
        ok,
        expected: spec.expect,
        observed,
        ...(ok
          ? {}
          : {
              detail:
                observed === null
                  ? "no text frame carried a resolution payload (provenance not threaded?)"
                  : "resolution provenance mismatch",
            }),
      };
    }

    case "latency_budget": {
      return evalLatencyBudget(spec, detail, db);
    }

    case "site_contribution": {
      return evalSiteContribution(spec, detail);
    }

    case "dom_state": {
      // dom_state is evaluated DRIVER-SIDE, not here: evalAnchor sees only the
      // drained RunDetail + DB, never the live page. The UI-lane driver runs
      // the real assertion against its page and records a UiCheck that flows
      // into the verdict's ui_checks. This branch exists only to satisfy the
      // switch's exhaustiveness; it returns a no-op passthrough so a stray
      // call never silently scores false.
      return {
        kind: spec.kind,
        ok: true,
        expected: "(driver-recorded)",
        observed: "(see ui_checks)",
      };
    }

    case "chained_run": {
      // chained_run is driven+scored by the runner (it discovers the sibling run,
      // waits for its terminal, and reads the sibling's DB delta), then recorded
      // as UiChecks. evalAnchor sees no live page/sibling, so this is a no-op
      // passthrough mirroring dom_state — the real assertions live in ui_checks.
      return {
        kind: spec.kind,
        ok: true,
        expected: "(runner-recorded)",
        observed: "(see ui_checks)",
      };
    }

    default: {
      // Exhaustiveness — an unknown anchor kind is a contract breach, fail LOUD.
      const exhausted: never = spec;
      throw new Error(`evalAnchor: unknown anchor kind ${JSON.stringify(exhausted)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// table_min_rows (profile-scoped delta is the rule, global is fallback)
// ---------------------------------------------------------------------------

function evalTableMinRows(
  spec: Extract<AnchorSpec, { kind: "table_min_rows" }>,
  db: Db,
  ctx: EvalContext,
): AnchorResult {
  // audit_log with an action filter is computed live against the DB. Some audit
  // rows carry search_profile_id=NULL (account-level / pre-profile actions), so
  // such an action MUST be counted UNSCOPED. The intake-persist audit
  // ('search_profile_intake') IS profile-scoped. The case picks via `scope`:
  // scope="global" → unscoped action count; scope="profile" → search_profile_id-filtered.
  if (spec.table === "audit_log" && spec.action !== undefined) {
    const useProfile = spec.scope === "profile" && ctx.profileId !== null;
    const observed = countAuditRows(db, {
      action: spec.action,
      ...(useProfile ? { profileId: ctx.profileId } : {}),
    });
    const min = spec.deltaMin ?? spec.min ?? 1;
    const ok = spec.exact ? observed === min : observed >= min;
    return {
      kind: "table_min_rows",
      ok,
      expected: `${spec.exact ? "=" : ">="}${min} audit_log[action=${spec.action}]`,
      observed,
      detail: useProfile ? `profile-scoped (search_profile_id=${ctx.profileId})` : "unscoped action count (forced-audit row has null profile id)",
    };
  }

  const counts = spec.scope === "profile" ? { before: ctx.before.profile, after: ctx.after.profile } : { before: ctx.before.global, after: ctx.after.global };
  const before = counts.before[spec.table] ?? 0;
  const after = counts.after[spec.table] ?? 0;

  if (spec.scope === "global") {
    // Global form: count(table) >= min (fallback only). exact=true pins the
    // TOTAL count — the double-submit guard ("one profile row, not two") needs
    // it because a duplicate row carries a DIFFERENT profile id and would slip
    // past any profile-scoped delta.
    const min = spec.min ?? 1;
    const ok = spec.exact ? after === min : after >= min;
    return {
      kind: "table_min_rows",
      ok,
      expected: spec.exact ? `global count = ${min}` : `global count >= ${min}`,
      observed: after,
      detail: `table=${spec.table} (global fallback — profile scope preferred, §R5)`,
    };
  }

  // Profile-scoped delta vs the before snapshot.
  const delta = after - before;
  const bound = spec.deltaMin ?? 1;
  const ok = spec.exact ? delta === bound : delta >= bound;
  return {
    kind: "table_min_rows",
    ok,
    expected: `${spec.exact ? "delta =" : "delta >="} ${bound} (profile, ${spec.table})`,
    observed: delta,
    detail: `before=${before} after=${after} profileId=${ctx.profileId ?? "∅"}`,
  };
}

// ---------------------------------------------------------------------------
// no_external_mutation KEYSTONE — DB scan + SSE event scan, tolerance 0
// ---------------------------------------------------------------------------

/** A real Gmail-send tool event on the wire (may not write an audit row). Trust
 *  the structured kind/name, never a prose regex. fake/sandbox sends are allowed
 *  only when the step explicitly opted into allowFakeOutbound (intake NEVER does). */
function realOutboundEventCount(detail: RunDetail, allowFakeOutbound: boolean): number {
  let n = 0;
  for (const ev of detail.events) {
    if (ev.kind !== "tool_call") continue;
    const name = String(ev.payload["name"] ?? ev.payload["tool"] ?? "");
    const isSend = /gmail[._]?send|dealer[._]?form[._]?submit|lead[._]?submit|browser[._]?submit/i.test(name);
    if (!isSend) continue;
    const fake = ev.payload["fake"] === true || /fake|sandbox/i.test(String(ev.payload["mode"] ?? ""));
    if (fake && allowFakeOutbound) continue;
    n += 1;
  }
  return n;
}

function evalNoExternalMutation(
  spec: Extract<AnchorSpec, { kind: "no_external_mutation" }>,
  detail: RunDetail,
  db: Db,
  baseline: number,
): AnchorResult {
  const allowFake = spec.allowFakeOutbound === true;
  // The DB scan honors allowFakeOutbound too: under the harness lane (AUTOBROKER_MODE=test)
  // the fake-submit lead_submissions row is a LOCAL record, not a real POST, so
  // it must not register as a mutation when the step opted in (invariant #1).
  // Real-escape signals (send/submit audit actions, non-sandbox outbound
  // messages) are NEVER relaxed by the flag.
  const dbScan = externalMutationDbCount(db, { allowFakeOutbound: allowFake });
  const eventCount = realOutboundEventCount(detail, allowFake);
  // Subtract the pre-run baseline of the DB scan: the keystone measures the
  // RUN's delta, not pre-existing fixture world state (a seeded submitted lead
  // is the inbox sweep's required anchor, never a fresh mutation). The event
  // scan is already run-scoped (detail.events), so it is not baselined. A
  // negative delta (a row deleted) clamps to 0 — only NEW mutations matter.
  // Safe to clamp: the keystone tables (lead_submissions, audit_log, messages)
  // are insert-only in product code, and the audit + non-baselined event legs
  // are redundant, so the clamp cannot mask a delete-then-send net-zero.
  const dbDelta = Math.max(0, dbScan.total - baseline);
  const total = dbDelta + eventCount;
  const ok = total === 0;
  return {
    kind: "no_external_mutation",
    ok,
    expected: 0,
    observed: total,
    detail: ok
      ? "keystone clean (db delta + events, tolerance 0)"
      : `KEYSTONE VIOLATION: db=${JSON.stringify(dbScan.breakdown)} dbBaseline=${baseline} dbDelta=${dbDelta} events=${eventCount}`,
  };
}

// ---------------------------------------------------------------------------
// cost_and_time — ledger rows for runId; NULL-not-$0 honored
// ---------------------------------------------------------------------------

function evalCostAndTime(
  spec: Extract<AnchorSpec, { kind: "cost_and_time" }>,
  detail: RunDetail,
  db: Db,
): AnchorResult {
  const rows = readLedgerRowsForRun(db, detail.runId);
  if (rows.length === 0) {
    // optional=true: the case declared a zero-LLM happy path — an empty ledger
    // is the honest "no model call happened" record, not a missing-usage RED.
    if (spec.optional === true) {
      return {
        kind: "cost_and_time",
        ok: true,
        expected: "ledger rows optional (zero-LLM happy path declared)",
        observed: 0,
        detail: "no model call happened (no ledger row; valid for this step)",
      };
    }
    return {
      kind: "cost_and_time",
      ok: false,
      expected: ">=1 test_run_records row for the run",
      observed: 0,
      detail: "no ledger row written for this run (usage never recorded)",
    };
  }

  // NULL-not-$0 invariant: a row may legitimately carry cost_usd=NULL when
  // pricing_source='unavailable' (the honest "no usage" record). The FORBIDDEN
  // shape is cost_usd=0 WITH pricing_source='unavailable' (the silent-$0 fake) —
  // the SUT writer already rejects it, but the anchor asserts none slipped in.
  const silentZero = rows.find((r) => r.costUsd === 0 && r.pricingSource === "unavailable");
  if (silentZero !== undefined) {
    return {
      kind: "cost_and_time",
      ok: false,
      expected: "NULL-not-$0 (cost NULL when usage unavailable)",
      observed: "cost_usd=0 with pricing_source=unavailable",
      detail: "silent-$0 row present (R3)",
    };
  }

  // Every row records a wall-clock latency (durationMs) regardless of usage; cost
  // is computed when usage exists, else NULL. The anchor passes when ledger rows
  // exist and none is the silent-$0 shape — usage-missing rows are valid
  // (pricing_source='unavailable' + cost NULL + a fail/flag reason).
  const computed = rows.filter((r) => r.pricingSource !== "unavailable").length;
  const unavailable = rows.length - computed;
  return {
    kind: "cost_and_time",
    ok: true,
    expected: ">=1 ledger row, NULL-not-$0",
    observed: { rows: rows.length, computed, unavailable },
    detail: `pricing: ${computed} computed / ${unavailable} unavailable (NULL-not-$0)`,
  };
}

// ---------------------------------------------------------------------------
// latency_budget (framework-new) — asserts a max per-call wall-clock latency.
// Latency is captured on every ledger row (dbReads latencyMs) but no other
// anchor reads it; this is the first assertion over it. Vacuously passes with
// no ledger row (no call). NULL latency rows are ignored.
// ---------------------------------------------------------------------------

function evalLatencyBudget(
  spec: Extract<AnchorSpec, { kind: "latency_budget" }>,
  detail: RunDetail,
  db: Db,
): AnchorResult {
  const rows = readLedgerRowsForRun(db, detail.runId);
  const timed = rows.filter((r) => r.latencyMs !== null);
  const breaches = timed.filter((r) => (r.latencyMs as number) > spec.maxMs);
  const ok = breaches.length === 0;
  return {
    kind: "latency_budget",
    ok,
    expected: `every call latencyMs <= ${spec.maxMs}ms`,
    observed: timed.map((r) => r.latencyMs),
    ...(ok
      ? {}
      : {
          detail: `${breaches.length} call(s) over budget (max=${Math.max(
            ...timed.map((r) => r.latencyMs as number),
          )}ms)`,
        }),
  };
}

// ---------------------------------------------------------------------------
// site_contribution — per-site aggregator-scan tally, read off the SAME
// terminal-text-frame channel the resolution anchor uses (skillRuns.ts copies
// r.result.per_site onto the text frame's payload alongside resolution). No DB
// read: the frame IS the run's result, so this never re-derives from SQLite.
// ---------------------------------------------------------------------------

interface PerSiteEntry {
  site_id: string;
  status: string;
  listing_count: number;
  error: string | null;
}

/** The LAST text frame carrying a per_site array wins (mirrors resolutionOf's
 *  last-carrying-frame rule). null when no frame ever carried one. */
function perSiteOf(detail: RunDetail): PerSiteEntry[] | null {
  let observed: PerSiteEntry[] | null = null;
  for (const ev of detail.events) {
    if (ev.kind !== "text") continue;
    const ps = ev.payload["per_site"];
    if (Array.isArray(ps)) observed = ps as PerSiteEntry[];
  }
  return observed;
}

function evalSiteContribution(
  spec: Extract<AnchorSpec, { kind: "site_contribution" }>,
  detail: RunDetail,
): AnchorResult {
  const perSite = perSiteOf(detail);
  if (perSite === null) {
    return {
      kind: "site_contribution",
      ok: false,
      expected: `per_site entry for site="${spec.site}"`,
      observed: null,
      detail: "no text frame carried a per_site payload (per-site provenance not threaded?)",
    };
  }
  const entry = perSite.find((e) => e.site_id === spec.site);
  if (entry === undefined) {
    return {
      kind: "site_contribution",
      ok: false,
      expected: `per_site entry for site="${spec.site}"`,
      observed: perSite.map((e) => e.site_id),
      detail: `site "${spec.site}" absent from per_site`,
    };
  }
  if (entry.status !== "scanned") {
    return {
      kind: "site_contribution",
      ok: false,
      expected: "status=scanned",
      observed: entry,
      detail: `site "${spec.site}" status="${entry.status}" (want scanned)`,
    };
  }
  if (typeof entry.listing_count !== "number") {
    return {
      kind: "site_contribution",
      ok: false,
      expected: `listing_count is a number (>= ${spec.minListings})`,
      observed: entry,
      detail: `site "${spec.site}" listing_count is malformed (${JSON.stringify(entry.listing_count)}, typeof ${typeof entry.listing_count}) — expected a number`,
    };
  }
  if (entry.listing_count < spec.minListings) {
    return {
      kind: "site_contribution",
      ok: false,
      expected: `listing_count >= ${spec.minListings}`,
      observed: entry,
      detail: `site "${spec.site}" listing_count=${entry.listing_count} < min_listings=${spec.minListings}`,
    };
  }
  return {
    kind: "site_contribution",
    ok: true,
    expected: `site="${spec.site}" status=scanned listing_count>=${spec.minListings}`,
    observed: entry,
  };
}

// ---------------------------------------------------------------------------
// four-tier verdict + S1/S2/S3 cross-check + verdict.json assembly
// ---------------------------------------------------------------------------

export type Verdict = "GREEN" | "GREEN_WITH_WAIVER" | "RED" | "BLOCKER";
export type Confidence = "high" | "medium" | "low";

/** The S1/S2/S3 cross-check the self-contained runner encodes automatically. */
export interface CrossCheck {
  s1: string; // Driver-observed: SSE terminal text.
  s2: string; // Monitor-observed, refresh-confirmed: re-pulled read API.
  s3: string; // Backend ground truth: read-only SQLite (profile-scoped).
  confidence: Confidence;
}

export interface UiCheck {
  surface: string;
  selector: string;
  expected: string;
  observed: string;
  ok: boolean;
}

export interface VerdictDoc {
  schema_version: 1;
  cell_id: string;
  /** The case TOML [meta].id — distinguishes cases that share one cell_id
   *  (e.g. decline vs slash both run skill/provider/B). */
  case_id: string;
  layer: string;
  /** The user-action driver lane: "ui" = real dashboard DOM via Playwright;
   *  "api" = direct HTTP (the default — older verdicts without the key are
   *  api-lane). Additive field. */
  lane: "ui" | "api";
  run_id: string;
  verdict: Verdict;
  status: "PASS" | "FAIL";
  anchors: AnchorResult[];
  ui_checks: UiCheck[];
  cross_check: CrossCheck;
  waived_anchor: { kind: string; reason: string } | null;
  defect_flag: { kind: string; detail: string } | null;
}

export interface BuildVerdictInput {
  cellId: string;
  /** The case TOML [meta].id (see VerdictDoc.case_id). */
  caseId: string;
  layer: string;
  /** The driver lane (see VerdictDoc.lane). Omitted = "api". */
  lane?: "ui" | "api";
  runId: string;
  anchors: AnchorResult[];
  uiChecks?: UiCheck[];
  crossCheck: CrossCheck;
  /** A real-world unreachable reason that downgrades a failed NON-functional
   *  anchor to GREEN_WITH_WAIVER (the functional anchors must still PASS). */
  waiver?: { kind: string; reason: string } | null;
  /** A baseline regression / frozen-invariant violation forces BLOCKER. */
  regression?: { kind: string; detail: string } | null;
}

/** The functional anchors that may NEVER be waived (a failure here is RED/BLOCKER,
 *  not a waiver). The keystone + the core effect anchors. */
const NON_WAIVABLE = new Set(["no_external_mutation", "run_status", "table_min_rows"]);

/**
 * Assemble the verdict.json doc + the four-tier judgement:
 *   - BLOCKER: a regression / frozen-invariant violation, OR a keystone failure.
 *   - GREEN: all anchors ok + all ui_checks ok + confidence ∈ {high, medium}.
 *   - GREEN_WITH_WAIVER: the only failing anchors are waivable AND a real-world
 *     waiver reason is recorded; the functional anchors still PASS.
 *   - RED: a real anchor/ui failure, or confidence=low (S1/S2/S3 contradiction).
 */
export function buildVerdict(input: BuildVerdictInput): VerdictDoc {
  const uiChecks = input.uiChecks ?? [];
  const failedAnchors = input.anchors.filter((a) => !a.ok);
  const failedUi = uiChecks.filter((u) => !u.ok);
  const keystoneFailed = failedAnchors.some((a) => a.kind === "no_external_mutation");

  let verdict: Verdict;
  let waived: { kind: string; reason: string } | null = null;
  let defect: { kind: string; detail: string } | null = null;

  // Frozen-invariant violation / keystone failure / explicit regression → BLOCKER.
  if (input.regression != null) {
    verdict = "BLOCKER";
    defect = input.regression;
  } else if (keystoneFailed) {
    verdict = "BLOCKER";
    const k = failedAnchors.find((a) => a.kind === "no_external_mutation")!;
    defect = { kind: "no_external_mutation", detail: k.detail ?? "keystone violated" };
  } else if (input.crossCheck.confidence === "low") {
    // Contradictory S1/S2/S3 = RED, never a pass.
    verdict = "RED";
    defect = { kind: "cross_check", detail: "S1/S2/S3 contradiction (confidence=low)" };
  } else if (failedAnchors.length === 0 && failedUi.length === 0) {
    // Vacuous-confirmation guard: a live layer (L2+) with ZERO recorded
    // ui_checks cannot be GREEN — the S1/S2 cross-check must be materialized
    // as at least one ui_checks entry (self-contained L2 mode, STANDARD §5).
    const liveLayer = /^L[2-5]$/.test(input.layer);
    if (liveLayer && uiChecks.length === 0) {
      verdict = "RED";
      defect = {
        kind: "ui_checks",
        detail: "no ui_checks recorded at a live layer (vacuous-confirmation guard)",
      };
    } else {
      verdict = "GREEN";
    }
  } else {
    // Some anchor/ui failed. Eligible for waiver only if EVERY failed anchor is
    // waivable AND a waiver reason was supplied (a real-world unreachable bit).
    // ONE targeted exception: a table_min_rows failure may be waived when the
    // waiver EXPLICITLY names kind "table_min_rows" (the empty-real-world-result
    // case, e.g. Maps yields zero dealers in radius — browser activity proven,
    // nothing to write). A generic waiver still cannot cover it, and the
    // keystone/run_status anchors stay absolutely non-waivable.
    const allWaivable = failedAnchors.every(
      (a) =>
        !NON_WAIVABLE.has(a.kind) ||
        (a.kind === "table_min_rows" && input.waiver?.kind === "table_min_rows"),
    );
    if (input.waiver != null && allWaivable && failedUi.length === 0) {
      verdict = "GREEN_WITH_WAIVER";
      waived = input.waiver;
    } else {
      verdict = "RED";
      const first = failedAnchors[0] ?? failedUi[0];
      defect = {
        kind: first && "kind" in first ? (first as AnchorResult).kind : "ui_check",
        detail: failedAnchors.map((a) => `${a.kind}:${a.detail ?? "fail"}`).join("; ") || "ui_check failed",
      };
    }
  }

  const status: "PASS" | "FAIL" =
    failedAnchors.length === 0 && failedUi.length === 0 ? "PASS" : "FAIL";

  return {
    schema_version: 1,
    cell_id: input.cellId,
    case_id: input.caseId,
    layer: input.layer,
    lane: input.lane ?? "api",
    run_id: input.runId,
    verdict,
    status,
    anchors: input.anchors,
    ui_checks: uiChecks,
    cross_check: input.crossCheck,
    waived_anchor: waived,
    defect_flag: defect,
  };
}

/** Compute the S1/S2/S3 confidence from agreement: all agree → high; one
 *  unavailable/ambiguous but the rest agree → medium; any contradiction → low. */
export function computeConfidence(signals: { s1Ok: boolean; s2Ok: boolean; s3Ok: boolean; s2Available?: boolean }): Confidence {
  const s2Available = signals.s2Available ?? true;
  if (!s2Available) {
    // S2 (UI re-pull) unavailable: high only if S1 and S3 both agree positively.
    return signals.s1Ok && signals.s3Ok ? "medium" : "low";
  }
  const all = [signals.s1Ok, signals.s2Ok, signals.s3Ok];
  if (all.every((x) => x)) return "high";
  if (all.every((x) => !x)) return "low"; // unanimous fail → low (a coherent RED).
  // Mixed = contradiction.
  return "low";
}
