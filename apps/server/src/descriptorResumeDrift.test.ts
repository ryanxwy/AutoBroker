/**
 * Descriptor ⇄ workflow resume-seam drift freeze.
 *
 * A skill's server descriptor carries a `resume` shaper IFF its workflow has at
 * least one suspendable step. When a workflow drops a suspend (e.g.
 * inventory_site_scan / incentive_scrape went auto-approve) but the descriptor
 * keeps a now-unreachable `resume`, or vice-versa, a dead seam accretes. This
 * test derives each workflow's suspendable steps by RUNTIME introspection of the
 * registered Mastra workflow (`workflow.steps[id].suspendSchema`) and pins the
 * exact drift that left the site_scan + incentive dead seams:
 *
 *   (1) descriptor.resume is defined IFF the workflow has ≥1 suspendable step;
 *   (2) for every suspendable step, the descriptor's resume shaper accepts a
 *       payload-independent decline ({action:"decline"}) without throwing;
 *   (3) a zero-suspend workflow's descriptor has resume === undefined.
 *
 * Runtime introspection (not a hand-kept list) is the point: it tracks the real
 * workflow graph, so a future suspend add/remove that forgets the descriptor
 * fails here.
 */

import { describe, expect, it } from "vitest";

import { REGISTERED_WORKFLOWS } from "@autobroker/workflows";

import { RUN_DESCRIPTORS } from "./skillRuns.js";

/** The suspendable step ids of a registered workflow (steps carrying a
 *  suspendSchema), read straight off the runtime step map. */
function suspendableSteps(workflowId: string): string[] {
  const workflow = REGISTERED_WORKFLOWS[workflowId] as unknown as {
    steps: Record<string, { suspendSchema?: unknown }>;
  };
  expect(workflow, `workflow ${workflowId} is registered`).toBeDefined();
  return Object.entries(workflow.steps)
    .filter(([, step]) => step.suspendSchema !== undefined)
    .map(([id]) => id);
}

describe("descriptor resume seam ⇄ workflow suspend steps (drift freeze)", () => {
  it("resume is defined IFF the workflow has ≥1 suspendable step", () => {
    for (const d of RUN_DESCRIPTORS) {
      const steps = suspendableSteps(d.workflowId);
      expect(
        d.resume !== undefined,
        `${d.skillId}: resume ${d.resume ? "present" : "absent"} but ${steps.length} suspendable step(s) [${steps.join(", ")}]`,
      ).toBe(steps.length > 0);
    }
  });

  it("every suspendable step's decline is payload-independent (resume shaper accepts it)", () => {
    for (const d of RUN_DESCRIPTORS) {
      const steps = suspendableSteps(d.workflowId);
      if (steps.length === 0) continue;
      expect(d.resume, `${d.skillId}: has suspend steps → must carry resume`).toBeDefined();
      for (const step of steps) {
        // decline is payload-independent in every shaper: a suspendPayload of {}
        // and a bare decline must resolve without throwing.
        expect(
          () => d.resume!(step, { action: "decline" }, {}),
          `${d.skillId}.resume("${step}", decline) must not throw`,
        ).not.toThrow();
      }
    }
  });

  it("zero-suspend workflows carry no resume shaper", () => {
    const zeroSuspend = RUN_DESCRIPTORS.filter((d) => suspendableSteps(d.workflowId).length === 0);
    // Sanity: some skills ARE zero-suspend (else the introspection is vacuous).
    expect(zeroSuspend.length).toBeGreaterThan(0);
    for (const d of zeroSuspend) {
      expect(d.resume, `${d.skillId}: zero-suspend → resume must be undefined`).toBeUndefined();
    }
  });

  it("some workflows DO expose suspendable steps (introspection is live)", () => {
    const withSuspend = RUN_DESCRIPTORS.filter((d) => suspendableSteps(d.workflowId).length > 0);
    // Guards against a broken `.steps`/`.suspendSchema` read silently reporting
    // every workflow as zero-suspend (which would make (1) pass vacuously only if
    // no descriptor carried resume — it does, so this is belt-and-suspenders).
    expect(withSuspend.length).toBeGreaterThan(0);
  });
});
