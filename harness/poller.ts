/**
 * poller — the background "answer the gate for the human" component (HARNESS_FRAMEWORK
 * §9). It implements the committed Approver interface (packages/tools gate/index.ts:
 * "in the live harness it is the deny_all poller") so the L2 in-process gate — which
 * is ALREADY implemented and fail-CLOSED — has an approver to consult on a mutating
 * action. This module ONLY supplies the Approver impls + the background poll loop;
 * it does not change the gate boundary.
 *
 * TWO POLICIES (§9.2):
 *   deny_all     — unconditionally declines EVERY gate. The ONLY policy for the 3
 *                  irreversible skills + destructive skills. AIRTIGHT (no fail-open).
 *                  Scaffolded HERE for those later skills even though intake never
 *                  uses it.
 *   approve_safe — fail-OPEN denylist for READ-ONLY clusters only (intake, risk
 *                  group E). A recognized mutation/arbitrary-code marker → DENY; an
 *                  unrecognized gate → allow-once. The denylist is defense-in-depth,
 *                  NEVER a proof — it must never point at a mutation-capable skill
 *                  (legacy gate_poller.py docstring).
 *
 * INTAKE REALITY (api_finding): intake is read-only and emits NO awaiting_permission
 * frame and the M1 SUT exposes NO /approvals route (only /form-decision). So for an
 * intake run the background poll loop has nothing to answer — it is a standby that
 * exits at the terminal frame. The force-override / decline paths are driven by the
 * case resume[] script through /form-decision (NOT the Approver) — the spec is
 * explicit: "poller 只处理 mutation gate,而 intake 的 force-override/decline 是
 * form-decision 应答,不经 Approver." The Approver impls land now so the later
 * mutation-capable skills (deny_all) plug straight in.
 *
 * Dependency wall: harness layer. Imports the Approver/GateRequest TYPES from
 * @autobroker/tools (type-only) — NEVER better-sqlite3/drizzle/playwright/@ai-sdk.
 */

import type { Approver, GateRequest } from "@autobroker/tools";

export type GatePolicy = "deny_all" | "approve_safe";

/** deny_all — unconditionally decline. The deny path IS the test (§9.4). Airtight:
 *  there is no branch that can return true. */
export const denyAll: Approver = {
  async decide(_req: GateRequest): Promise<boolean> {
    return false;
  },
};

/**
 * Markers a recognized MUTATION gate carries — these always DENY under approve_safe
 * (defense-in-depth). Matched against the structured GateRequest.kind + summary; we
 * never regex a function name out of free-text to EXECUTE it (invariant #4) — we only
 * use markers to DENY (the safe direction).
 */
const MUTATION_MARKERS = ["gmail_send", "dealer_form_submit", "lead_submit", "browser.submit", "typed_yes_confirm"];

/** Markers of an arbitrary-code escape (also always DENY). */
const ARBITRARY_CODE_MARKERS = ["python3 -c", "bash -c", "sh -c", "node -e", "eval("];

function matchesMarker(req: GateRequest, marker: string): boolean {
  if (req.kind === marker) return true;
  const hay = `${req.kind} ${req.summary} ${JSON.stringify(req.payload)}`.toLowerCase();
  return hay.includes(marker.toLowerCase());
}

/**
 * approve_safe — fail-OPEN denylist for READ-ONLY clusters (intake). A recognized
 * mutation/arbitrary-code marker → DENY; otherwise allow-once. NEVER use this for a
 * mutation-capable skill — the L1 BLOCK fuse + the in-process gate are the real
 * floor; this is only a convenience approver for the safe cluster.
 */
export function approveSafe(): Approver {
  return {
    async decide(req: GateRequest): Promise<boolean> {
      if (MUTATION_MARKERS.some((m) => matchesMarker(req, m))) return false;
      if (ARBITRARY_CODE_MARKERS.some((m) => matchesMarker(req, m))) return false;
      return true; // unrecognized → allow-once (fail-OPEN, read-only cluster only).
    },
  };
}

