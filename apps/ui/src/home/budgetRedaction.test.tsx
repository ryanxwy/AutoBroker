// @vitest-environment happy-dom
/**
 * budgetRedaction.test — budget_max NEVER appears on a summary/preview surface
 * (budget red-line: budget_max is internal-only, never dealer-facing — see
 * CLAUDE.md). The SnapshotCard + WhatHappensNext consume the dealer-SAFE
 * ProfileSnapshot, which has no budget accessor, so even a profile row carrying
 * budget_max cannot leak it into rendered summary text.
 */

import { describe, expect, it } from "vitest";

import { SnapshotCard } from "./SnapshotCard.js";
import { WhatHappensNext } from "./WhatHappensNext.js";
import { toSnapshot, SUMMARY_EXCLUDED_KEYS } from "./profileView.js";
import type { ProfileRow } from "../api/wire.js";
import { render } from "../test/render.js";

// A row WITH a budget value the user typed — it must never reach a summary.
const ROW_WITH_BUDGET: ProfileRow = {
  search_profile_id: "p1",
  year: 2026,
  make: "Hyundai",
  model: "Tucson Hybrid",
  location_query: "Irvine, CA 92614",
  dealer_count: 3,
  thread_count: 2,
  best_otd: 38990,
  budget_max: 42000, // INTERNAL_ONLY — must NOT render.
};

describe("budget redaction — summary surfaces", () => {
  it("SUMMARY_EXCLUDED_KEYS lists budget_max", () => {
    expect(SUMMARY_EXCLUDED_KEYS).toContain("budget_max");
  });

  it("the snapshot projection drops budget entirely", () => {
    const snap = toSnapshot(ROW_WITH_BUDGET) as unknown as Record<string, unknown>;
    expect(snap["budget_max"]).toBeUndefined();
    expect(JSON.stringify(snap)).not.toContain("42000");
  });

  it("SnapshotCard renders no budget value (the 42000 never appears)", () => {
    const r = render(<SnapshotCard snapshot={toSnapshot(ROW_WITH_BUDGET)} />);
    expect(r.get("snapshot-card").textContent).not.toContain("42000");
    expect(r.get("snapshot-card").textContent).not.toContain("42,000");
    // the dealer-safe values DO render.
    expect(r.get("snapshot-vehicle").textContent).toContain("Tucson Hybrid");
    r.unmount();
  });

  it("WhatHappensNext renders no budget value", () => {
    const r = render(<WhatHappensNext snapshot={toSnapshot(ROW_WITH_BUDGET)} />);
    expect(r.get("what-next").textContent).not.toContain("42000");
    expect(r.get("what-next").textContent).not.toContain("42,000");
    r.unmount();
  });
});
