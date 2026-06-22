/**
 * freezeToCorpus.test.ts — the minimizer + corpus emitter:
 *   - minimizeFailingInput shrinks while the predicate still fails, stops at the
 *     smallest reproduction, honors the iteration budget, and freezes the full
 *     text when nothing shrinks (the "could not minimize" fallback).
 *   - emitCorpusToml produces a *.toml that parseCase (the EXISTING cases.ts
 *     grammar) parses without error — proving the discovery→freeze→gate handoff.
 */

import { describe, expect, it } from "vitest";

import { parseCase } from "../cases.js";
import {
  emitCorpusToml,
  minimizeFailingInput,
  type EmitCorpusTomlInput,
} from "./freezeToCorpus.js";

describe("minimizeFailingInput", () => {
  it("shrinks to the smallest reproduction the predicate keeps failing on", () => {
    // The failure reproduces iff the candidate still contains the token "BAD".
    const input = "Hello there. This sentence has BAD in it. And another sentence here.";
    const result = minimizeFailingInput(input, (c) => c.includes("BAD"));
    expect(result.minimized).toContain("BAD");
    expect(result.minimized.length).toBeLessThan(input.length);
    expect(result.shrank).toBe(true);
    // The fine pass drops surrounding tokens too — the floor is the token itself.
    expect(result.minimized).toBe("BAD");
  });

  it("freezes the full text when nothing shrinks (every drop stops failing)", () => {
    // The failure reproduces ONLY on the exact full string (a brittle full-prose
    // repro — the plan-0 "could not minimize, freeze full text" fallback).
    const input = "exact only string";
    const result = minimizeFailingInput(input, (c) => c === input);
    expect(result.minimized).toBe(input);
    expect(result.shrank).toBe(false);
  });

  it("honors the max-iteration budget (gives up + returns best-so-far)", () => {
    const input = "a b c d e f g h i j k BAD l m n o p";
    const result = minimizeFailingInput(input, (c) => c.includes("BAD"), { maxIterations: 2 });
    expect(result.iterations).toBeLessThanOrEqual(2);
    expect(result.minimized).toContain("BAD");
  });

  it("throws when the predicate does not fail on the full input (caller bug)", () => {
    expect(() => minimizeFailingInput("clean", () => false)).toThrow(/does not fail on the full input/);
  });

  it("returns a 1-minimal token set (every remaining token is load-bearing)", () => {
    // The failure reproduces iff the candidate still contains BOTH needle tokens.
    // ddmin + the verify pass must strip everything else and leave a set where
    // dropping ANY single remaining token breaks the predicate.
    const input = "please find me a dealer near ZIP 99999 by tomorrow afternoon ok thanks";
    const fails = (c: string) => c.includes("ZIP") && c.includes("99999");
    const result = minimizeFailingInput(input, fails);
    expect(fails(result.minimized)).toBe(true);
    expect(result.shrank).toBe(true);
    const tokens = result.minimized.split(/\s+/).filter((t) => t.length > 0);
    for (let i = 0; i < tokens.length; i += 1) {
      const dropped = tokens.filter((_, j) => j !== i).join(" ");
      expect(fails(dropped)).toBe(false);
    }
  });
});

describe("emitCorpusToml → parseCase (the EXISTING cases.ts grammar)", () => {
  function emit(overrides: Partial<EmitCorpusTomlInput> = {}): string {
    return emitCorpusToml({
      caseId: "soak_frozen_cold_start",
      skill: "search_profile_intake",
      frozenText: 'I want a "Tucson" Hybrid\nin Irvine, 41k tops',
      failingAssertion: "no_external_mutation",
      ...overrides,
    });
  }

  it("emits a TOML that parseCase accepts without error", () => {
    const toml = emit();
    const c = parseCase(toml);
    expect(c.id).toBe("soak_frozen_cold_start");
    expect(c.inputMode).toBe("freeform");
    expect(c.lane).toBe("ui");
    expect(c.steps.length).toBe(1);
    expect(c.steps[0]!.skill).toBe("search_profile_intake");
    // The frozen text (with its escaped quotes + newline) round-trips into the prompt.
    expect(c.steps[0]!.inputInline?.["prompt"]).toBe('I want a "Tucson" Hybrid\nin Irvine, 41k tops');
    // The keystone anchor is present (the no_external_mutation regression).
    expect(c.steps[0]!.anchors.some((a) => a.kind === "no_external_mutation")).toBe(true);
  });

  it("maps the malformed-extraction assertion onto the malformed_tool_call anchor", () => {
    const toml = emit({
      caseId: "soak_frozen_extract",
      skill: "dealer_reply_extract",
      failingAssertion: "malformed_extraction_fail_closed",
    });
    const c = parseCase(toml);
    const anchor = c.steps[0]!.anchors.find((a) => a.kind === "malformed_tool_call");
    expect(anchor).toBeDefined();
    expect((anchor as { expect?: string }).expect).toBe("fail_closed");
    // The always-on keystone is also appended (a non-keystone failing assertion).
    expect(c.steps[0]!.anchors.some((a) => a.kind === "no_external_mutation")).toBe(true);
  });

  it("maps the profile-ASK branch onto a run_status=error anchor", () => {
    const toml = emit({
      caseId: "soak_frozen_profile",
      skill: "dealer_geosearch",
      failingAssertion: "profile_ask_branch",
    });
    const c = parseCase(toml);
    const anchor = c.steps[0]!.anchors.find((a) => a.kind === "run_status");
    expect(anchor).toBeDefined();
  });

  it("emits [[seed.dealer_replies]] for a multi-round freeze, still parseable", () => {
    const toml = emit({
      caseId: "soak_frozen_multiround",
      skill: "dealer_reply_extract",
      failingAssertion: "malformed_extraction_fail_closed",
      dealerReplies: [
        {
          dealerName: "Tustin Hyundai",
          dealerWebsite: "tustinhyundai.com",
          from: "sales@tustinhyundai.com",
          subject: "Re: Tucson Hybrid quote",
          body: "We can do $36,100 out the door.",
        },
      ],
    });
    const c = parseCase(toml);
    expect(c.seed?.dealerReplies?.length).toBe(1);
    expect(c.seed?.dealerReplies?.[0]!.dealerName).toBe("Tustin Hyundai");
  });
});
