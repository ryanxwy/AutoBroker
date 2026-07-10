/**
 * ApprovalInbox — the consolidated "needs you" queue across all concurrent
 * profiles. It AGGREGATES every parked gate (the 3 irreversible sends +
 * dealer_inbox_check + inventory_link_scan) into ONE ranked queue keyed by
 * (profileId, runId, decisionId), tagged by reason + the budget-free
 * BatchReviewCard summary.
 *
 * IT AGGREGATES ONLY. There is deliberately NO method that approves many
 * destructive/irreversible items at once — each decision still goes one at a time
 * through POST /api/skill-runs/:id/form-decision (the idempotent three-phase
 * claim). The per-action L2 human-approval floor is unchanged and load-bearing.
 */

import type { PendingGate } from "../skillRuns.js";

/** The structural subset of SkillRunService the inbox depends on (so a test can
 *  inject a fake / a composite lister). */
export interface ApprovalRunService {
  listPendingGates(): PendingGate[];
  formDecision(
    runId: string,
    body: {
      decision_id: string;
      decision: { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };
    },
  ): Promise<Record<string, unknown>>;
}

export type ApprovalItemKind = "gate";

export interface ApprovalSummary {
  heading: string;
  lines: Array<{ label: string; value: string }>;
}

export interface ApprovalItem {
  kind: ApprovalItemKind;
  profileId: string | null;
  /** The originating run. */
  runId: string;
  /** The decisionId to route a gate decision to. */
  decisionId: string;
  skill: string;
  reason: string;
  /** Irreversible sends are action-required (ranked first). */
  actionRequired: boolean;
  summary?: ApprovalSummary;
}

/** The 3 irreversible send skills — their gates are always action-required. The two
 *  read gates (inbox_check / link_scan) are reviewable but not destructive. */
const IRREVERSIBLE_SEND_SKILLS = new Set([
  "dealer_web_lead_submit",
  "negotiation_followup",
  "dealer_closeout_email",
]);

function reasonFor(skill: string, payloadKind: unknown): string {
  const isApproval = payloadKind === "approval"; // the sends' sensitive ② re-confirm
  switch (skill) {
    case "dealer_web_lead_submit":
      return isApproval ? "email_fallback" : "lead_submit";
    case "negotiation_followup":
      return isApproval ? "contact_flip" : "negotiation";
    case "dealer_closeout_email":
      return "closeout";
    case "dealer_inbox_check":
      return "inbox_review";
    case "inventory_link_scan":
      return "link_scan";
    default:
      return skill;
  }
}

/** Pull the budget-free summary block off a suspend payload when present (only the
 *  lead-submit batch card attaches one today). Shape-checked; budget is never in it
 *  by construction at the emitter (#9) — the inbox adds nothing. */
function summaryOf(payload: Record<string, unknown>): ApprovalSummary | undefined {
  const s = payload["summary"];
  if (s === null || typeof s !== "object") return undefined;
  const heading = (s as { heading?: unknown }).heading;
  const lines = (s as { lines?: unknown }).lines;
  if (typeof heading !== "string" || !Array.isArray(lines)) return undefined;
  const shaped = lines
    .filter((l): l is { label: string; value: string } => {
      return (
        l !== null &&
        typeof l === "object" &&
        typeof (l as { label?: unknown }).label === "string" &&
        typeof (l as { value?: unknown }).value === "string"
      );
    })
    .map((l) => ({ label: l.label, value: l.value }));
  return { heading, lines: shaped };
}

export class ApprovalInbox {
  constructor(private readonly runs: ApprovalRunService) {}

  /** The whole queue: every parked gate, ranked action-required first (a stable
   *  sort preserves insertion order within a rank tier). */
  list(): ApprovalItem[] {
    const gateItems: ApprovalItem[] = this.runs.listPendingGates().map((g: PendingGate) => {
      const base: ApprovalItem = {
        kind: "gate",
        profileId: g.profileId,
        runId: g.runId,
        decisionId: g.decisionId,
        skill: g.skill,
        reason: reasonFor(g.skill, g.payload["kind"]),
        actionRequired: IRREVERSIBLE_SEND_SKILLS.has(g.skill),
      };
      const summary = summaryOf(g.payload);
      return summary === undefined ? base : { ...base, summary };
    });
    return gateItems.sort((a, b) => Number(b.actionRequired) - Number(a.actionRequired));
  }
}
