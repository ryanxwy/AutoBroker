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
 * skills is NEVER hidden on any surface; the gate renders before the prose. That
 * lands with the gate components in M2-run2.
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
