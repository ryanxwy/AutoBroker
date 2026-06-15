/**
 * The registered-workflows map — the single source of the skill workflows
 * createMastraInstance({ workflows }) registers, and the ids recoverOnBoot scans.
 *
 * Per runtimeGlue's contract (no documented public `getWorkflows()` plural on the
 * 1.41 instance), the boot caller owns the registry map it built and passes its
 * keys to recoverOnBoot — so this map and REGISTERED_WORKFLOW_IDS are the one
 * place that list lives. As each skill workflow lands it is added here.
 *
 * Dependency wall: imports @mastra/* (legal only here) + this layer's skill
 * workflow modules. The MODULE IMPORT is what re-registers the deterministic step
 * closures at every boot (runtimeGlue header) — importing this map is enough.
 */

import type { Workflow } from "@mastra/core/workflows";

import {
  dealerGeosearchWorkflow,
  DEALER_GEOSEARCH_WORKFLOW_ID,
} from "./dealerGeosearch.js";
import {
  dealerHygieneWorkflow,
  DEALER_HYGIENE_WORKFLOW_ID,
} from "./dealerHygiene.js";
import {
  dealerInboxCheckWorkflow,
  DEALER_INBOX_CHECK_WORKFLOW_ID,
} from "./dealerInboxCheck.js";
import {
  incentiveScrapeWorkflow,
  INCENTIVE_SCRAPE_WORKFLOW_ID,
} from "./incentiveScrape.js";
import {
  inventoryCompareWorkflow,
  INVENTORY_COMPARE_WORKFLOW_ID,
} from "./inventoryCompare.js";
import {
  inventoryLinkScanWorkflow,
  INVENTORY_LINK_SCAN_WORKFLOW_ID,
} from "./inventoryLinkScan.js";
import {
  inventorySiteScanWorkflow,
  INVENTORY_SITE_SCAN_WORKFLOW_ID,
} from "./inventorySiteScan.js";
import {
  quoteAuditWorkflow,
  QUOTE_AUDIT_WORKFLOW_ID,
} from "./quoteAudit.js";
import {
  searchProfileIntakeWorkflow,
  SEARCH_PROFILE_INTAKE_WORKFLOW_ID,
} from "./searchProfileIntake.js";

/** All skill workflows, keyed by id, for createMastraInstance({ workflows }). */
export const REGISTERED_WORKFLOWS: Record<string, Workflow> = {
  [SEARCH_PROFILE_INTAKE_WORKFLOW_ID]: searchProfileIntakeWorkflow as unknown as Workflow,
  [DEALER_GEOSEARCH_WORKFLOW_ID]: dealerGeosearchWorkflow as unknown as Workflow,
  [INVENTORY_SITE_SCAN_WORKFLOW_ID]: inventorySiteScanWorkflow as unknown as Workflow,
  [INVENTORY_LINK_SCAN_WORKFLOW_ID]: inventoryLinkScanWorkflow as unknown as Workflow,
  [INCENTIVE_SCRAPE_WORKFLOW_ID]: incentiveScrapeWorkflow as unknown as Workflow,
  [DEALER_INBOX_CHECK_WORKFLOW_ID]: dealerInboxCheckWorkflow as unknown as Workflow,
  [DEALER_HYGIENE_WORKFLOW_ID]: dealerHygieneWorkflow as unknown as Workflow,
  [INVENTORY_COMPARE_WORKFLOW_ID]: inventoryCompareWorkflow as unknown as Workflow,
  [QUOTE_AUDIT_WORKFLOW_ID]: quoteAuditWorkflow as unknown as Workflow,
};

/** The ids recoverOnBoot scans (the keys of REGISTERED_WORKFLOWS). */
export const REGISTERED_WORKFLOW_IDS: string[] = Object.keys(REGISTERED_WORKFLOWS);
