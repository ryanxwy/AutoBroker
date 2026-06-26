/**
 * Unit tests — the pure per-thread negotiation status overlay. A table over the
 * (persisted state, gate, cap, inbound, roundsSent, current/prior OTD) space,
 * asserting the derived status for every cascade branch. The status is a READ-ONLY
 * projection (no stored column); concession movement is the deterministic numeric
 * otd trajectory (NOT the LLM intent), per the adversarial-review ruling.
 */

import { describe, expect, it } from "vitest";
import { deriveNegotiationStatus, type NegotiationStatusInput } from "./negotiationStatus.js";

function input(over: Partial<NegotiationStatusInput> = {}): NegotiationStatusInput {
  return {
    persistedState: "replied",
    gate: "ready",
    cap: "ok",
    lastInboundAtMs: 1_000,
    roundsSent: 0,
    currentOtd: null,
    priorOtd: null,
    ...over,
  };
}

describe("deriveNegotiationStatus", () => {
  const cases: Array<{ name: string; in: NegotiationStatusInput; out: string }> = [
    { name: "closed thread → dead (terminal)", in: input({ persistedState: "closed" }), out: "dead" },
    { name: "suppressed thread → dead (terminal)", in: input({ persistedState: "suppressed" }), out: "dead" },
    { name: "agreed thread → agreed (terminal)", in: input({ persistedState: "agreed" }), out: "agreed" },
    {
      name: "cold (gate=skip) → dormant even with an open quote",
      in: input({ gate: "skip", currentOtd: 46000, priorOtd: 46000 }),
      out: "dormant",
    },
    {
      name: "anti-pester cap → dormant",
      in: input({ cap: "unanswered_cap", currentOtd: 46000 }),
      out: "dormant",
    },
    {
      name: "we sent, no dealer reply yet → lead_sent",
      in: input({ lastInboundAtMs: null, roundsSent: 1 }),
      out: "lead_sent",
    },
    {
      name: "open quote, OTD dropped vs prior → countered (dealer is conceding)",
      in: input({ currentOtd: 44000, priorOtd: 46000 }),
      out: "countered",
    },
    {
      name: "open quote, OTD flat across rounds → stalled",
      in: input({ currentOtd: 46000, priorOtd: 46000 }),
      out: "stalled",
    },
    {
      name: "open quote, OTD went UP (re-trade) → stalled (not improving)",
      in: input({ currentOtd: 47000, priorOtd: 46000 }),
      out: "stalled",
    },
    {
      name: "single open quote (no prior to compare) → quoted",
      in: input({ currentOtd: 46000, priorOtd: null }),
      out: "quoted",
    },
    {
      name: "dealer replied but no extractable quote → replied",
      in: input({ lastInboundAtMs: 5_000, currentOtd: null }),
      out: "replied",
    },
    {
      name: "dormant outranks a conceding trajectory (cold wins)",
      in: input({ gate: "skip", currentOtd: 44000, priorOtd: 46000 }),
      out: "dormant",
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(deriveNegotiationStatus(c.in)).toBe(c.out);
    });
  }
});
