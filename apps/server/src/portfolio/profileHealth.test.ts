import { describe, it, expect } from "vitest";

import { StubProfileHealthProvider, type ProfileHealth } from "./profileHealth.js";

function byId(list: ProfileHealth[]): Record<string, ProfileHealth> {
  return Object.fromEntries(list.map((h) => [h.profileId, h]));
}

describe("StubProfileHealthProvider", () => {
  it("classifies a lock-blocked profile as NON-HOT (warm), and others as hot", () => {
    const provider = new StubProfileHealthProvider(() => ["A", "B", "C"]);
    const out = byId(
      provider.snapshot({
        lockBlockedProfileIds: new Set(["B"]),
        liveRunProfileIds: new Set(),
      }),
    );
    expect(out["A"]?.health).toBe("hot");
    expect(out["C"]?.health).toBe("hot");
    expect(out["B"]?.health).toBe("warm"); // blocked on another profile's dealer lock -> non-hot
    expect(out["B"]?.reasons).toContain("lock_blocked");
  });

  it("enumerates the active set fresh on each snapshot (no caching)", () => {
    let ids = ["A"];
    const provider = new StubProfileHealthProvider(() => ids);
    expect(provider.snapshot({ lockBlockedProfileIds: new Set(), liveRunProfileIds: new Set() })).toHaveLength(1);
    ids = ["A", "B"];
    expect(provider.snapshot({ lockBlockedProfileIds: new Set(), liveRunProfileIds: new Set() })).toHaveLength(2);
  });

  it("notes a live run in the reasons without changing hotness", () => {
    const provider = new StubProfileHealthProvider(() => ["A"]);
    const out = byId(
      provider.snapshot({ lockBlockedProfileIds: new Set(), liveRunProfileIds: new Set(["A"]) }),
    );
    expect(out["A"]?.health).toBe("hot");
    expect(out["A"]?.reasons).toContain("live_run");
  });
});
