/**
 * skillRegistry lint gate — the bidirectional registry ↔ workflows contract.
 * The skills and workflows layers never import each other; the matching string
 * is the contract. This test (in the server, which may import both) asserts it.
 * Pure; no I/O.
 */

import { describe, expect, it } from "vitest";

import { SKILLS } from "@autobroker/skills";
import { REGISTERED_WORKFLOW_IDS } from "@autobroker/workflows";

describe("skill registry ↔ workflows registry", () => {
  it("every implemented skill has a workflowId that is a registered workflow", () => {
    for (const s of SKILLS) {
      if (s.status !== "implemented") continue;
      expect(s.workflowId).not.toBeNull();
      expect(REGISTERED_WORKFLOW_IDS).toContain(s.workflowId);
    }
  });

  it("every registered workflow id belongs to exactly one registry entry", () => {
    for (const id of REGISTERED_WORKFLOW_IDS) {
      const owners = SKILLS.filter((s) => s.workflowId === id);
      expect(owners).toHaveLength(1);
    }
  });

  it("a planned skill carries no workflowId", () => {
    for (const s of SKILLS) {
      if (s.status === "planned") expect(s.workflowId).toBeNull();
    }
  });
});
