/**
 * pipeline_reset — the DESTRUCTIVE full-DB reset skill. ONE flat linear Mastra
 * `createWorkflow`: a typed-YES second-confirm suspend, a default pre-reset
 * close-out pass (a typed-SKIP STUB until X3 lands), a VACUUM INTO backup BEFORE
 * the wipe, an atomic migrate-based recreate (+ the mastra.db workflow-runtime
 * clear), a manifest schema verification, and a zero-LLM notify/confirm. NO LLM
 * call anywhere.
 *
 * THE KEYSTONE — NO CONFIRMATION → ZERO DESTRUCTION. The typed-YES gate is the
 * ONLY place destruction is unlocked: a decline/cancel, OR a confirm whose token
 * is not the verbatim YES (re-validated SERVER-SIDE here, never trusting the
 * client/LLM), sets `declined` and every later step passes through — no backup
 * is taken, no DB is deleted, no mastra runtime is cleared. So a decline leaves
 * the product DB, the backups dir, and the workflow runtime ALL at Δ=0.
 *
 * SAFETY (load-bearing):
 *   - typed-YES token re-validated in CODE (validateResetToken) on resume — the
 *     client YES check is convenience only;
 *   - the 5 consequence_lines are PLAIN SPEECH, never name a table, and the
 *     fourth EXPLICITLY states in-flight runs / workflow runtime will be cleared;
 *   - the close-out runs as the default pre-reset pass; the STUB returns
 *     no_eligible with NO suspend and NO second reset confirmation — the real X3
 *     `dealer_closeout_email` composition (its own batch-review suspend,
 *     real send in buyer mode / fake in test mode) wires in at the marked point;
 *   - the reset tools REFUSE the production data tree ~/.autobroker;
 *   - notify/confirm are deterministic ZERO-LLM and point at the intake.
 *
 * STEP MAP:
 *   0 confirmGate — typed-YES suspend (destructive danger frame). decline OR a
 *                   non-YES token → declined (zero destruction). YES → unlock.
 *   1 closeOut    — STUB: returns close_out="no_eligible" (no suspend). The real
 *                   X3 composition wires HERE (see the marked comment).
 *   2 backup      — VACUUM INTO snapshot BEFORE the wipe (skipped when declined).
 *   3 reset       — atomic migrate-based recreate + accounts re-seed + mastra.db
 *                   workflow-runtime clear (skipped when declined).
 *   4 verifySchema— assert the fresh table set + emptiness vs the manifest.
 *   5 notify      — ZERO-LLM headline + deep-link to /search_profile_intake.
 *   6 confirm     — ZERO-LLM terminal summary pointing at the intake.
 *
 * Dependency wall: imports @mastra/* (legal only here), @autobroker/tools (the
 * reset tools — the ONLY DB/side-effect paths), and the skill-local contracts.
 */

import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";

import {
  backupProductDb as backupProductDbImpl,
  pipelineReset as pipelineResetImpl,
  resolveDataDir as resolveDataDirImpl,
  validateResetToken as validateResetTokenImpl,
  verifySchema as verifySchemaImpl,
  getDb,
} from "@autobroker/tools";

import {
  PIPELINE_RESET_CONSEQUENCE_LINES,
  PIPELINE_RESET_CONFIRM_TOKEN,
  PIPELINE_RESET_WORKFLOW_ID,
  PipelineResetGateSuspendSchema,
  PipelineResetInputSchema,
  PipelineResetOutputSchema,
  PipelineResetResumeSchema,
} from "./pipelineResetContracts.js";

// ---------------------------------------------------------------------------
// dependency-injection seam (test-runner-guarded, mirroring the other skills)
// ---------------------------------------------------------------------------

/**
 * The runtime collaborators the workflow steps call. Injectable so the offline
 * tests drive the REAL flat Mastra workflow → REAL suspend/resume chain with
 * deterministic fakes, WITHOUT module mocks (and without a real wipe).
 */
export interface PipelineResetWorkflowDeps {
  /** Server-side typed-YES validation (the load-bearing decline floor). */
  validateResetToken: typeof validateResetTokenImpl;
  /** The VACUUM INTO backup (skipped on decline). */
  backupProductDb: typeof backupProductDbImpl;
  /** The atomic migrate-based recreate + mastra runtime clear (skipped on decline). */
  pipelineReset: typeof pipelineResetImpl;
  /** The manifest schema verifier. */
  verifySchema: typeof verifySchemaImpl;
  /** The isolated data-dir resolver. */
  resolveDataDir: typeof resolveDataDirImpl;
  /** The DB accessor verifySchema reads through. */
  getDb: typeof getDb;
}

