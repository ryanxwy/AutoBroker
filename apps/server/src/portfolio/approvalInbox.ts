/**
 * ApprovalInbox — the consolidated "needs you" queue across all concurrent
 * profiles. It AGGREGATES every parked gate (the 3 irreversible sends +
 * dealer_inbox_check + inventory_link_scan) and every saga retraction task into ONE
 * ranked queue keyed by (profileId, runId, decisionId), tagged by reason + the
 * budget-free BatchReviewCard summary, and ROUTES a single decision to the correct
 * (runId, decisionId) through the existing idempotent formDecision.
 *
 * IT AGGREGATES + ROUTES ONLY. There is deliberately NO method that approves many
 * destructive/irreversible items at once — each decision targets ONE (runId,
 * decisionId). "Skip all" is a per-item accept carrying content.skip_all routed to a
 * single run (the closeout descriptor's own sentinel), never a portfolio-wide
 * approve-all. The per-action L2 human-approval floor is unchanged and load-bearing.
 *
 * Idempotency is inherited from formDecision's three-phase claim: a double-tap of the
 * same (runId, decisionId, body) replays the stored ack and never fires a second
 * Mastra resume.
 */

import type { PendingGate } from "../skillRuns.js";
import type { RetractionTask } from "./sagaStack.js";

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

export type ApprovalItemKind = "gate" | "retraction";

export interface ApprovalSummary {
  heading: string;
  lines: Array<{ label: string; value: string }>;
}

export interface ApprovalItem {
  kind: ApprovalItemKind;
  profileId: string | null;
  /** The originating run; null only for a retraction task that has no run context. */
  runId: string | null;
  /** The decisionId to route a gate decision to; null for a retraction task (no
   *  live suspend to resume — the human acts out-of-band, then resolves it). */
  decisionId: string | null;
  skill: string;
  reason: string;
  /** Irreversible sends + retraction tasks are action-required (ranked first). */
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
  private readonly retractions: RetractionTask[] = [];

  constructor(private readonly runs: ApprovalRunService) {}

  /** Surface a committed-send retraction task (enqueued by the saga coordinator on
   *  abort). It appears in the queue as an action-required item with no decisionId. */
  enqueueRetraction(task: RetractionTask): void {
    this.retractions.push(task);
  }

  /** Resolve a retraction task once the human has acted (removes the FIRST matching
   *  task by runId + kind). Returns whether one was removed. */
  resolveRetraction(runId: string, kind: string): boolean {
    const idx = this.retractions.findIndex((t) => t.runId === runId && t.kind === kind);
    if (idx < 0) return false;
    this.retractions.splice(idx, 1);
    return true;
  }

  /** The whole queue: every parked gate + every retraction, ranked action-required
   *  first (a stable sort preserves insertion order within a rank tier). */
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
    const retractionItems: ApprovalItem[] = this.retractions.map((t) => ({
      kind: "retraction",
      profileId: t.profileId,
      runId: t.runId ?? null,
      decisionId: null,
      skill: t.kind,
      reason: "retraction_required",
      actionRequired: true,
      summary: t.summary,
    }));
    return [...gateItems, ...retractionItems].sort(
      (a, b) => Number(b.actionRequired) - Number(a.actionRequired),
    );
  }

  /** Route ONE decision to its (runId, decisionId) through the idempotent
   *  formDecision. accept / decline / cancel + optional content (e.g. approved ids,
   *  or content.skip_all for the closeout sentinel). NEVER approves multiple items. */
  async route(decision: {
    runId: string;
    decisionId: string;
    action: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    // Only attach `content` when present (exactOptionalPropertyTypes).
    const inner =
      decision.content === undefined
        ? { action: decision.action }
        : { action: decision.action, content: decision.content };
    return this.runs.formDecision(decision.runId, {
      decision_id: decision.decisionId,
      decision: inner,
    });
  }
}
