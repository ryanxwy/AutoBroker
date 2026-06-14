/**
 * hygieneStage — the defensive spec_inline parser + the per-stage copy for the
 * dealer_hygiene batch_review suspends. Kept out of the .tsx so the future banner
 * host can disambiguate a hygiene batch_review (presence of a `stage` member)
 * from the scan batch_review without importing the React component.
 */

export const HYGIENE_STAGES = ["orphans", "crm_threads", "crm_contacts"] as const;
export type HygieneStage = (typeof HYGIENE_STAGES)[number];

/** Human-readable per-stage heading copy. */
export const HYGIENE_STAGE_HEADINGS: Record<HygieneStage, string> = {
  orphans: "Stale, empty thread records — no messages, no real provenance.",
  crm_threads: "Inbound CRM follow-up threads with no quote.",
  crm_contacts: "Auto-sender (lead platform) contacts that own no quote.",
};

/** The parsed suspend spec_inline this card renders. */
export interface HygieneStageSpec {
  stage: HygieneStage;
  question: string;
  targets: Array<{ id: string; name: string; reason: string }>;
  total: number;
}

function isHygieneStage(v: unknown): v is HygieneStage {
  return typeof v === "string" && (HYGIENE_STAGES as readonly string[]).includes(v);
}

/**
 * Defensively read a hygiene batch_review spec_inline off the wire. Returns null
 * on a malformed payload (or a non-hygiene batch_review with no `stage`) — the
 * banner host then falls back to its never-hidden pending placeholder (a gate is
 * never silently hidden, never mis-rendered).
 */
export function readHygieneStageSpec(spec: Record<string, unknown>): HygieneStageSpec | null {
  if (spec["kind"] !== "batch_review") return null;
  if (!isHygieneStage(spec["stage"])) return null;
  const targetsRaw = spec["targets"];
  if (!Array.isArray(targetsRaw)) return null;
  const targets: HygieneStageSpec["targets"] = [];
  for (const t of targetsRaw) {
    const row = t as { id?: unknown; name?: unknown; reason?: unknown };
    if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.reason !== "string") {
      return null;
    }
    targets.push({ id: row.id, name: row.name, reason: row.reason });
  }
  const total = spec["total"];
  if (typeof total !== "number") return null;
  return {
    stage: spec["stage"],
    question: typeof spec["question"] === "string" ? spec["question"] : "Review these cleanup items.",
    targets,
    total,
  };
}
