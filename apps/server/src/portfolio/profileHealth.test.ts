import { describe, it, expect } from "vitest";

import { StubProfileHealthProvider, type ProfileHealth } from "./profileHealth.js";

function byId(list: ProfileHealth[]): Record<string, ProfileHealth> {
  return Object.fromEntries(list.map((h) => [h.profileId, h]));
}

const NONE: ReadonlySet<string> = new Set();

describe("StubProfileHealthProvider", () => {
  it("classifies a lock-blocked profile as NON-HOT (warm), and others as hot", () => {
    const provider = new StubProfileHealthProvider(
      () => ["A", "B", "C"],
      () => new Set(["B"]),
    );
    const out = byId(provider.snapshot(NONE));
    expect(out["A"]?.health).toBe("hot");
    expect(out["C"]?.health).toBe("hot");
    expect(out["B"]?.health).toBe("warm"); // blocked on another profile's dealer lock -> non-hot
    expect(out["B"]?.reasons).toContain("lock_blocked");
  });

  it("enumerates the active set + lock-blocked source fresh on each snapshot (no caching)", () => {
    let ids = ["A"];
    const provider = new StubProfileHealthProvider(() => ids);
    expect(provider.snapshot(NONE)).toHaveLength(1);
    ids = ["A", "B"];
    expect(provider.snapshot(NONE)).toHaveLength(2);
  });

  it("with no lock-blocked source (the production default) every active profile is hot", () => {
    const provider = new StubProfileHealthProvider(() => ["A", "B"]);
    const out = byId(provider.snapshot(NONE));
    expect(out["A"]?.health).toBe("hot");
    expect(out["B"]?.health).toBe("hot");
  });

  it("notes a live run in the reasons without changing hotness", () => {
    const provider = new StubProfileHealthProvider(() => ["A"]);
    const out = byId(provider.snapshot(new Set(["A"])));
    expect(out["A"]?.health).toBe("hot");
    expect(out["A"]?.reasons).toContain("live_run");
  });
});