const realDeps: PipelineResetWorkflowDeps = {
  validateResetToken: validateResetTokenImpl,
  backupProductDb: backupProductDbImpl,
  pipelineReset: pipelineResetImpl,
  verifySchema: verifySchemaImpl,
  resolveDataDir: resolveDataDirImpl,
  getDb,
};

let injectedDeps: PipelineResetWorkflowDeps | undefined;

function deps(): PipelineResetWorkflowDeps {
  return injectedDeps ?? realDeps;
}

/** TEST-ONLY seam — refused outside a test runner (a production caller must
 *  never redirect the wipe or the token validation). */
export function __setPipelineResetDepsForTests(
  partial: Partial<PipelineResetWorkflowDeps>,
): void {
  if (process.env["VITEST"] === undefined && process.env["NODE_ENV"] !== "test") {
    throw new Error(
      "__setPipelineResetDepsForTests is a test-only seam (refused outside a test runner)",
    );
  }
  injectedDeps = { ...realDeps, ...partial };
}

/** Restore the real wiring between test cases. */
export function __resetPipelineResetDepsForTests(): void {
  injectedDeps = undefined;
}

// ---------------------------------------------------------------------------
// the threaded workflow state (flat plain-JSON)
// ---------------------------------------------------------------------------

const PipelineResetStateSchema = z.object({
  /** Terminal-declined flag: once true, every later step passes through with
   *  ZERO destruction (no backup, no wipe, no runtime clear). */
  declined: z.boolean(),
  /** The close-out terminal (STUB → "no_eligible" until X3 lands). */
  closeOut: z.enum(["no_eligible", "skipped_all", "sent"]),
  /** The VACUUM INTO backup path (set by the backup step). */
  backupPath: z.string(),
  /** The verified fresh-schema table count (set by the reset/verify steps). */
  tablesCreated: z.number().int(),
});
type PipelineResetState = z.infer<typeof PipelineResetStateSchema>;

function asState(inputData: unknown): PipelineResetState {
  return PipelineResetStateSchema.parse(inputData);
}

// ---------------------------------------------------------------------------
// step 0 — confirmGate (the typed-YES suspend; decline/non-YES → zero destruction)
// ---------------------------------------------------------------------------

const confirmGateStep = createStep({
  id: "confirmGate",
  inputSchema: PipelineResetInputSchema,
  outputSchema: PipelineResetStateSchema,
  resumeSchema: PipelineResetResumeSchema,
  suspendSchema: PipelineResetGateSuspendSchema,
  execute: async ({ resumeData, suspend }) => {
    const base: PipelineResetState = {
      declined: false,
      closeOut: "no_eligible",
      backupPath: "",
      tablesCreated: 0,
    };

    // First pass: render the destructive typed-YES card (gate before prose).
    if (resumeData === undefined) {
      return (await suspend({
        kind: "confirmation_gate",
        destructive: true,
        confirm_token: PIPELINE_RESET_CONFIRM_TOKEN,
        question:
          "This permanently erases all of your local pipeline data. Type YES to confirm, or cancel.",
        consequence_lines: [...PIPELINE_RESET_CONSEQUENCE_LINES],
      })) as never;
    }

    const resume = PipelineResetResumeSchema.parse(resumeData);
    if (resume.action === "decline") return { ...base, declined: true };

    // SERVER-SIDE re-validation: trust ONLY the typed-YES check, never the
    // client/LLM. A confirm carrying a non-YES token is treated as a decline —
    // no destruction. (The client pre-checks YES; this is the load-bearing gate.)
    if (!deps().validateResetToken(resume.confirm_token)) {
      return { ...base, declined: true };
    }
    return base;
  },
});

// ---------------------------------------------------------------------------
// step 1 — closeOut (the default pre-reset close-out pass — typed-SKIP STUB)
// ---------------------------------------------------------------------------

const closeOutStep = createStep({
  id: "closeOut",
  inputSchema: PipelineResetStateSchema,
  outputSchema: PipelineResetStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) return state;

    // ===== X3 WIRE-POINT =====================================================
    // The default pre-reset close-out pass. When `dealer_closeout_email` (X3,
    // Phase 5) lands, COMPOSE it here as a top-level child step: it carries its
    // OWN batch-review suspend and really sends in buyer mode / fakes in test
    // mode (approval never hidden). Branch on its terminal {no_eligible | skipped_all | sent}.
    // There is NO second reset confirmation after close-out — the typed-YES gate
    // above already authorized the whole run. Until X3 exists, this is a
    // typed-SKIP STUB returning no_eligible (no suspend, no send, no write).
    // =========================================================================
    return { ...state, closeOut: "no_eligible" };
  },
});

