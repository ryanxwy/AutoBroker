import { describe, it, expect } from "vitest";

import { InMemoryActivationRegistry, ActivationConflictError } from "./activationRegistry.js";

describe("InMemoryActivationRegistry — ProfileId <-> live runId (key=1)", () => {
  it("maps a profile to its live run in both directions", () => {
    const reg = new InMemoryActivationRegistry();
    reg.register("profile-A", "run-1");
    expect(reg.liveRunFor("profile-A")).toBe("run-1");
    expect(reg.profileForRun("run-1")).toBe("profile-A");
    expect([...reg.liveProfileIds()]).toEqual(["profile-A"]);
  });

  it("enforces per-profile concurrency = 1: a second different run for a live profile is rejected", () => {
    const reg = new InMemoryActivationRegistry();
    reg.register("profile-A", "run-1");
    expect(() => reg.register("profile-A", "run-2")).toThrow(ActivationConflictError);
  });

  it("re-registering the SAME run for a profile is idempotent (crash-recovery re-attach)", () => {
    const reg = new InMemoryActivationRegistry();
    reg.register("profile-A", "run-1");
    expect(() => reg.register("profile-A", "run-1")).not.toThrow();
    expect(reg.liveRunFor("profile-A")).toBe("run-1");
  });

  it("releaseRun clears both directions and frees the profile for a new run", () => {
    const reg = new InMemoryActivationRegistry();
    reg.register("profile-A", "run-1");
    reg.releaseRun("run-1");
    expect(reg.liveRunFor("profile-A")).toBeUndefined();
    expect(reg.profileForRun("run-1")).toBeUndefined();
    // freed: a fresh run can now claim the profile.
    reg.register("profile-A", "run-2");
    expect(reg.liveRunFor("profile-A")).toBe("run-2");
  });

  it("releaseRun for an unknown runId is a no-op", () => {
    const reg = new InMemoryActivationRegistry();
    expect(() => reg.releaseRun("nope")).not.toThrow();
  });
});
