/**
 * AgentSelection — the UI's provider-selection payload, validated as a core
 * contract.
 *
 * The UI can send `provider:"claude"` as an alias; parseAgentSelection maps
 * it to `"anthropic"`. DeepSeek has no OAuth lane; any deepseek+oauth input
 * is coerced to deepseek+apikey. Unknown providers return null.
 *
 * Schema style: flat, all fields required, explicit null over optional.
 */

import { z } from "zod";

export const AgentSelectionSchema = z
  .object({
    /** Resolved provider — only "deepseek" and "anthropic" are valid post-parse. */
    provider: z.enum(["deepseek", "anthropic"]),
    /** Auth method. "oauth" is valid only with provider "anthropic". */
    method: z.enum(["apikey", "oauth"]),
    /** Concrete model id, or null to let the model-layer policy resolve it. */
    model: z.string().nullable(),
    /** Reasoning effort hint. Defaults to "off" when absent from the UI payload. */
    effort: z.enum(["off", "low", "medium", "high", "max"]),
  })
  .strict()
  .describe("UI provider-selection payload, normalized and validated.");

export type AgentSelection = z.infer<typeof AgentSelectionSchema>;

/**
 * Tolerant parser for the UI's raw provider-selection payload.
 *
 * - Maps `provider:"claude"` → `"anthropic"`.
 * - Forces `method:"apikey"` when provider resolves to `"deepseek"`.
 * - Defaults `model` to null, `effort` to "off" when absent.
 * - Returns null (never throws) for undefined/null/{}/garbage/unknown provider.
 */
export function parseAgentSelection(raw: unknown): AgentSelection | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;

  const input = raw as Record<string, unknown>;

  // Resolve provider: accept "claude" as alias for "anthropic".
  let provider = input["provider"];
  if (provider === "claude") provider = "anthropic";

  // Reject anything that isn't a known provider now.
  if (provider !== "deepseek" && provider !== "anthropic") return null;

  // DeepSeek has no OAuth lane — coerce to apikey.
  let method = input["method"];
  if (provider === "deepseek") method = "apikey";

  // Apply defaults.
  const model = input["model"] ?? null;
  const effort = input["effort"] ?? "off";

  return AgentSelectionSchema.safeParse({ provider, method, model, effort }).data ?? null;
}
