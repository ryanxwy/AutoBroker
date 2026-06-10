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
  searchProfileIntakeWorkflow,
  SEARCH_PROFILE_INTAKE_WORKFLOW_ID,
} from "./searchProfileIntake.js";

/** All skill workflows, keyed by id, for createMastraInstance({ workflows }). */
export const REGISTERED_WORKFLOWS: Record<string, Workflow> = {
  [SEARCH_PROFILE_INTAKE_WORKFLOW_ID]: searchProfileIntakeWorkflow as unknown as Workflow,
  [DEALER_GEOSEARCH_WORKFLOW_ID]: dealerGeosearchWorkflow as unknown as Workflow,
};

/** The ids recoverOnBoot scans (the keys of REGISTERED_WORKFLOWS). */
export const REGISTERED_WORKFLOW_IDS: string[] = Object.keys(REGISTERED_WORKFLOWS);
