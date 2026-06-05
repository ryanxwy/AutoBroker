/**
 * Minimal M0 canonical-message → ModelMessage translator (Layer 2).
 *
 * PROVENANCE (AI_ORCH R7 — "built alongside harness.generate"): the harness/agent
 * lane speaks the AI SDK's `ModelMessage` shape, but skills should author in a
 * provider-neutral canonical shape so a provider swap stays a registry-string
 * edit (architectureStack §"Provider 路由 / Agent lane"). This file is the seam.
 *
 * M0 SCOPE — flat text only: just { system | user | assistant } turns carrying a
 * plain string `content`. No tool/tool-result turns, no multi-part content
 * (images/files), no provider options. That is enough for the Phase-0 foundation
 * probe + the early structured-generation steps; the richer shape comes later.
 *
 * FAIL-LOUD (safetyInvariants — no silent fallbacks): anything outside the M0
 * subset THROWS rather than being silently coerced or dropped. A dropped turn is
 * a silent context loss; a coerced role is a silent capability change. We refuse
 * both and surface a typed error the caller must handle.
 *
 * M1 PROMOTION: when a canonical message/turn shape is needed by more than this
 * layer (e.g. the workflows/tools transcript), promote `CanonicalMessage` into
 * `@autobroker/core` (pure Zod, framework-free) and import it here instead — core
 * has no message shape today (checked 2026-06-04: only SessionThread exists).
 *
 * Layer note: imports the `ModelMessage` type from `ai` (this is the AI SDK
 * layer's job). The output is consumed by Mastra agents one layer up.
 */

import type { ModelMessage } from "ai";

/** The closed set of roles the M0 translator accepts. */
export const CANONICAL_ROLES = ["system", "user", "assistant"] as const;
export type CanonicalRole = (typeof CANONICAL_ROLES)[number];

/**
 * M0 canonical message: a single role + flat-text turn.
 *
 * Defined HERE (not in @autobroker/core) on purpose — core carries no message
 * shape yet, and inventing one there before a second consumer needs it would be
 * speculative. Promote to core as the M1 item noted in the file header.
 */
export interface CanonicalMessage {
  role: CanonicalRole;
  content: string;
}

/** Thrown when a message falls outside the M0 flat-text subset. Fail-LOUD. */
export class UnsupportedCanonicalMessageError extends Error {
  readonly index: number;
  constructor(index: number, detail: string) {
    super(`Unsupported canonical message at index ${index}: ${detail}`);
    this.name = "UnsupportedCanonicalMessageError";
    this.index = index;
  }
}

function isCanonicalRole(role: unknown): role is CanonicalRole {
  return (CANONICAL_ROLES as readonly unknown[]).includes(role);
}

/**
 * Translate canonical messages to AI SDK `ModelMessage`s.
 *
 * Each of the three M0 roles maps to its same-named ModelMessage variant
 * (System/User/Assistant), all of which accept a plain string `content`, so the
 * mapping is structural and lossless within the subset.
 *
 * Rejects (throws `UnsupportedCanonicalMessageError`) — never drops — any:
 *   - role outside { system | user | assistant }
 *   - non-string content (the only M0 content shape is flat text)
 */
export function toModelMessages(
  messages: readonly CanonicalMessage[],
): ModelMessage[] {
  return messages.map((message, index) => {
    if (!isCanonicalRole(message.role)) {
      throw new UnsupportedCanonicalMessageError(
        index,
        `role "${String(message.role)}" is outside the M0 subset {system,user,assistant}`,
      );
    }
    if (typeof message.content !== "string") {
      throw new UnsupportedCanonicalMessageError(
        index,
        `content must be a flat string at M0 (got ${typeof message.content})`,
      );
    }
    // role is a CanonicalRole literal here; each maps 1:1 to a string-content
    // ModelMessage variant. The explicit switch keeps the union exhaustive so a
    // future role addition is a compile error, not a silent miss.
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content };
      case "user":
        return { role: "user", content: message.content };
      case "assistant":
        return { role: "assistant", content: message.content };
    }
  });
}
