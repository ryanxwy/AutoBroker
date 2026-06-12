/**
 * The skill registry — the single cross-layer source of skill identity.
 *
 * One SkillDef per AutoBroker skill (17 total). The registry is pure data +
 * types: it imports no framework so both the server and the UI can consume it.
 * `workflowId` holds the STRING id of the matching workflow in
 * @autobroker/workflows (registeredWorkflows); it is null while a skill is still
 * planned. The skills layer and the workflows layer never import each other —
 * the matching string is the contract, asserted by a lint-gate test in the
 * server (which may import both).
 */

/** Build phase (1-5) in the one-skill-one-commit build order. */
export type SkillPhase = 1 | 2 | 3 | 4 | 5;

/** Risk class — drives gate posture and capability checks downstream. */
export type SkillRiskClass = "read_only" | "local_write" | "irreversible" | "destructive";

/** Implementation status. */
export type SkillStatus = "implemented" | "planned";

/** A single skill's identity + manifest record. Lean fields only. */
export interface SkillDef {
  /** Stable id, also the slash command without the leading slash. */
  id: string;
  /** The slash command, e.g. "/search_profile_intake". */
  slash: string;
  /** Human title. */
  title: string;
  /** One-line summary (also the API manifest summary). */
  summary: string;
  /** Build phase 1-5. */
  phase: SkillPhase;
  /** Risk class. */
  riskClass: SkillRiskClass;
  /** Implementation status. */
  status: SkillStatus;
  /** The matching @autobroker/workflows workflow id, or null while planned. */
  workflowId: string | null;
  /** Named inputs the skill accepts. */
  inputs: string[];
  /** The skill's output (single noun). */
  outputs: string;
}

/** The intake skill id (skill #1, e2e-first). */
export const INTAKE_SKILL_ID = "search_profile_intake" as const;

/** The dealer geosearch skill id (skill #2, first browser skill). */
export const GEOSEARCH_SKILL_ID = "dealer_geosearch" as const;

/** The inventory site scan skill id (skill #3, batch_review suspend). */
export const INVENTORY_SITE_SCAN_SKILL_ID = "inventory_site_scan" as const;

