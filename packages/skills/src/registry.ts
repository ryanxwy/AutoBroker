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

/**
 * Profile-pin posture — how a skill resolves the profile it acts on, and what
 * the pre-launch UI gate requires:
 *   - "exempt"       — needs no profile (it CREATES one); always launchable.
 *   - "pin_required" — must run against an explicitly PINNED search; the UI
 *     gate blocks it until a pin is set, and (when its workflow enforces it) the
 *     run STOPs pin-less rather than inferring. The mutating/destructive and the
 *     status-consuming skills, where a wrong profile is costly or irreversible.
 *   - "infer_ok"     — read-only / trivially re-runnable: a single active
 *     profile may be inferred (the resolver's exactly-1 branch), so the gate
 *     allows it with a pin OR an active profile.
 */
export type SkillProfilePin = "exempt" | "pin_required" | "infer_ok";

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
  /** Profile-pin posture — drives the pre-launch UI gate (and, where wired, the
   *  workflow's require-pin STOP). */
  profilePin: SkillProfilePin;
}

/** The intake skill id (skill #1, e2e-first). */
export const INTAKE_SKILL_ID = "search_profile_intake" as const;

/** The dealer geosearch skill id (skill #2, first browser skill). */
export const GEOSEARCH_SKILL_ID = "dealer_geosearch" as const;

/** The inventory site scan skill id (skill #3, batch_review suspend). */
export const INVENTORY_SITE_SCAN_SKILL_ID = "inventory_site_scan" as const;

/** The inventory link scan skill id (skill #4, batch_review suspend over
 *  pending dealer_inventory_sources links). */
export const INVENTORY_LINK_SCAN_SKILL_ID = "inventory_link_scan" as const;

/** The incentive scrape skill id (skill #5, OEM first-encounter approval). */
export const INCENTIVE_SCRAPE_SKILL_ID = "incentive_scrape" as const;

/** The dealer inbox check skill id (skill #6, email-pull + one batch_review). */
export const INBOX_CHECK_SKILL_ID = "dealer_inbox_check" as const;

/** The dealer hygiene skill id (destructive; three staged batch-review confirms). */
export const HYGIENE_SKILL_ID = "dealer_hygiene" as const;

/** The inventory compare skill id (deterministic ranker; read-only, zero-LLM). */
export const INVENTORY_COMPARE_SKILL_ID = "inventory_compare" as const;

/** The quote audit skill id (deterministic 10-check audit; read-only plus an
 *  idempotent quote_audits upsert, zero-LLM). */
export const QUOTE_AUDIT_SKILL_ID = "quote_audit" as const;

/** The quote compare skill id (deterministic compare ranker; read-only,
 *  zero-LLM, no suspend). */
export const QUOTE_COMPARE_SKILL_ID = "quote_compare" as const;

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
    profilePin: "exempt",
  },
  {
    id: QUOTE_AUDIT_SKILL_ID,
    slash: "/quote_audit",
    title: "Quote audit",
    summary: "Run the 10-check audit over a profile's recent dealer quotes and flag issues.",
    phase: 1,
    riskClass: "read_only",
    status: "implemented",
    workflowId: QUOTE_AUDIT_SKILL_ID,
    inputs: ["profile_id", "quote_id"],
    outputs: "audit_summary",
    profilePin: "infer_ok",
  },
  {
    id: QUOTE_COMPARE_SKILL_ID,
    slash: "/quote_compare",
    title: "Quote compare",
    summary: "Compare multiple dealer quotes side by side.",
    phase: 1,
    riskClass: "read_only",
    status: "implemented",
    workflowId: QUOTE_COMPARE_SKILL_ID,
    inputs: ["quotes"],
    outputs: "comparison",
    profilePin: "infer_ok",
  },
  {
    id: INVENTORY_COMPARE_SKILL_ID,
    slash: "/inventory_compare",
    title: "Inventory compare",
    summary: "Compare inventory listings against a search profile.",
    phase: 1,
    riskClass: "read_only",
    status: "implemented",
    workflowId: INVENTORY_COMPARE_SKILL_ID,
    inputs: ["listings", "profile_id"],
    outputs: "comparison",
    profilePin: "infer_ok",
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
    profilePin: "infer_ok",
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
    profilePin: "infer_ok",
  },
  {
    id: INVENTORY_LINK_SCAN_SKILL_ID,
    slash: "/inventory_link_scan",
    title: "Inventory link scan",
    summary: "Visit unscraped dealer inventory URLs and match listings against the buyer profile.",
    phase: 2,
    riskClass: "local_write",
    status: "implemented",
    workflowId: INVENTORY_LINK_SCAN_SKILL_ID,
    inputs: ["search_profile_id"],
    outputs: "listings",
    profilePin: "infer_ok",
  },
  {
    id: INCENTIVE_SCRAPE_SKILL_ID,
    slash: "/incentive_scrape",
    title: "Incentive scrape",
    summary:
      "Scrape current manufacturer incentives for each active profile's vehicle (first-encounter source approval).",
    phase: 2,
    riskClass: "local_write",
    status: "implemented",
    workflowId: INCENTIVE_SCRAPE_SKILL_ID,
    inputs: ["search_profile_id"],
    outputs: "incentives",
    profilePin: "infer_ok",
  },

  // ---- Phase 3 · email service + LLM extract (Gmail read + fake-mailbox/local db.write) ----
  {
    id: INBOX_CHECK_SKILL_ID,
    slash: "/dealer_inbox_check",
    title: "Dealer inbox check",
    summary: "Read dealer replies from the mailbox and surface new messages.",
    phase: 3,
    riskClass: "local_write",
    status: "implemented",
    workflowId: INBOX_CHECK_SKILL_ID,
    inputs: ["search_profile_id"],
    outputs: "messages",
    profilePin: "pin_required",
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
    profilePin: "infer_ok",
  },
  {
    id: HYGIENE_SKILL_ID,
    slash: "/dealer_hygiene",
    title: "Dealer hygiene",
    summary: "Classify CRM threads, suppress noisy senders, and delete orphan thread records (three staged batch-review confirms).",
    phase: 3,
    riskClass: "destructive",
    status: "implemented",
    workflowId: HYGIENE_SKILL_ID,
    inputs: ["search_profile_id"],
    outputs: "hygiene_report",
    profilePin: "pin_required",
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
    profilePin: "pin_required",
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
    profilePin: "pin_required",
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
    profilePin: "pin_required",
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
    profilePin: "pin_required",
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
    profilePin: "pin_required",
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
    profilePin: "pin_required",
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