/** Resolve a policy name to its Approver impl (fail-loud on an unknown policy). */
export function approverFor(policy: GatePolicy): Approver {
  switch (policy) {
    case "deny_all":
      return denyAll;
    case "approve_safe":
      return approveSafe();
    default: {
      const exhausted: never = policy;
      throw new Error(`approverFor: unknown gate policy ${String(exhausted)}`);
    }
  }
}

/** A running poller's handle: stop() detaches the loop. */
export interface PollerHandle {
  stop(): void;
  /** Resolves when the poller has observed the run's terminal frame (or stop()). */
  done: Promise<void>;
}

/**
 * Start the background gate poller for a run. It subscribes to the run's status and
 * answers each pending approval through the SUT's approval surface, then exits at
 * the terminal frame. For an intake run this is a STANDBY: the run never emits an
 * approval gate and the SUT has no /approvals route, so the loop simply waits for
 * the terminal status and resolves. The Approver is still constructed (the policy
 * is wired) so a mutation-capable skill that DOES emit a gate plugs straight in.
 *
 * @param apiBase  the SUT base URL.
 * @param runId    the run to watch.
 * @param policy   deny_all | approve_safe (intake = approve_safe).
 * @param opts     pollIntervalMs (default 200), fetchImpl, maxMs (safety bound).
 */
export function startPoller(
  apiBase: string,
  runId: string,
  policy: GatePolicy,
  opts: { pollIntervalMs?: number; fetchImpl?: typeof fetch; maxMs?: number } = {},
): PollerHandle {
  const approver = approverFor(policy); // constructed even when intake never calls it.
  const fetchImpl = opts.fetchImpl ?? fetch;
  const interval = opts.pollIntervalMs ?? 200;
  const maxMs = opts.maxMs ?? 15 * 60 * 1000;
  const base = apiBase.replace(/\/$/, "");
  const statusUrl = `${base}/api/skill-runs/${encodeURIComponent(runId)}`;
  const approvalsUrl = `${base}/api/skill-runs/${encodeURIComponent(runId)}/approvals`;

  const TERMINAL = new Set(["done", "error", "declined", "aborted"]);
  let stopped = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  // Track decision_ids we have already answered so we never double-answer a gate.
  const answered = new Set<string>();
  const startedAt = Date.now();

  const loop = async (): Promise<void> => {
    while (!stopped) {
      if (Date.now() - startedAt > maxMs) break; // safety bound.
      let status: string | null = null;
      let pending: { kind?: string; decision_id?: string } | null = null;
      try {
        const res = await fetchImpl(statusUrl, { method: "GET" });
        if (res.ok) {
          const body = (await res.json()) as { status?: string; pending?: { kind?: string; decision_id?: string } | null };
          status = body.status ?? null;
          pending = body.pending ?? null;
        }
      } catch {
        // Transient read error — retry next tick (the run keeps going server-side).
      }

      // Answer an APPROVAL gate (mutation skills). intake never reaches this branch
      // (its suspends are data_collection/force_override forms, not approval gates,
      // and they resume via /form-decision driven by the case resume[] script).
      if (
        pending !== null &&
        pending.decision_id !== undefined &&
        (pending.kind === "approval_required" || pending.kind === "awaiting_permission") &&
        !answered.has(pending.decision_id)
      ) {
        answered.add(pending.decision_id);
        const req: GateRequest = {
          kind: "gmail_send", // the SUT carries the real kind; this is the worst-case default for the safe approver.
          runId,
          summary: `gate for run ${runId}`,
          payload: { decision_id: pending.decision_id, source: "poller" },
        };
        const approve = await approver.decide(req).catch(() => false); // fail-closed.
        try {
          await fetchImpl(approvalsUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision_id: pending.decision_id, approve }),
          });
        } catch {
          // The approval surface may not exist for read-only skills (intake) — that
          // is fine; nothing to approve. Mutation skills register it.
        }
      }

      if (status !== null && TERMINAL.has(status)) break;
      await sleep(interval);
    }
    resolveDone();
  };

  void loop();

  return {
    stop(): void {
      stopped = true;
      resolveDone();
    },
    done,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