/** All 17 skills, in dependency × risk build order (phase 1 → 5). */
export const SKILLS: readonly SkillDef[] = [
  // ---- Phase 1 · deterministic core + intake (read-only trio + intake local_write root-dep) ----
  {
    id: INTAKE_SKILL_ID,
    slash: "/search_profile_intake",
    title: "Search profile intake",
    summary: "Create a new-car search profile from a slash form or freeform prose.",
    phase: 1,
    riskClass: "local_write",
    status: "implemented",
    workflowId: INTAKE_SKILL_ID,
    inputs: ["input_mode", "freeform_text", "seed_fields"],
    outputs: "search_profile",
  },
  {
    id: "quote_audit",
    slash: "/quote_audit",
    title: "Quote audit",
    summary: "Run the 10-check audit over a profile's recent dealer quotes and flag issues.",
    phase: 1,
    riskClass: "read_only",
    status: "planned",
    workflowId: null,
    inputs: ["profile_id", "quote_id"],
    outputs: "audit_summary",
  },
  {
    id: "quote_compare",
    slash: "/quote_compare",
    title: "Quote compare",
    summary: "Compare multiple dealer quotes side by side.",
    phase: 1,
    riskClass: "read_only",
    status: "planned",
    workflowId: null,
    inputs: ["quotes"],
    outputs: "comparison",
  },
  {
    id: "inventory_compare",
    slash: "/inventory_compare",
    title: "Inventory compare",
    summary: "Compare inventory listings against a search profile.",
    phase: 1,
    riskClass: "read_only",
    status: "planned",
    workflowId: null,
    inputs: ["listings", "profile_id"],
    outputs: "comparison",
  },

  // ---- Phase 2 · browser service + scans (browser read + local db.write) ----
  {
    id: GEOSEARCH_SKILL_ID,
    slash: "/dealer_geosearch",
    title: "Dealer geosearch",
    summary: "Find dealers near a profile's location via the browser service.",
    phase: 2,
    riskClass: "local_write",
    status: "implemented",
    workflowId: GEOSEARCH_SKILL_ID,
    inputs: ["search_profile_id"],
    outputs: "dealers",
  },
  {
    id: INVENTORY_SITE_SCAN_SKILL_ID,
    slash: "/inventory_site_scan",
    title: "Inventory site scan",
    summary: "Scan the profile's dealer sites for matching inventory (batch-reviewed).",
    phase: 2,
    riskClass: "local_write",
    status: "implemented",
    workflowId: INVENTORY_SITE_SCAN_SKILL_ID,
    inputs: ["search_profile_id", "dealer_ids", "approved_by", "max_targets"],
    outputs: "listings",
  },
  {
    id: "inventory_link_scan",
    slash: "/inventory_link_scan",
    title: "Inventory link scan",
    summary: "Visit unscraped dealer inventory URLs and match listings against the buyer profile.",
    phase: 2,
    riskClass: "local_write",
    status: "planned",
    workflowId: null,
    inputs: ["profile_id"],
    outputs: "listings",
  },
  {
    id: "incentive_scrape",
    slash: "/incentive_scrape",
    title: "Incentive scrape",
    summary: "Scrape current manufacturer/dealer incentives for a vehicle.",
    phase: 2,
    riskClass: "local_write",
    status: "planned",
    workflowId: null,
    inputs: ["make", "model", "region"],
    outputs: "incentives",
  },

  // ---- Phase 3 · email service + LLM extract (Gmail read + fake-mailbox/local db.write) ----
  {
    id: "dealer_inbox_check",
    slash: "/dealer_inbox_check",
    title: "Dealer inbox check",
    summary: "Read dealer replies from the mailbox and surface new messages.",
    phase: 3,
    riskClass: "local_write",
    status: "planned",
    workflowId: null,
    inputs: ["profile_id"],
    outputs: "messages",
  },
  {
    id: "dealer_reply_extract",
    slash: "/dealer_reply_extract",
    title: "Dealer reply extract",
    summary: "Extract a structured quote from a dealer's email reply (LLM).",
    phase: 3,
    riskClass: "local_write",
    status: "planned",
    workflowId: null,
    inputs: ["message_id"],
    outputs: "dealer_quote",
  },
  {
    id: "dealer_hygiene",
    slash: "/dealer_hygiene",
    title: "Dealer hygiene",
    summary: "Classify CRM threads, suppress noisy senders, and delete orphan thread records (three staged batch-review confirms).",
    phase: 3,
    riskClass: "destructive",
    status: "planned",
    workflowId: null,
    inputs: ["profile_id"],
    outputs: "hygiene_report",
  },

  // ---- Phase 4 · orchestration / report (compose + destructive-local) ----
  {
    id: "quote_pipeline",
    slash: "/quote_pipeline",
    title: "Quote pipeline",
    summary: "Orchestrate the post-reply quote chain (reply extract → incentive scrape → audit → compare) over existing DB state.",
    phase: 4,
    riskClass: "local_write",
    status: "planned",
    workflowId: null,
    inputs: ["profile_id"],
    outputs: "pipeline_report",
  },
  {
    id: "daily_digest",
    slash: "/daily_digest",
    title: "Daily digest",
    summary: "Build a daily digest of pipeline activity for a profile.",
    phase: 4,
    riskClass: "local_write",
    status: "planned",
    workflowId: null,
    inputs: ["profile_id"],
    outputs: "digest",
  },
  {
    id: "pipeline_reset",
    slash: "/pipeline_reset",
    title: "Pipeline reset",
    summary: "Wipe the whole local pipeline DB and recreate the schema (typed-YES second-confirm; default pre-reset dealer close-out pass).",
    phase: 4,
    riskClass: "destructive",
    status: "planned",
    workflowId: null,
    inputs: [],
    outputs: "reset_report",
  },

  // ---- Phase 5 · irreversible mutations (fake-send throughout) ----
  {
    id: "dealer_web_lead_submit",
    slash: "/dealer_web_lead_submit",
    title: "Dealer web lead submit",
    summary: "Submit a lead to a dealer's web form (fake-send; human approval).",
    phase: 5,
    riskClass: "irreversible",
    status: "planned",
    workflowId: null,
    inputs: ["dealer_id", "profile_id"],
    outputs: "lead_receipt",
  },
  {
    id: "negotiation_followup",
    slash: "/negotiation_followup",
    title: "Negotiation followup",
    summary: "Send a negotiation followup to a dealer (fake-send; human approval).",
    phase: 5,
    riskClass: "irreversible",
    status: "planned",
    workflowId: null,
    inputs: ["thread_id"],
    outputs: "followup_receipt",
  },
  {
    id: "dealer_closeout_email",
    slash: "/dealer_closeout_email",
    title: "Dealer closeout email",
    summary: "Send a closeout email to a dealer (fake-send; human approval).",
    phase: 5,
    riskClass: "irreversible",
    status: "planned",
    workflowId: null,
    inputs: ["thread_id"],
    outputs: "closeout_receipt",
  },
];

/** Look up a skill by id, or undefined. */
export function getSkill(id: string): SkillDef | undefined {
  return SKILLS.find((s) => s.id === id);
}

/** The implemented skills (status === "implemented"). */
export const IMPLEMENTED_SKILLS: readonly SkillDef[] = SKILLS.filter(
  (s) => s.status === "implemented",
);
