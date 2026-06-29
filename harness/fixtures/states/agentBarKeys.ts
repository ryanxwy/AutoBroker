/**
 * agentBarKeys — the credential world the AgentBar selector renders against:
 * DeepSeek API key present (the host seeds it by default) + a Claude API key
 * (anthropic) AND a Claude subscription token (claude_oauth) both present.
 *
 * It proves the bar's OAuth-only-Claude cross-disable end-to-end: with the
 * subscription token present the Claude PROVIDER is enabled (pickable), and
 * within Claude the OAuth METHOD is enabled while the API-key method stays GREYED
 * — even though the anthropic API key IS present, the bar does not offer Claude's
 * per-token lane. No DB rows are needed (the rail + AgentBar render on the empty
 * home world); this state is about the secretsStore only.
 */

import { setKey } from "@autobroker/tools";

import type { FixtureState } from "./index.js";

export const agentBarKeys: FixtureState = {
  id: "agent_bar_keys",
  seed: () => {
    // deepseek is already present (the host seeds DEEPSEEK_API_KEY by default).
    // Seed BOTH a Claude API key (anthropic) and a subscription token: Claude is
    // pickable (oauth token present), and the API-key method must STILL be greyed
    // (the bar offers Claude on the OAuth-subscription lane only).
    setKey("anthropic", "sk-ant-functional-not-used");
    setKey("claude_oauth", "oauth-functional-not-used");
  },
};
