// @vitest-environment happy-dom
/**
 * drafts.test — the intake draft store. Covers the three
 * load-bearing disciplines: PII + raw-text strip before persist, 24h TTL expiry,
 * and runId-keyed save/restore survival.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearDraft,
  DRAFT_TTL_MS,
  INTAKE_PII_FIELDS,
  loadDraft,
  saveDraft,
  stripForPersist,
} from "./drafts.js";

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("drafts — PII + raw-text strip", () => {
  it("strips every PII field and raw freeform text before persist", () => {
    const safe = stripForPersist({
      make: "Hyundai",
      follow_up_email: "me@example.com",
      follow_up_phone: "+15551234567",
      trade_in_description: "2018 Civic with a dent",
      budget_max: 40000,
      __rawText: "I want a Tucson in Irvine",
      freeform_text: "raw",
    });
    // PII keys gone.
    for (const k of INTAKE_PII_FIELDS) expect(safe[k]).toBeUndefined();
    expect(safe["__rawText"]).toBeUndefined();
    expect(safe["freeform_text"]).toBeUndefined();
    // Non-PII survives (budget_max is internal-only but not PII — local-only ok).
    expect(safe["make"]).toBe("Hyundai");
    expect(safe["budget_max"]).toBe(40000);
  });

  it("the persisted snapshot never contains a PII value", () => {
    saveDraft("run-1", { make: "Hyundai", follow_up_email: "me@example.com" });
    const raw = localStorage.getItem("autobroker:draft:run-1")!;
    expect(raw).not.toContain("me@example.com");
    expect(raw).toContain("Hyundai");
  });
});

describe("drafts — save / restore keyed by runId", () => {
  it("restores a draft saved under the same runId (survives a refresh)", () => {
    saveDraft("run-7", { make: "Toyota", model: "RAV4", year: 2026 });
    const got = loadDraft("run-7");
    expect(got).not.toBeNull();
    expect(got!.values).toMatchObject({ make: "Toyota", model: "RAV4", year: 2026 });
  });

  it("a different runId does not see another run's draft", () => {
    saveDraft("run-a", { make: "Toyota" });
    expect(loadDraft("run-b")).toBeNull();
  });

  it("clearDraft removes the snapshot", () => {
    saveDraft("run-x", { make: "Toyota" });
    clearDraft("run-x");
    expect(loadDraft("run-x")).toBeNull();
  });
});

describe("drafts — 24h TTL expiry", () => {
  it("treats a draft older than the TTL as absent and clears it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T00:00:00Z"));
    saveDraft("run-ttl", { make: "Honda" });
    // Advance just past the TTL.
    vi.setSystemTime(new Date(Date.now() + DRAFT_TTL_MS + 1000));
    expect(loadDraft("run-ttl")).toBeNull();
    // proactively cleared.
    expect(localStorage.getItem("autobroker:draft:run-ttl")).toBeNull();
  });

  it("keeps a draft within the TTL window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T00:00:00Z"));
    saveDraft("run-fresh", { make: "Honda" });
    vi.setSystemTime(new Date(Date.now() + DRAFT_TTL_MS - 60_000));
    expect(loadDraft("run-fresh")).not.toBeNull();
  });
});
