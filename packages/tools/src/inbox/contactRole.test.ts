import { describe, expect, it } from "vitest";
import { parseContactRole } from "./contactRole.js";

describe("parseContactRole", () => {
  it("returns null for null/empty input", () => {
    expect(parseContactRole(null)).toBeNull();
    expect(parseContactRole("")).toBeNull();
    expect(parseContactRole("   \n  \n")).toBeNull();
  });

  it("matches each canonical role phrase (case-insensitive)", () => {
    const cases: Array<[string, string]> = [
      ["internet sales manager", "Internet Sales Manager"],
      ["Sales Consultant", "Sales Consultant"],
      ["SALES MANAGER", "Sales Manager"],
      ["General Sales Manager", "General Sales Manager"],
      ["Fleet Manager", "Fleet Manager"],
      ["Finance Manager", "Finance Manager"],
      ["Internet Director", "Internet Director"],
      ["Sales Associate", "Sales Associate"],
      ["Product Specialist", "Product Specialist"],
    ];
    for (const [input, expected] of cases) {
      expect(parseContactRole(input)).toBe(expected);
    }
  });

  it("matches Business Development and BDC to one canonical role", () => {
    expect(parseContactRole("Business Development")).toBe(
      "Business Development / BDC",
    );
    expect(parseContactRole("BDC Representative")).toBe(
      "Business Development / BDC",
    );
  });

  it("prefers the most-specific phrase over its substring", () => {
    expect(parseContactRole("Internet Sales Manager")).toBe(
      "Internet Sales Manager",
    );
    expect(parseContactRole("General Sales Manager")).toBe(
      "General Sales Manager",
    );
  });

  it("returns null for unknown roles / no role text", () => {
    expect(parseContactRole("Thanks for reaching out!")).toBeNull();
    expect(parseContactRole("Owner")).toBeNull();
    expect(parseContactRole("Manager")).toBeNull();
  });

  it("requires a word boundary (no substring false-positives)", () => {
    expect(parseContactRole("supersalesmanagerial")).toBeNull();
    expect(parseContactRole("ABCDClub")).toBeNull();
  });

  it("finds the role within a multi-line signature, scanning the tail", () => {
    const body = [
      "Hi there, attached is the out-the-door quote you requested.",
      "Let me know if you have any questions.",
      "",
      "Best regards,",
      "Jane Doe",
      "Internet Sales Manager",
      "Sunshine Toyota",
      "(555) 123-4567",
    ].join("\n");
    expect(parseContactRole(body)).toBe("Internet Sales Manager");
  });

  it("ignores a role phrase that sits above the last ~10 non-empty lines", () => {
    const filler = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    const body = ["Sales Manager", ...filler].join("\n");
    expect(parseContactRole(body)).toBeNull();
  });
});
