/**
 * agentBarKeys — the credential world the AgentBar selector renders against:
 * DeepSeek API key present (the host seeds it by default) + a Claude API key
 * (anthropic) present, but NO Claude subscription token (claude_oauth absent).
 *
 * It proves the bar's presence-gating end-to-end: with anthropic present the
 * Claude PROVIDER is enabled (pickable), and within Claude the API-key METHOD is
 * enabled while the OAuth method is GREYED (no subscription token) — the exact
 * cross-disable the bar encodes. No DB rows are needed (the rail + AgentBar
 * render on the empty home world); this state is about the secretsStore only.
 */

import { clearKey, setKey } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

export const agentBarKeys: FixtureState = {
  id: "agent_bar_keys",
  seed: () => {
    // deepseek is already present (the host seeds DEEPSEEK_API_KEY by default).
    // Add a Claude API key so the Claude provider is enabled.
    setKey("anthropic", "sk-ant-functional-not-used");
    // Clear the subscription token so the OAuth method is deterministically
    // GREYED — the ambient dev environment may export CLAUDE_CODE_OAUTH_TOKEN
    // (Claude Code's own subscription auth), which would otherwise read present.
    clearKey("claude_oauth");
  },
};
