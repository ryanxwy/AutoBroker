/**
 * keyDefs — the static descriptor table for the five managed API keys. A
 * hand-written map (matching the codebase's data-driven-but-explicit stance):
 * the Settings page renders one KeyRow per entry, in this fixed order. Each
 * descriptor carries the wire id, the human label, a one-line description, the
 * requiredness, and the probe kind (LLM vs geocode) so the row's copy stays
 * accurate without re-deriving it from the id.
 *
 * REQUIREDNESS: deepseek is required (the default provider + the keystone that
 * gates first-run skill launch); google_places is required for dealer search.
 * anthropic + openai are optional switchable providers; claude_oauth is an
 * optional presence-only row (a subscription token, no connection probe).
 *
 * Dependency wall: app/ui layer. Imports the wire ids only.
 */

import type { SecretKeyId } from "../api/wire.js";

/** What kind of probe the "Test connection" button runs — copy only (the server
 *  routes the id to the right probe; this just shapes the row's wording).
 *  "none" = presence-only (no Test button; the backend skips its probe). */
export type KeyTestKind = "llm" | "geocode" | "none";

export interface KeyDef {
  /** The wire id the routes accept. */
  id: SecretKeyId;
  /** The human-facing row label. */
  label: string;
  /** A one-line muted description under the label. */
  description: string;
  /** Required keys block first-run / a core feature when absent. */
  required: boolean;
  /** Probe kind (LLM model-list GET vs a trial geocode). */
  testKind: KeyTestKind;
}

/** The five rows, in the fixed display order (deepseek first — it is the
 *  keystone the first-run gate reads). */
export const KEY_DEFS: readonly KeyDef[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    description:
      "The default AI provider. Required to run any search. DeepSeek stores prompts in the PRC — switch to Anthropic or OpenAI if you prefer a Western provider.",
    required: true,
    testKind: "llm",
  },
  {
    id: "google_places",
    label: "Google Places",
    description: "Geocoding for dealer search. Required to find dealers near you.",
    required: true,
    testKind: "geocode",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    description: "Optional alternative AI provider (Claude).",
    required: false,
    testKind: "llm",
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "Optional alternative AI provider (GPT).",
    required: false,
    testKind: "llm",
  },
  {
    id: "claude_oauth",
    label: "Claude subscription (OAuth)",
    description:
      "Optional. A Claude Pro/Max subscription token (CLAUDE_CODE_OAUTH_TOKEN) — lets the agent selector run Claude on your subscription instead of an API key. Presence-only; no connection test.",
    required: false,
    testKind: "none",
  },
] as const;
