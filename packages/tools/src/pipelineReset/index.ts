/**
 * pipelineReset — the DESTRUCTIVE full-DB reset tools (public surface).
 *
 * The controller adds these to the @autobroker/tools barrel. The workflow layer
 * drives them in order: typed-YES token validation (server-side), VACUUM INTO
 * backup, atomic migrate-based recreate + accounts re-seed, mastra.db runtime
 * clear, and the manifest schema verification.
 */

export { validateResetToken, RESET_CONFIRM_TOKEN } from "./token.js";
export {
  backupProductDb,
  BACKUPS_TO_KEEP,
  type BackupProductDbArgs,
} from "./backup.js";
export {
  pipelineReset,
  DEFAULT_ACCOUNT_EMAIL,
  type PipelineResetArgs,
  type PipelineResetResult,
} from "./reset.js";
export {
  verifySchema,
  type VerifySchemaResult,
  type VerifySchemaOptions,
} from "./verifySchema.js";
export {
  clearWorkflowRuntimeState,
  WORKFLOW_RUNTIME_TABLE,
  type ClearWorkflowRuntimeResult,
} from "./mastraRuntime.js";
export {
  assertIsolatedDataDir,
  isProductionDataDir,
  PipelineResetRefusedError,
} from "./isolation.js";
export { resolveProductDbPath, resolveMastraDbPath } from "./paths.js";

// Re-export the programmatic migrator + the table manifest from the db layer so
// the tools barrel can surface a single ensureProductSchema()/migrate path for
// boot to delegate to (the app must not open the product DB directly).
export { migrate, productTableNames, DEFAULT_MIGRATIONS_FOLDER } from "@autobroker/db/migrator";
export { ensureProductSchema } from "./ensureSchema.js";