// ---------------------------------------------------------------------------
// step 2 — backup (VACUUM INTO snapshot BEFORE the wipe)
// ---------------------------------------------------------------------------

const backupStep = createStep({
  id: "backup",
  inputSchema: PipelineResetStateSchema,
  outputSchema: PipelineResetStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) return state; // ZERO destruction: no backup taken.

    const dataDir = deps().resolveDataDir();
    const backupPath = deps().backupProductDb({ dataDir, nowMs: Date.now() });
    return { ...state, backupPath };
  },
});

// ---------------------------------------------------------------------------
// step 3 — reset (atomic migrate-based recreate + mastra runtime clear)
// ---------------------------------------------------------------------------

const resetStep = createStep({
  id: "reset",
  inputSchema: PipelineResetStateSchema,
  outputSchema: PipelineResetStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) return state; // ZERO destruction: no wipe.

    const dataDir = deps().resolveDataDir();
    // The workflow already took the user-facing VACUUM INTO backup in step 2,
    // so skip the tool's internal backup (no double snapshot). The backup path
    // the user is told about is the one from step 2.
    const result = deps().pipelineReset({ dataDir, skipBackup: true });
    return {
      ...state,
      tablesCreated: result.tablesCreated,
    };
  },
});

// ---------------------------------------------------------------------------
// step 4 — verifySchema (assert the fresh table set + emptiness vs manifest)
// ---------------------------------------------------------------------------

const verifySchemaStep = createStep({
  id: "verifySchema",
  inputSchema: PipelineResetStateSchema,
  outputSchema: PipelineResetStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) return state;

    const verdict = deps().verifySchema(deps().getDb());
    if (!verdict.ok) {
      throw new Error(`pipeline reset verification failed: ${verdict.issues.join("; ")}`);
    }
    return { ...state, tablesCreated: verdict.tablesCreated };
  },
});

// ---------------------------------------------------------------------------
// step 5 — notify (ZERO-LLM; headline + deep-link target; no new Notification())
// ---------------------------------------------------------------------------

/** The deep-link target a successful reset points the user at. */
export const PIPELINE_RESET_DEEP_LINK = "/search_profile_intake" as const;

const notifyStep = createStep({
  id: "notify",
  inputSchema: PipelineResetStateSchema,
  outputSchema: PipelineResetStateSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) return state;

    // Produce the headline + deep-link target ONLY; the native-notification
    // delivery is the app-layer U-G ladder (the workflow never calls
    // new Notification()). The headline carries no budget figure (none exists in
    // this skill's state).
    console.info(
      JSON.stringify({
        trace: "pipeline_reset",
        event: "notify",
        headline: "Local pipeline data was reset. Start fresh from intake.",
        deepLink: PIPELINE_RESET_DEEP_LINK,
      }),
    );
    return state;
  },
});

// ---------------------------------------------------------------------------
// step 6 — confirm (deterministic ZERO-LLM terminal summary)
// ---------------------------------------------------------------------------

const confirmStep = createStep({
  id: "confirm",
  inputSchema: PipelineResetStateSchema,
  outputSchema: PipelineResetOutputSchema,
  execute: async ({ inputData }) => {
    const state = asState(inputData);
    if (state.declined) {
      return { outcome: "declined" as const };
    }

    const summary =
      `Reset complete — your local pipeline data was erased and a fresh ${state.tablesCreated}-table ` +
      "schema was recreated. A one-time backup was saved in case you need to recover. " +
      "Start over by creating a search profile at /search_profile_intake.";

    return {
      outcome: "reset" as const,
      databaseReset: true as const,
      tablesCreated: state.tablesCreated,
      backupPath: state.backupPath,
      summary,
    };
  },
});

// ---------------------------------------------------------------------------
// the flat workflow (7 steps, .then() chain, .commit())
// ---------------------------------------------------------------------------

export const pipelineResetWorkflow = createWorkflow({
  id: PIPELINE_RESET_WORKFLOW_ID,
  inputSchema: PipelineResetInputSchema,
  outputSchema: PipelineResetOutputSchema,
})
  .then(confirmGateStep)
  .then(closeOutStep)
  .then(backupStep)
  .then(resetStep)
  .then(verifySchemaStep)
  .then(notifyStep)
  .then(confirmStep)
  .commit();

export { PIPELINE_RESET_WORKFLOW_ID };
