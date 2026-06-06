/**
 * @autobroker/ui — Layer 5 React/Vite dashboard SPA.
 *
 * The runnable surface is the Vite entry (index.html → src/main.tsx → <App/>).
 * This barrel exposes the testable, framework-thin pieces (the typed API client,
 * the single SSE hook, the chat store, the wire schemas) so tests and a future
 * desktop shell import a stable entry. The UI never touches the product DB or
 * external APIs — it renders server state over /api + SSE only (five-layer wall).
 *
 * Approval UX rule (non-negotiable): the human approval for the 3 irreversible
 * skills is NEVER hidden on any surface; the gate renders before the prose.
 */

export { ApiClient, ApiError, apiClient } from "./api/client.js";
export type { ApiClientOptions } from "./api/client.js";

export { useRunStream, __resetRunStreamRegistryForTests } from "./api/useRunStream.js";
export type {
  RunStreamState,
  AwaitingUserPayload,
  UseRunStreamOptions,
} from "./api/useRunStream.js";

export { useChat } from "./store/useChat.js";
export type {
  Session,
  Turn,
  UserTurn,
  AssistantTurn,
  Milestone,
} from "./store/useChat.js";

export * from "./api/wire.js";

// --- shell + routes -------------------------------------------------------
export { App } from "./App.js";
export { matchRoute, navigate, useRoute, Link } from "./router.js";
export type { Route } from "./router.js";

// --- draft store (PII strip + 24h TTL) ------------------------------------
export {
  DRAFT_TTL_MS,
  INTAKE_PII_FIELDS,
  saveDraft,
  loadDraft,
  clearDraft,
  stripForPersist,
} from "./store/drafts.js";

// --- intake form + gate models --------------------------------------------
export { SchemaForm } from "./intake/SchemaForm.js";
export { IntakeForm } from "./intake/IntakeForm.js";
export { classifyGate } from "./intake/gateModel.js";
export type { GateModel } from "./intake/gateModel.js";
export {
  INTAKE_FIELD_NAMES,
  REQUIRED_FIELD_NAMES,
  validateField,
  buildFormDecisionContent,
} from "./intake/formModel.js";

// --- gate + rail components -----------------------------------------------
export { ApprovalPrompt } from "./gate/ApprovalPrompt.js";
export { AssistantTurn as AssistantTurnView } from "./rail/AssistantTurn.js";
export { IntakeScopeNoticeCard } from "./rail/IntakeScopeNotice.js";
export { parseSlashCommand } from "./rail/slashCommand.js";

// --- home --------------------------------------------------------------
export { runDisabled } from "./home/PipelineLedger.js";
export { toSnapshot, vehicleLabel, formatLocation, SUMMARY_EXCLUDED_KEYS } from "./home/profileView.js";

// --- launch ----------------------------------------------------------------
export { launchIntake } from "./launch.js";
