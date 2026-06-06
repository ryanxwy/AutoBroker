/**
 * slashCommand.test — the pure slash parser.
 */

import { describe, expect, it } from "vitest";

import { parseSlashCommand } from "./slashCommand.js";

const SKILLS = ["search_profile_intake"];

describe("parseSlashCommand", () => {
  it("empty → empty", () => {
    expect(parseSlashCommand("   ", SKILLS).kind).toBe("empty");
  });

  it("non-slash prose → non_slash (freeform)", () => {
    const r = parseSlashCommand("I want a Tucson in Irvine", SKILLS);
    expect(r.kind).toBe("non_slash");
    if (r.kind === "non_slash") expect(r.text).toContain("Tucson");
  });

  it("partial skill → typing with candidates (≤8)", () => {
    const r = parseSlashCommand("/search", SKILLS);
    expect(r.kind).toBe("typing");
    if (r.kind === "typing") expect(r.candidates).toContain("search_profile_intake");
  });

  it("exact known skill (with trailing space) → ready", () => {
    const r = parseSlashCommand("/search_profile_intake ", SKILLS);
    expect(r.kind).toBe("ready");
    if (r.kind === "ready") expect(r.skill).toBe("search_profile_intake");
  });

  it("unknown skill → unknown_skill", () => {
    const r = parseSlashCommand("/nope ", SKILLS);
    expect(r.kind).toBe("unknown_skill");
  });

  it("key=value args + trailing prose → ready with args + note", () => {
    const r = parseSlashCommand("/search_profile_intake make=Hyundai near Irvine", SKILLS);
    expect(r.kind).toBe("ready");
    if (r.kind === "ready") {
      expect(r.args).toEqual({ make: "Hyundai" });
      expect(r.note).toBe("near Irvine");
    }
  });
});
