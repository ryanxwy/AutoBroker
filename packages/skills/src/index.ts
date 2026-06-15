/**
 * @autobroker/skills — the skill manifest layer.
 *
 * Pure data + types: the typed SkillDef registry that is the single cross-layer
 * source of skill identity. Imports no framework (no AI SDK / Mastra / Drizzle /
 * HTTP), so both the server and the UI can consume it. Per-skill human docs live
 * in <skill>/SKILL.md beside this src/.
 */

export {
  SKILLS,
  IMPLEMENTED_SKILLS,
  INTAKE_SKILL_ID,
  GEOSEARCH_SKILL_ID,
  INVENTORY_SITE_SCAN_SKILL_ID,
  INVENTORY_LINK_SCAN_SKILL_ID,
  INCENTIVE_SCRAPE_SKILL_ID,
  INBOX_CHECK_SKILL_ID,
  REPLY_EXTRACT_SKILL_ID,
  HYGIENE_SKILL_ID,
  INVENTORY_COMPARE_SKILL_ID,
  QUOTE_AUDIT_SKILL_ID,
  QUOTE_COMPARE_SKILL_ID,
  QUOTE_PIPELINE_SKILL_ID,
  getSkill,
} from "./registry.js";
export type {
  SkillDef,
  SkillPhase,
  SkillRiskClass,
  SkillStatus,
  SkillProfilePin,
} from "./registry.js";
